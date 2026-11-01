import { beforeEach, describe, expect, it } from "vitest";
import type { Outgoing } from "../src/room";
import { RoomState, SIGNAL_LIMIT, SIGNAL_WINDOW_MS } from "../src/room";

let n = 0;
const ids = () => "g" + ++n;
const sdp = { type: "offer", sdp: "v=0" } as const;

const recipients = (out: Outgoing[]) => out.map((o) => `${o.to}:${o.msg.t}`).sort();
const statusOf = (s: RoomState, id: string) => s.snapshot().peers.find((p) => p.peerId === id);

/** a = host of g1, b = joining. */
function twoPeers() {
  const s = new RoomState([], ids);
  s.join("a", "desktop", 1);
  s.join("b", "mobile", 2);
  return s;
}

beforeEach(() => {
  n = 0;
});

describe("join", () => {
  it("first peer becomes host", () => {
    const s = new RoomState([], ids);
    const out = s.join("a", "desktop", 1);
    expect(recipients(out)).toEqual(["a:welcome"]);
    expect(out[0].msg).toMatchObject({ t: "welcome", peerId: "a" });
    expect(s.snapshot().groups).toEqual([{ groupId: "g1", hostId: "a", term: 1, members: [] }]);
  });

  it("second peer is joining and others are told", () => {
    const s = new RoomState([], ids);
    s.join("a", "desktop", 1);
    const out = s.join("b", "mobile", 2);
    expect(recipients(out)).toEqual(["a:room", "b:welcome"]);
    expect(statusOf(s, "b")).toEqual({ peerId: "b", device: "mobile", status: "joining", groupId: null });
  });

  it("new peer becomes host when only unattached peers remain", () => {
    const s = twoPeers();
    s.handle("b", { t: "joined", groupId: "g1" });
    s.leave("a");
    s.join("d", "mobile", 3);
    expect(statusOf(s, "d")).toMatchObject({ status: "host" });
  });
});

describe("handle", () => {
  it("joined makes member and tells everyone", () => {
    const s = twoPeers();
    const out = s.handle("b", { t: "joined", groupId: "g1" });
    expect(recipients(out)).toEqual(["a:room", "b:room"]);
    expect(s.snapshot().groups[0].members).toEqual(["b"]);
  });

  it("joined to unknown group is an error and changes nothing", () => {
    const s = twoPeers();
    const before = s.snapshot();
    const out = s.handle("b", { t: "joined", groupId: "nope" });
    expect(out).toEqual([{ to: "b", msg: expect.objectContaining({ t: "error", code: "no-such-group" }) }]);
    expect(s.snapshot()).toEqual(before);
  });

  it("member cannot join again", () => {
    const s = twoPeers();
    s.handle("b", { t: "joined", groupId: "g1" });
    const out = s.handle("b", { t: "joined", groupId: "g1" });
    expect(out).toEqual([{ to: "b", msg: expect.objectContaining({ code: "bad-state" }) }]);
  });

  it("unattached then start-alone makes a second group", () => {
    const s = twoPeers();
    s.join("c", "mobile", 3);
    expect(recipients(s.handle("c", { t: "unattached" }))).toEqual(["a:room", "b:room", "c:room"]);
    expect(statusOf(s, "c")).toMatchObject({ status: "unattached", groupId: null });
    s.handle("c", { t: "start-alone" });
    expect(s.snapshot().groups).toEqual([
      { groupId: "g1", hostId: "a", term: 1, members: [] },
      { groupId: "g2", hostId: "c", term: 1, members: [] },
    ]);
  });

  it("unattached peer can still join a group", () => {
    const s = twoPeers();
    s.handle("b", { t: "unattached" });
    s.handle("b", { t: "joined", groupId: "g1" });
    expect(statusOf(s, "b")).toMatchObject({ status: "member", groupId: "g1" });
  });

  it("unattached is only for joining peers", () => {
    const s = twoPeers();
    expect(s.handle("a", { t: "unattached" })).toEqual([
      { to: "a", msg: expect.objectContaining({ code: "bad-state" }) },
    ]);
  });

  it("host cannot start alone", () => {
    const s = twoPeers();
    expect(s.handle("a", { t: "start-alone" })).toEqual([
      { to: "a", msg: expect.objectContaining({ code: "bad-state" }) },
    ]);
  });

  it("signal relays only to target", () => {
    const s = twoPeers();
    s.join("c", "mobile", 3);
    expect(s.handle("a", { t: "signal", to: "b", sdp })).toEqual([
      { to: "b", msg: { t: "signal", from: "a", sdp } },
    ]);
  });

  it("rate-limits signals per sender", () => {
    const s = twoPeers();
    s.join("c", "mobile", 3);
    for (let i = 0; i < SIGNAL_LIMIT; i++) {
      expect(s.handle("a", { t: "signal", to: "b", sdp }, 1000)[0].to).toBe("b");
    }
    expect(s.handle("a", { t: "signal", to: "b", sdp }, 1000)).toEqual([
      { to: "a", msg: expect.objectContaining({ t: "error", code: "too-many" }) },
    ]);
    // other senders are unaffected
    expect(s.handle("c", { t: "signal", to: "b", sdp }, 1000)[0].to).toBe("b");
    // the window resets
    expect(s.handle("a", { t: "signal", to: "b", sdp }, 1000 + SIGNAL_WINDOW_MS)[0].to).toBe("b");
  });

  it("rate limit survives a rebuild from records", () => {
    const s = twoPeers();
    for (let i = 0; i < SIGNAL_LIMIT; i++) s.handle("a", { t: "signal", to: "b", sdp }, 1000);
    const rebuilt = new RoomState(s.records(), ids);
    expect(rebuilt.handle("a", { t: "signal", to: "b", sdp }, 1000)[0].msg).toMatchObject({ code: "too-many" });
  });

  it("signal to self or unknown peer is an error", () => {
    const s = twoPeers();
    for (const to of ["a", "zzz"]) {
      expect(s.handle("a", { t: "signal", to, sdp })).toEqual([
        { to: "a", msg: expect.objectContaining({ t: "error", code: "no-such-peer" }) },
      ]);
    }
  });
});

describe("leave", () => {
  it("host leaving dissolves the group", () => {
    const s = twoPeers();
    s.handle("b", { t: "joined", groupId: "g1" });
    const out = s.leave("a");
    expect(recipients(out)).toEqual(["b:room"]);
    expect(statusOf(s, "b")).toMatchObject({ status: "unattached", groupId: null });
    expect(s.snapshot().groups).toEqual([]);
  });

  it("member leaving keeps the group", () => {
    const s = twoPeers();
    s.handle("b", { t: "joined", groupId: "g1" });
    s.leave("b");
    expect(s.snapshot().groups).toEqual([{ groupId: "g1", hostId: "a", term: 1, members: [] }]);
    expect(s.size).toBe(1);
  });

  it("unknown peer is a no-op", () => {
    expect(twoPeers().leave("zzz")).toEqual([]);
  });
});

describe("persistence", () => {
  it("round-trips through records", () => {
    const s = twoPeers();
    s.handle("b", { t: "joined", groupId: "g1" });
    s.join("c", "mobile", 3);
    s.handle("c", { t: "unattached" });
    expect(new RoomState(s.records(), ids).snapshot()).toEqual(s.snapshot());
  });

  it("orders peers by join time", () => {
    const s = new RoomState([], ids);
    s.join("late", "mobile", 9);
    s.join("early", "mobile", 1);
    expect(s.snapshot().peers.map((p) => p.peerId)).toEqual(["early", "late"]);
  });
});
