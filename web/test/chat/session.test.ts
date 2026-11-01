import { describe, expect, it, vi } from "vitest";
import { History } from "../../src/chat/history";
import { HELLO_RETRY_MS } from "../../src/chat/memberChat";
import { type ChannelLike, ChatSession } from "../../src/chat/session";

class FakeChannel implements ChannelLike {
  readyState = "open";
  sent: { t: string; [k: string]: unknown }[] = [];
  private handlers: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  addEventListener(type: "message" | "close", cb: (e: { data?: unknown }) => void) {
    (this.handlers[type] ??= []).push(cb);
  }
  emit(type: "message" | "close", data?: unknown) {
    if (type === "close") this.readyState = "closed";
    for (const cb of this.handlers[type] ?? []) cb({ data });
  }
  say(frame: unknown) {
    this.emit("message", JSON.stringify(frame));
  }
}

function setup() {
  const channels = new Map<string, FakeChannel>();
  const history = new History();
  let n = 0;
  const s = new ChatSession({
    myNick: "나",
    mode: "family",
    history,
    channel: (id) => channels.get(id),
    myId: () => "me",
    now: () => 1000,
    newId: () => "id" + ++n,
  });
  const ch = (id: string) => {
    const c = new FakeChannel();
    channels.set(id, c);
    return c;
  };
  return { s, history, channels, ch };
}

const host = (members: string[]) => ({ kind: "host" as const, groupId: "g", members, aloneInRoom: false, term: 1 });
const member = (hostId: string) => ({ kind: "member" as const, groupId: "g", hostId, term: 1 });

