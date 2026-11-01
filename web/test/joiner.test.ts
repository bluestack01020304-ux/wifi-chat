import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "../../server/src/protocol";
import { DIAL_TIMEOUT_MS, Joiner, type View } from "../src/joiner";
import { MERGE_TIMEOUT_MS } from "../src/merge";
import { type P, snap } from "./snap";

/** A dial double: each call gets a promise the test settles by host id. A successful dial links the peer, as the real dialer does. */
function harness() {
  const sent: ClientMessage[] = [];
  const linked = new Set<string>();
  const calls: { hostId: string; signal: AbortSignal; resolve: () => void; reject: (e: Error) => void }[] = [];
  const dial = vi.fn((hostId: string, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => calls.push({ hostId, signal, resolve, reject: (e) => reject(e) })),
  );
  const j = new Joiner({ send: (m) => sent.push(m), dial, device: "mobile", linked: () => linked });
  const settle = async (hostId: string, ok: boolean) => {
    const c = [...calls].reverse().find((c) => c.hostId === hostId)!;
    if (ok) linked.add(hostId);
    if (ok) c.resolve();
    else c.reject(new Error("nope"));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { j, sent, calls, dial, settle, linked };
}

const h1: P = { id: "h1", status: "host", group: "g1" };
const h2: P = { id: "h2", status: "host", group: "g2" };
const meJoining: P = { id: "me", status: "joining" };
const meUnattached: P = { id: "me", status: "unattached" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("host", () => {
  it("host on welcome, alone in room", () => {
    const { j, sent } = harness();
    j.onWelcome("me", snap({ id: "me", status: "host", group: "g9" }));
    expect(j.view).toEqual({ kind: "host", groupId: "g9", members: [], aloneInRoom: true, term: 1 });
    expect(sent).toEqual([]);
  });

  it("host with members is not alone", () => {
    const { j } = harness();
    j.onWelcome("me", snap({ id: "me", status: "host", group: "g9" }, { id: "x", status: "member", group: "g9" }));
    expect(j.view).toEqual({ kind: "host", groupId: "g9", members: ["x"], aloneInRoom: false, term: 1 });
  });
});

describe("joining", () => {
  it("dials all hosts at once", () => {
    const { j, dial } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["h1", "h2"]);
    expect(j.view).toEqual({ kind: "connecting" });
  });

  it("dials hosts and unattached", () => {
    const { j, dial } = harness();
    j.onWelcome("me", snap(h1, { id: "u", status: "unattached" }, meJoining));
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["h1", "u"]);
  });

  it("waits for every dial before deciding", async () => {
    const { j, sent, calls, settle } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    await settle("h1", true);
    expect(sent).toEqual([]);
    await settle("h2", true);
    expect(sent[0]).toEqual({ t: "merge-start", groups: ["g1", "g2"], unattached: [] });
    expect(calls.some((c) => c.signal.aborted)).toBe(false);
  });

  it("single reachable host joins", async () => {
    const { j, sent, calls, settle } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    await settle("h2", false);
    await settle("h1", true);
    expect(sent).toEqual([{ t: "joined", groupId: "g1" }]);
    expect(calls.find((c) => c.hostId === "h1")!.signal.aborted).toBe(false);
  });

  it("timeout decides with what was reached", async () => {
    const { j, sent, calls, settle } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    await settle("h1", true);
    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS);
    expect(sent).toEqual([{ t: "joined", groupId: "g1" }]);
    expect(calls.find((c) => c.hostId === "h2")!.signal.aborted).toBe(true);
    expect(calls.find((c) => c.hostId === "h1")!.signal.aborted).toBe(false);
  });

  it("mobile joins desktop host instead of merging", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, { ...h2, device: "desktop" }, meJoining));
    await settle("h1", true);
    await settle("h2", true);
    expect(sent).toEqual([{ t: "joined", groupId: "g2" }]);
  });

  it("all fail means unattached", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    await settle("h1", false);
    expect(sent).toEqual([]);
    await settle("h2", false);
    expect(sent).toEqual([{ t: "unattached" }]);
    expect(j.view).toEqual({ kind: "failed" });
  });

  it("timeout counts as failure and aborts", async () => {
    const { j, sent, calls } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS);
    expect(sent).toEqual([{ t: "unattached" }]);
    expect(calls[0].signal.aborted).toBe(true);
  });

  it("late answer after abort is ignored", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS);
    await settle("h1", true);
    expect(sent).toEqual([{ t: "unattached" }]);
  });

  it("room update during dial does not redial", () => {
    const { j, dial } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    j.onRoom(snap(h1, h2, meJoining));
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it("waits for member after joined, redials if that group vanishes", async () => {
    const { j, dial, settle } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    await settle("h1", false);
    await settle("h2", true);
    j.onRoom(snap(h1, h2, meJoining));
    expect(dial).toHaveBeenCalledTimes(2);
    j.onRoom(snap(h1, meJoining));
    expect(dial).toHaveBeenCalledTimes(3);
    expect(dial.mock.calls[2][0]).toBe("h1");
  });

  it("member view after server confirms", async () => {
    const { j, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await settle("h1", true);
    j.onRoom(snap(h1, { id: "me", status: "member", group: "g1" }));
    expect(j.view).toEqual({ kind: "member", groupId: "g1", hostId: "h1", term: 1 });
  });
});

describe("bridge merge", () => {
  const x: P = { id: "x", status: "member", group: "g1" };
  const u: P = { id: "u", status: "unattached" };

  it("merge commits when every member links", async () => {
    const { j, sent, settle, linked } = harness();
    j.onWelcome("me", snap(h1, x, h2, meJoining));
    await settle("h1", true);
    await settle("h2", true);
    expect(sent).toEqual([{ t: "merge-start", groups: ["g1", "g2"], unattached: [] }]);
    expect(j.view).toEqual({ kind: "connecting" });
    linked.add("x");
    j.onLinksChanged();
    expect(sent[1]).toEqual({ t: "merge-commit", groups: ["g1", "g2"], peers: ["h1", "x", "h2"] });
  });

  it("merge with no members to wait for commits at once", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    await settle("h1", true);
    await settle("h2", true);
    expect(sent[1]).toEqual({ t: "merge-commit", groups: ["g1", "g2"], peers: ["h1", "h2"] });
  });

  it("merge timeout falls back to joining when only one group is whole", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, x, h2, meJoining));
    await settle("h1", true);
    await settle("h2", true);
    await vi.advanceTimersByTimeAsync(MERGE_TIMEOUT_MS);
    expect(sent.slice(1)).toEqual([{ t: "joined", groupId: "g1" }]);
  });

  it("merge timeout commits the unattached it pulled", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, x, u, meJoining));
    await settle("h1", true);
    await settle("u", true);
    expect(sent).toEqual([{ t: "merge-start", groups: ["g1"], unattached: ["u"] }]);
    await vi.advanceTimersByTimeAsync(MERGE_TIMEOUT_MS);
    expect(sent.slice(1)).toEqual([{ t: "merge-commit", groups: [], peers: ["u"] }]);
  });

  it("rejected commit redials from the current snapshot", async () => {
    const { j, sent, dial, settle } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    await settle("h1", true);
    await settle("h2", true);
    expect(sent.at(-1)).toMatchObject({ t: "merge-commit" });
    dial.mockClear();
    const n2: P = { id: "n2", status: "host", group: "g7" };
    j.onRoom(snap({ ...h1, status: "member", group: "g7" }, { ...h2, status: "member", group: "g7" }, n2, meJoining));
    expect(dial).not.toHaveBeenCalled();
    j.onError("bad-state");
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["n2"]);
  });

  it("another bridge committing during my merge phase makes me redial", async () => {
    const { j, sent, dial, settle } = harness();
    j.onWelcome("me", snap(h1, x, h2, meJoining));
    await settle("h1", true);
    await settle("h2", true);
    expect(sent).toEqual([{ t: "merge-start", groups: ["g1", "g2"], unattached: [] }]);
    dial.mockClear();
    const n: P = { id: "n", status: "host", group: "g9" };
    j.onRoom(snap(n, { ...h1, status: "member", group: "g9" }, { ...x, group: "g9" }, h2, meJoining));
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["n", "h2"]);
    expect(sent).toEqual([{ t: "merge-start", groups: ["g1", "g2"], unattached: [] }]);
    expect(j.view).toEqual({ kind: "connecting" });
  });

  it("a pulled unattached peer settling elsewhere makes me redial", async () => {
    const { j, sent, dial, settle } = harness();
    j.onWelcome("me", snap(h1, x, u, meJoining));
    await settle("h1", true);
    await settle("u", true);
    dial.mockClear();
    j.onRoom(snap(h1, x, { ...u, status: "member", group: "g1" }, meJoining));
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["h1"]);
    expect(sent).toEqual([{ t: "merge-start", groups: ["g1"], unattached: ["u"] }]);
  });

  it("becoming host ends the merge", async () => {
    const { j, settle } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    await settle("h1", true);
    await settle("h2", true);
    j.onRoom(snap({ id: "me", status: "host", group: "g8" }, { ...h1, status: "member", group: "g8" }, { ...h2, status: "member", group: "g8" }));
    expect(j.view).toEqual({ kind: "host", groupId: "g8", members: ["h1", "h2"], aloneInRoom: false, term: 1 });
  });

  it("merge request makes a member dial the bridge", async () => {
    const { j, dial, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await settle("h1", true);
    j.onRoom(snap(h1, { id: "me", status: "member", group: "g1" }));
    dial.mockClear();
    j.onMergeRequest("n");
    j.onMergeRequest("n");
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["n"]);
    await settle("n", false);
    j.onMergeRequest("n");
    expect(dial).toHaveBeenCalledTimes(2);
  });

  it("merge request is ignored unless I am a member", () => {
    const { j, dial } = harness();
    j.onWelcome("me", snap({ id: "me", status: "host", group: "g9" }));
    j.onMergeRequest("n");
    expect(dial).not.toHaveBeenCalled();
  });
});

