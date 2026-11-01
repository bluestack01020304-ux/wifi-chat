import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { History } from "../../src/chat/history";
import { AWAY_MS, HostHub, SAY_LIMIT, SAY_WINDOW_MS } from "../../src/chat/hostHub";

const j = (v: unknown) => JSON.stringify(v);

function setup() {
  const history = new History();
  const out: [string, { t: string; [k: string]: unknown }][] = [];
  const hub = new HostHub({ myId: "h", myNick: "호스트 고양이", history, send: (to, frame) => out.push([to, JSON.parse(frame)]), now: () => Date.now() });
  const join = (id: string, nick = "닉" + id) => {
    hub.attach(id);
    hub.onFrame(id, j({ t: "hello", nick }));
  };
  const said = (t: string) => out.filter(([, f]) => f.t === t);
  return { hub, history, out, join, said };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe("HostHub", () => {
  it("hello gets history and everyone gets the roster", () => {
    const { hub, history, out, join } = setup();
    history.add({ id: "old", from: "h", nick: "n", text: "earlier", at: 1 });
    join("a");
    expect(out[0]).toEqual(["a", { t: "history", msgs: history.list() }]);
    out.length = 0;
    join("b");
    expect(out.map(([to, f]) => `${to}:${f.t}`).sort()).toEqual(["a:roster", "b:history", "b:roster"]);
    expect(hub.roster()).toEqual([
      { peerId: "h", nick: "호스트 고양이", host: true, away: false },
      { peerId: "a", nick: "닉a", host: false, away: false },
      { peerId: "b", nick: "닉b", host: false, away: false },
    ]);
  });

  it("say is stamped by the host and relayed to all", () => {
    const { hub, history, join, said } = setup();
    join("a");
    join("b");
    hub.onFrame("a", j({ t: "say", id: "m1", text: "hi", from: "evil", nick: "가짜" }));
    const msg = { id: "m1", from: "a", nick: "닉a", text: "hi", at: 1000 };
    expect(said("msg")).toEqual([["a", { t: "msg", msg }], ["b", { t: "msg", msg }]]);
    expect(history.list()).toEqual([msg]);
  });

  it("host say reaches every member", () => {
    const { hub, join, said, history } = setup();
    join("a");
    hub.say("밥 다 됐다");
    expect(said("msg")).toHaveLength(1);
    expect(said("msg")[0][1]).toMatchObject({ msg: { from: "h", nick: "호스트 고양이", text: "밥 다 됐다" } });
    expect(history.list()).toHaveLength(1);
  });

  it("frames from unknown links are ignored", () => {
    const { hub, out, history } = setup();
    hub.onFrame("x", j({ t: "hello", nick: "x" }));
    hub.onFrame("x", j({ t: "say", id: "m", text: "hi" }));
    expect(out).toEqual([]);
    expect(history.list()).toEqual([]);
  });

  it("say before hello is ignored", () => {
    const { hub, out, history } = setup();
    hub.attach("a");
    hub.onFrame("a", j({ t: "say", id: "m", text: "hi" }));
    expect(out).toEqual([]);
    expect(history.list()).toEqual([]);
  });

  it("duplicate message id is relayed once", () => {
    const { hub, join, said } = setup();
    join("a");
    hub.onFrame("a", j({ t: "say", id: "m1", text: "hi" }));
    hub.onFrame("a", j({ t: "say", id: "m1", text: "hi again" }));
    expect(said("msg")).toHaveLength(1);
  });

  it("rate limit drops excess per sender", () => {
    const { hub, join, said } = setup();
    join("a");
    join("b");
    // hello and say share one budget per window, so a's hello already used one slot.
    for (let i = 0; i < SAY_LIMIT + 5; i++) hub.onFrame("a", j({ t: "say", id: "a" + i, text: "x" }));
    expect(said("msg").filter(([to]) => to === "b")).toHaveLength(SAY_LIMIT - 1);
    hub.onFrame("b", j({ t: "say", id: "b1", text: "y" }));
    expect(said("msg").filter(([to]) => to === "a")).toHaveLength(SAY_LIMIT);
    vi.advanceTimersByTime(SAY_WINDOW_MS);
    hub.onFrame("a", j({ t: "say", id: "late", text: "z" }));
    // b got a's 19, its own b1, and now a's late message.
    expect(said("msg").filter(([to]) => to === "b")).toHaveLength(SAY_LIMIT + 1);
  });

  it("repeated hello is rate-limited", () => {
    const { hub, join, out } = setup();
    join("a");
    join("b");
    out.length = 0;
    for (let i = 0; i < SAY_LIMIT * 5; i++) hub.onFrame("b", j({ t: "hello", nick: "b" + i }));
    expect(out.filter(([to, f]) => to === "b" && f.t === "history").length).toBeLessThanOrEqual(SAY_LIMIT);
    expect(out.filter(([to, f]) => to === "a" && f.t === "roster").length).toBeLessThanOrEqual(SAY_LIMIT);
  });

  it("a duplicate nickname gets a number", () => {
    const { hub, join, said } = setup();
    join("a", "졸린 거북이");
    join("b", "졸린 거북이");
    join("c", "호스트 고양이");
    join("d", "졸린 거북이");
    expect(hub.roster().map((p) => p.nick)).toEqual(["호스트 고양이", "졸린 거북이", "졸린 거북이 2", "호스트 고양이 2", "졸린 거북이 3"]);
    hub.onFrame("b", j({ t: "say", id: "m", text: "hi" }));
    expect(said("msg")[0][1]).toMatchObject({ msg: { nick: "졸린 거북이 2" } });
  });

  it("a numbered nickname still fits the length limit", () => {
    const { hub, join } = setup();
    const long = "가".repeat(20);
    join("a", long);
    join("b", long);
    const nick = hub.roster()[2].nick;
    expect(Array.from(nick)).toHaveLength(20);
    expect(nick.endsWith(" 2")).toBe(true);
  });

  it("a member keeps its number when it says hello again", () => {
    const { hub, join } = setup();
    join("a", "졸린 거북이");
    join("b", "졸린 거북이");
    hub.onFrame("b", j({ t: "hello", nick: "졸린 거북이" }));
    expect(hub.roster().map((p) => p.nick)).toEqual(["호스트 고양이", "졸린 거북이", "졸린 거북이 2"]);
  });

  it("detach marks away then removes after 30 s", () => {
    const { hub, join, said } = setup();
    join("a");
    join("b");
    const rosters = () => said("roster").filter(([to]) => to === "a").length;
    const before = rosters();
    hub.detach("b");
    expect(hub.roster().find((p) => p.peerId === "b")).toMatchObject({ away: true });
    expect(rosters()).toBe(before + 1);
    vi.advanceTimersByTime(AWAY_MS);
    expect(hub.roster().map((p) => p.peerId)).toEqual(["h", "a"]);
    expect(rosters()).toBe(before + 2);
  });

  it("reattach before 30 s clears away", () => {
    const { hub, join } = setup();
    join("a");
    hub.detach("a");
    vi.advanceTimersByTime(AWAY_MS - 1);
    hub.attach("a");
    vi.advanceTimersByTime(10);
    expect(hub.roster().find((p) => p.peerId === "a")).toMatchObject({ away: false });
  });

  it("an away member gets no messages", () => {
    const { hub, join, said } = setup();
    join("a");
    hub.detach("a");
    hub.say("hi");
    expect(said("msg")).toEqual([]);
  });

  it("close stops timers and keeps history", () => {
    const { hub, join, history, out } = setup();
    join("a");
    hub.say("hi");
    hub.detach("a");
    out.length = 0;
    hub.close();
    vi.advanceTimersByTime(AWAY_MS);
    expect(out).toEqual([]);
    expect(history.list()).toHaveLength(1);
    hub.onFrame("a", j({ t: "say", id: "z", text: "after close" }));
    expect(history.list()).toHaveLength(1);
  });
});
