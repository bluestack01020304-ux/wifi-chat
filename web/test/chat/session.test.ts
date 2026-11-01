import { describe, expect, it } from "vitest";
import { History } from "../../src/chat/history";
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

const host = (members: string[]) => ({ kind: "host" as const, groupId: "g", members, aloneInRoom: false });
const member = (hostId: string) => ({ kind: "member" as const, groupId: "g", hostId });

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
