import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, PeerStatus, RoomSnapshot } from "../../server/src/protocol";
import { DIAL_TIMEOUT_MS, Joiner, type View } from "../src/joiner";

type P = { id: string; status: PeerStatus; group?: string };
/** Peers in join order; a host's `group` is its groupId, a member's `group` points at one. */
function snap(...peers: P[]): RoomSnapshot {
  return {
    peers: peers.map((p) => ({ peerId: p.id, device: "mobile", status: p.status, groupId: p.group ?? null })),
    groups: peers
      .filter((p) => p.status === "host")
      .map((h) => ({
        groupId: h.group!,
        hostId: h.id,
        term: 1,
        members: peers.filter((p) => p.status === "member" && p.group === h.group).map((p) => p.id),
      })),
  };
}

/** A dial double: each call gets a promise the test settles by host id. */
function harness() {
  const sent: ClientMessage[] = [];
  const calls: { hostId: string; signal: AbortSignal; resolve: () => void; reject: (e: Error) => void }[] = [];
  const dial = vi.fn((hostId: string, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => calls.push({ hostId, signal, resolve, reject: (e) => reject(e) })),
  );
  const j = new Joiner({ send: (m) => sent.push(m), dial });
  const settle = async (hostId: string, ok: boolean) => {
    const c = [...calls].reverse().find((c) => c.hostId === hostId)!;
    if (ok) c.resolve();
    else c.reject(new Error("nope"));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { j, sent, calls, dial, settle };
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
    expect(j.view).toEqual({ kind: "host", groupId: "g9", members: [], aloneInRoom: true });
    expect(sent).toEqual([]);
  });

  it("host with members is not alone", () => {
    const { j } = harness();
    j.onWelcome("me", snap({ id: "me", status: "host", group: "g9" }, { id: "x", status: "member", group: "g9" }));
    expect(j.view).toEqual({ kind: "host", groupId: "g9", members: ["x"], aloneInRoom: false });
  });
});

describe("joining", () => {
  it("dials all hosts at once", () => {
    const { j, dial } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    expect(dial.mock.calls.map((c) => c[0])).toEqual(["h1", "h2"]);
    expect(j.view).toEqual({ kind: "connecting" });
  });

  it("first success wins", async () => {
    const { j, sent, calls, settle } = harness();
    j.onWelcome("me", snap(h1, h2, meJoining));
    await settle("h2", true);
    expect(sent).toEqual([{ t: "joined", groupId: "g2" }]);
    expect(calls.find((c) => c.hostId === "h1")!.signal.aborted).toBe(true);
    expect(calls.find((c) => c.hostId === "h2")!.signal.aborted).toBe(false);
    await settle("h1", true);
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
    expect(j.view).toEqual({ kind: "member", groupId: "g1", hostId: "h1" });
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
