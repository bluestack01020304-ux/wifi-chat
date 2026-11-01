import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomSnapshot, ServerMessage } from "../src/protocol";
import type { Room } from "../src/roomDO";
import { roomKeyString } from "../src/roomKey";

const sdp = { type: "offer", sdp: "v=0" } as const;

/** Every test uses its own room so Durable Objects never leak between tests. */
let roomSeq = 0;
const freshRoom = () => `t${++roomSeq}-${crypto.randomUUID().slice(0, 8)}`;

function upgrade(query: string, ip: string | null) {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  return SELF.fetch("https://signal.test/ws" + query, { headers });
}

interface Client {
  ws: WebSocket;
  next(): Promise<ServerMessage>;
  /** Resolves with the next message whose `t` matches, skipping others. */
  nextOf<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>>;
  /** Messages received so far and not yet consumed. */
  pending(): ServerMessage[];
  send(v: unknown): void;
}

async function connect(ip: string, query: string): Promise<Client> {
  const res = await upgrade(query, ip);
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const queue: ServerMessage[] = [];
  const waiters: ((m: ServerMessage) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string) as ServerMessage;
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = () =>
    new Promise<ServerMessage>((resolve, reject) => {
      const m = queue.shift();
      if (m) return resolve(m);
      const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), 2000);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  const nextOf = async <T extends ServerMessage["t"]>(t: T) => {
    for (;;) {
      const m = await next();
      if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
    }
  };
  return { ws, next, nextOf, pending: () => [...queue], send: (v) => ws.send(typeof v === "string" ? v : JSON.stringify(v)) };
}