describe("unattached", () => {
  async function failedWith(...hosts: P[]) {
    const t = harness();
    t.j.onWelcome("me", snap(...hosts, meJoining));
    for (const h of hosts) await t.settle(h.id, false);
    t.dial.mockClear();
    return t;
  }

  it("retries all hosts when a new host appears", async () => {
    const { j, dial } = await failedWith(h1);
    const h3: P = { id: "h3", status: "host", group: "g3" };
    j.onRoom(snap(h1, h3, meUnattached));
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["h1", "h3"]);
  });

  it("does not retry the same hosts", async () => {
    const { j, dial } = await failedWith(h1);
    j.onRoom(snap(h1, meUnattached));
    expect(dial).not.toHaveBeenCalled();
  });

  it("retries when a new unattached peer appears", async () => {
    const { j, dial } = await failedWith(h1);
    j.onRoom(snap(h1, meUnattached, { id: "v", status: "unattached" }));
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["h1", "v"]);
  });

  it("a failed retry sends nothing more", async () => {
    const { j, sent, settle } = await failedWith(h1);
    j.onRoom(snap(h1, h2, meUnattached));
    await settle("h1", false);
    await settle("h2", false);
    expect(sent).toEqual([{ t: "unattached" }]);
    expect(j.view).toEqual({ kind: "failed" });
  });

  it("member whose host left retries hosts it tried before", async () => {
    const { j, dial, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await settle("h1", true);
    j.onRoom(snap(h1, { id: "me", status: "member", group: "g1" }));
    j.onRoom(snap(h2, meUnattached));
    expect(dial.mock.calls.at(-1)![0]).toBe("h2");
  });

  it("with no groups, the earliest unattached peer starts alone", () => {
    const { j, sent } = harness();
    j.onWelcome("me", snap(meUnattached, { id: "z", status: "unattached" }));
    expect(sent).toEqual([{ t: "start-alone" }]);
    j.onRoom(snap(meUnattached, { id: "z", status: "unattached" }));
    expect(sent).toEqual([{ t: "start-alone" }]);
  });

  it("with no groups, a later unattached peer waits", () => {
    const { j, sent } = harness();
    j.onWelcome("me", snap({ id: "z", status: "unattached" }, meUnattached));
    expect(sent).toEqual([]);
  });
});