describe("ChatSession", () => {
  it("host attaches member channels and relays", () => {
    const { s, ch } = setup();
    const a = ch("a");
    s.update(host(["a"]));
    expect(a.sent).toEqual([]);
    a.say({ t: "hello", nick: "에이" });
    expect(a.sent.map((f) => f.t)).toEqual(["history", "roster"]);
    a.say({ t: "say", id: "m1", text: "hi" });
    expect(a.sent.at(-1)).toMatchObject({ t: "msg", msg: { from: "a", text: "hi" } });
    expect(s.roster().map((p) => p.nick)).toEqual(["나", "에이"]);
  });

  it("host does not attach links that are not my members", () => {
    const { s, ch, history } = setup();
    const x = ch("x");
    s.update(host([]));
    x.say({ t: "hello", nick: "x" });
    x.say({ t: "say", id: "m", text: "hi" });
    expect(x.sent).toEqual([]);
    expect(history.list()).toEqual([]);
  });

  it("an updated view does not attach a channel twice", () => {
    const { s, ch } = setup();
    const a = ch("a");
    s.update(host(["a"]));
    s.update(host(["a"]));
    a.say({ t: "hello", nick: "에이" });
    expect(a.sent.filter((f) => f.t === "history")).toHaveLength(1);
  });

  it("a closed member channel shows them away", () => {
    const { s, ch } = setup();
    const a = ch("a");
    s.update(host(["a"]));
    a.say({ t: "hello", nick: "에이" });
    a.emit("close");
    expect(s.roster().find((p) => p.peerId === "a")).toMatchObject({ away: true });
  });

  it("member opens hello to its host", () => {
    const { s, ch } = setup();
    const h = ch("h");
    s.update(member("h"));
    expect(h.sent).toEqual([{ t: "hello", nick: "나" }]);
    s.update(member("h"));
    expect(h.sent).toHaveLength(1);
    expect(s.say("안녕")).toBe(true);
    expect(h.sent.at(-1)).toEqual({ t: "say", id: "id1", text: "안녕" });
  });

  it("role change keeps history and swaps roles", () => {
    const { s, ch, history } = setup();
    const a = ch("a");
    s.update(host(["a"]));
    a.say({ t: "hello", nick: "에이" });
    s.say("before merge");
    expect(history.list()).toHaveLength(1);

    const n = ch("n");
    s.update(member("n"));
    expect(n.sent).toEqual([{ t: "hello", nick: "나" }]);
    const before = a.sent.length;
    a.say({ t: "say", id: "late", text: "to old host" });
    expect(a.sent).toHaveLength(before);
    expect(history.list().map((m) => m.text)).toEqual(["before merge"]);
  });

  it("a hello sent before the host attaches is retried until history arrives", () => {
    vi.useFakeTimers();
    try {
      // Member side: its hello goes out before the host listens.
      const m = setup();
      const toHost = m.ch("h");
      m.s.update(member("h"));
      expect(toHost.sent).toEqual([{ t: "hello", nick: "나" }]);
      vi.advanceTimersByTime(HELLO_RETRY_MS);
      expect(toHost.sent).toHaveLength(2);
      toHost.say({ t: "history", msgs: [], term: 1 });
      vi.advanceTimersByTime(HELLO_RETRY_MS * 3);
      expect(toHost.sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("canSend", () => {
    const { s, ch } = setup();
    expect(s.canSend()).toBe(false);
    s.update({ kind: "connecting" });
    expect(s.canSend()).toBe(false);
    s.update(member("h"));
    expect(s.canSend()).toBe(false);
    ch("h");
    s.update(member("h"));
    expect(s.canSend()).toBe(true);
    s.update({ kind: "failed" });
    expect(s.canSend()).toBe(false);
    s.update(host([]));
    expect(s.canSend()).toBe(true);
  });
});

describe("ChatSession term", () => {
  it("a new term for the same host replaces the member role", () => {
    const channels = new Map<string, FakeChannel>();
    const s = new ChatSession({ myNick: "나", mode: "family", history: new History(), channel: (id) => channels.get(id), myId: () => "me", now: () => 1, newId: () => "x" });
    const h = new FakeChannel();
    channels.set("h", h);
    s.update({ kind: "member", groupId: "g", hostId: "h", term: 1 });
    s.update({ kind: "member", groupId: "g", hostId: "h", term: 2 });
    expect(h.sent.filter((f) => f.t === "hello")).toHaveLength(2);
    h.say({ t: "roster", people: [{ peerId: "h", nick: "n", host: true, away: false }], term: 1 });
    expect(s.roster()).toEqual([]);
    h.say({ t: "roster", people: [{ peerId: "h", nick: "n", host: true, away: false }], term: 2 });
    expect(s.roster()).toHaveLength(1);
  });

  it("a host whose term changes stamps the new term", () => {
    const channels = new Map<string, FakeChannel>();
    const s = new ChatSession({ myNick: "나", mode: "family", history: new History(), channel: (id) => channels.get(id), myId: () => "me", now: () => 1, newId: () => "x" });
    const a = new FakeChannel();
    channels.set("a", a);
    s.update({ kind: "host", groupId: "g", members: ["a"], aloneInRoom: false, term: 1 });
    s.update({ kind: "host", groupId: "g", members: ["a"], aloneInRoom: false, term: 2 });
    a.say({ t: "hello", nick: "에이" });
    expect(a.sent.map((f) => f.term)).toEqual([2, 2]);
  });
});

describe("ChatSession naming", () => {
  it("member to host seeds the hub with the last roster", () => {
    const channels = new Map<string, FakeChannel>();
    const s = new ChatSession({ myNick: "나", mode: "meeting", history: new History(), channel: (id) => channels.get(id), myId: () => "me", now: () => 1, newId: () => "x" });
    const h = new FakeChannel();
    channels.set("h", h);
    s.update({ kind: "member", groupId: "g", hostId: "h", term: 1 });
    expect(h.sent[0]).toEqual({ t: "hello", nick: "익명" });
    h.say({
      t: "roster",
      term: 1,
      people: [
        { peerId: "h", nick: "익명 1", host: true, away: false },
        { peerId: "me", nick: "익명 2", host: false, away: false },
        { peerId: "x", nick: "익명 3", host: false, away: false },
      ],
    });
    const x = new FakeChannel();
    channels.set("x", x);
    s.update({ kind: "host", groupId: "g", members: ["x"], aloneInRoom: false, term: 2 });
    x.say({ t: "hello", nick: "익명" });
    expect(s.roster().map((p) => p.nick)).toEqual(["익명 2", "익명 3"]);
  });

  it("setNick reaches the current role", () => {
    const channels = new Map<string, FakeChannel>();
    const s = new ChatSession({ myNick: "나", mode: "family", history: new History(), channel: (id) => channels.get(id), myId: () => "me", now: () => 1, newId: () => "x" });
    s.update({ kind: "host", groupId: "g", members: [], aloneInRoom: true, term: 1 });
    s.setNick("새 이름");
    expect(s.roster()[0].nick).toBe("새 이름");
  });
});