const host = (room: RoomSnapshot) => room.groups[0]?.hostId;
const peerIds = (room: RoomSnapshot) => room.peers.map((p) => p.peerId);
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("http surface", () => {
  it("GET / is ok", async () => {
    const res = await SELF.fetch("https://signal.test/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects bad requests", async () => {
    expect((await upgrade("?mode=meeting", "203.0.113.5")).status).toBe(400);
    expect((await upgrade("", null)).status).toBe(400);
    expect((await upgrade("", "garbage")).status).toBe(400);
    expect((await SELF.fetch("https://signal.test/ws", { headers: { "CF-Connecting-IP": "203.0.113.5" } })).status).toBe(426);
    expect((await SELF.fetch("https://signal.test/other")).status).toBe(404);
  });
});

describe("rooms", () => {
  it("first is host, second sees the group", async () => {
    const room = freshRoom();
    const a = await connect("203.0.113.5", `?room=${room}&device=desktop`);
    const aw = await a.nextOf("welcome");
    expect(host(aw.room)).toBe(aw.peerId);
    expect(aw.room.peers[0]).toMatchObject({ device: "desktop" });

    const b = await connect("203.0.113.5", `?room=${room}`);
    const bw = await b.nextOf("welcome");
    expect(host(bw.room)).toBe(aw.peerId);
    expect(bw.room.peers.find((p) => p.peerId === bw.peerId)).toMatchObject({ status: "joining", device: "mobile" });
    expect(peerIds((await a.nextOf("room")).room)).toEqual([aw.peerId, bw.peerId]);
  });

  it("different network is isolated", async () => {
    const q = `?room=${freshRoom()}`;
    await (await connect("203.0.113.5", q)).nextOf("welcome");
    const cw = await (await connect("198.51.100.7", q)).nextOf("welcome");
    expect(peerIds(cw.room)).toEqual([cw.peerId]);
    expect(host(cw.room)).toBe(cw.peerId);
  });

  it("different room is isolated", async () => {
    await (await connect("203.0.113.5", `?room=${freshRoom()}`)).nextOf("welcome");
    const dw = await (await connect("203.0.113.5", `?room=${freshRoom()}`)).nextOf("welcome");
    expect(peerIds(dw.room)).toEqual([dw.peerId]);
  });

  it("meeting key isolates", async () => {
    const room = freshRoom();
    const k1 = "A".repeat(22);
    const k2 = "B".repeat(22);
    await (await connect("203.0.113.5", `?room=${room}&mode=meeting&key=${k1}`)).nextOf("welcome");
    const w = await (await connect("203.0.113.5", `?room=${room}&mode=meeting&key=${k2}`)).nextOf("welcome");
    expect(peerIds(w.room)).toEqual([w.peerId]);
  });

  it("IPv6 hosts in the same /64 share a room", async () => {
    const q = `?room=${freshRoom()}`;
    const aw = await (await connect("2001:db8:1:2::a", q)).nextOf("welcome");
    const bw = await (await connect("2001:db8:1:2::b", q)).nextOf("welcome");
    expect(peerIds(bw.room)).toEqual([aw.peerId, bw.peerId]);
  });
});

describe("messages", () => {
  async function pair() {
    const q = `?room=${freshRoom()}`;
    const a = await connect("203.0.113.5", q);
    const aw = await a.nextOf("welcome");
    const b = await connect("203.0.113.5", q);
    const bw = await b.nextOf("welcome");
    await a.nextOf("room");
    return { q, a, b, aId: aw.peerId, bId: bw.peerId, groupId: aw.room.groups[0].groupId };
  }

  it("relays signal only to the target", async () => {
    const { q, a, b, aId, bId } = await pair();
    const c = await connect("203.0.113.5", q);
    await c.nextOf("welcome");
    await settle();
    a.send({ t: "signal", to: bId, sdp });
    expect(await b.nextOf("signal")).toEqual({ t: "signal", from: aId, sdp });
    await settle();
    expect(c.pending().filter((m) => m.t === "signal")).toEqual([]);
  });

  it("bad frame gets an error and the connection stays usable", async () => {
    const { a, b, bId } = await pair();
    a.send("nope");
    expect(await a.nextOf("error")).toMatchObject({ code: "bad-json" });
    a.send({ t: "signal", to: bId, sdp });
    expect(await b.nextOf("signal")).toMatchObject({ t: "signal" });
  });

  it("joined, then host leaves", async () => {
    const { a, b, bId, groupId } = await pair();
    b.send({ t: "joined", groupId });
    expect((await a.nextOf("room")).room.groups[0].members).toEqual([bId]);
    await b.nextOf("room");

    a.ws.close(1000, "bye");
    const after = (await b.nextOf("room")).room;
    expect(after.groups).toEqual([]);
    expect(after.peers).toEqual([{ peerId: bId, device: "mobile", status: "unattached", groupId: null }]);
  });

  it("signal to a peer that just closed does not break the room", async () => {
    const { q, a, b, aId, bId } = await pair();
    b.ws.close(1000, "bye");
    a.send({ t: "signal", to: bId, sdp });
    await settle();
    const c = await connect("203.0.113.5", q);
    const cw = await c.nextOf("welcome");
    expect(peerIds(cw.room)).toEqual([aId, cw.peerId]);
  });
});

describe("limits", () => {
  it("caps a room at 32 peers", async () => {
    const q = `?room=${freshRoom()}`;
    const clients: Client[] = [];
    for (let i = 0; i < 32; i++) {
      const c = await connect("203.0.113.5", q);
      await c.nextOf("welcome");
      clients.push(c);
    }
    expect((await upgrade(q, "203.0.113.5")).status).toBe(429);
    for (const c of clients) c.ws.close(1000, "done");
  });
});

describe("dropped sockets", () => {
  it("a dropped host does not come back while its socket lingers", async () => {
    const room = freshRoom();
    const a = await connect("203.0.113.5", `?room=${room}`);
    await a.nextOf("welcome");
    const stub = env.ROOMS.get(
      env.ROOMS.idFromName(roomKeyString("203.0.113.5", { room, mode: "family", key: null, device: "mobile" })),
    );
    const welcome = await runInDurableObject(stub, async (instance: Room, state) => {
      const [hostSocket] = state.getWebSockets();
      await instance.webSocketError(hostSocket);
      // Same event turn: the errored socket is still CLOSING and listed by getWebSockets().
      const res = await instance.fetch(new Request(`https://x/ws?room=${room}`, { headers: { Upgrade: "websocket" } }));
      const ws = res.webSocket!;
      const first = new Promise<ServerMessage>((r) => ws.addEventListener("message", (e) => r(JSON.parse(e.data as string))));
      ws.accept();
      return first;
    });
    expect(welcome.t).toBe("welcome");
    if (welcome.t !== "welcome") return;
    expect(peerIds(welcome.room)).toEqual([welcome.peerId]);
    expect(host(welcome.room)).toBe(welcome.peerId);
  });
});