describe("startAlone and events", () => {
  it("startAlone works only from failed", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    j.startAlone();
    expect(sent).toEqual([]);
    await settle("h1", false);
    j.startAlone();
    expect(sent).toEqual([{ t: "unattached" }, { t: "start-alone" }]);
  });

  it("onChange fires on view change", () => {
    const { j } = harness();
    const views: View[] = [];
    j.onChange((v) => views.push(v));
    j.onWelcome("me", snap(h1, meJoining));
    j.onRoom(snap(h1, meJoining));
    expect(views).toEqual([{ kind: "connecting" }]);
  });
});

describe("succession", () => {
  const meMember = (group = "g1"): P => ({ id: "me", status: "member", group });

  it("views carry the term", () => {
    const { j } = harness();
    j.onWelcome("me", snap({ id: "me", status: "host", group: "g9", term: 4 }));
    expect(j.view).toMatchObject({ kind: "host", term: 4 });
  });

  it("member confirms when linked to its host", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await settle("h1", true);
    sent.length = 0;
    j.onRoom(snap(h1, meMember()));
    expect(sent).toEqual([{ t: "confirm", groupId: "g1", term: 1 }]);
  });

  it("confirm is sent once per term", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await settle("h1", true);
    sent.length = 0;
    j.onRoom(snap(h1, meMember()));
    j.onRoom(snap(h1, meMember()));
    j.onLinksChanged();
    expect(sent).toHaveLength(1);
  });

  it("member dials a new host after succession and confirms", async () => {
    const { j, sent, dial, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await settle("h1", true);
    j.onRoom(snap(h1, meMember()));
    sent.length = 0;
    dial.mockClear();
    // h1 is gone; h2 now hosts g1 with term 2.
    j.onRoom(snap({ id: "h2", status: "host", group: "g1", term: 2 }, meMember()));
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["h2"]);
    expect(sent).toEqual([]);
    await settle("h2", true);
    expect(sent).toEqual([{ t: "confirm", groupId: "g1", term: 2 }]);
    expect(j.view).toMatchObject({ kind: "member", hostId: "h2", term: 2 });
  });

  it("a newer term aborts the older confirm dial", async () => {
    const { j, sent, calls, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await settle("h1", true);
    j.onRoom(snap(h1, meMember()));
    sent.length = 0;
    j.onRoom(snap({ id: "h2", status: "host", group: "g1", term: 2 }, meMember()));
    j.onRoom(snap({ id: "h3", status: "host", group: "g1", term: 3 }, meMember()));
    expect(calls.find((c) => c.hostId === "h2")!.signal.aborted).toBe(true);
    await settle("h3", true);
    expect(sent).toEqual([{ t: "confirm", groupId: "g1", term: 3 }]);
  });

  it("a failed confirm dial sends nothing and leaves the decision to the server", async () => {
    const { j, sent, settle } = harness();
    j.onWelcome("me", snap(h1, meJoining));
    await settle("h1", true);
    j.onRoom(snap(h1, meMember()));
    sent.length = 0;
    j.onRoom(snap({ id: "h2", status: "host", group: "g1", term: 2 }, meMember()));
    await settle("h2", false);
    expect(sent).toEqual([]);
  });

  it("demotion calls onDemoted before rejoining", () => {
    const sent: ClientMessage[] = [];
    const order: string[] = [];
    const j = new Joiner({
      send: (m) => sent.push(m),
      dial: () => {
        order.push("dial");
        return new Promise(() => {});
      },
      device: "mobile",
      linked: () => new Set(),
      onDemoted: () => order.push("demoted"),
    });
    j.onWelcome("me", snap({ id: "me", status: "host", group: "g9" }, { id: "x", status: "member", group: "g9" }));
    j.onRoom(snap({ id: "x", status: "host", group: "g9", term: 2 }, meJoining));
    expect(order).toEqual(["demoted", "dial"]);
  });

  it("a merged host becoming a member is not a demotion", () => {
    const onDemoted = vi.fn();
    const j = new Joiner({ send: () => {}, dial: () => new Promise(() => {}), device: "mobile", linked: () => new Set(["n"]), onDemoted });
    j.onWelcome("me", snap({ id: "me", status: "host", group: "g9" }));
    j.onRoom(snap({ id: "n", status: "host", group: "g7", term: 2 }, { id: "me", status: "member", group: "g7" }));
    expect(onDemoted).not.toHaveBeenCalled();
  });
});
