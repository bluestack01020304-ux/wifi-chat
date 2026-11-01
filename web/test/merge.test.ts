import { describe, expect, it } from "vitest";
import { commitPlan, dialTargets, linksToClose, mergeComplete, planAfterDial } from "../src/merge";
import { type P, snap } from "./snap";

const h1: P = { id: "h1", status: "host", group: "g1" };
const m1: P = { id: "m1", status: "member", group: "g1" };
const h2: P = { id: "h2", status: "host", group: "g2" };
const u: P = { id: "u", status: "unattached" };
const j: P = { id: "j", status: "joining" };
const me: P = { id: "me", status: "joining" };
const set = (...ids: string[]) => new Set(ids);

describe("dialTargets", () => {
  it("hosts and other unattached, not members, joining peers or me", () => {
    const room = snap(h1, m1, u, j, h2, { id: "me", status: "unattached" });
    expect(dialTargets("me", room)).toEqual(["h1", "u", "h2"]);
  });
});

describe("planAfterDial", () => {
  const room = snap(h1, m1, h2, u, me);
  it("nothing reached → none", () => {
    expect(planAfterDial("me", "mobile", room, set())).toEqual({ kind: "none" });
  });
  it("one host → join", () => {
    expect(planAfterDial("me", "mobile", room, set("h2"))).toEqual({ kind: "join", groupId: "g2" });
  });
  it("two hosts → merge both", () => {
    expect(planAfterDial("me", "mobile", room, set("h2", "h1"))).toEqual({ kind: "merge", groups: ["g1", "g2"], unattached: [] });
  });
  it("host + unattached → merge", () => {
    expect(planAfterDial("me", "mobile", room, set("h1", "u"))).toEqual({ kind: "merge", groups: ["g1"], unattached: ["u"] });
  });
  it("only unattached → merge with no groups", () => {
    expect(planAfterDial("me", "mobile", room, set("u"))).toEqual({ kind: "merge", groups: [], unattached: ["u"] });
  });
  it("mobile me joins a desktop host instead of merging", () => {
    const r = snap(h1, { ...h2, device: "desktop" }, u, me);
    expect(planAfterDial("me", "mobile", r, set("h1", "h2", "u"))).toEqual({ kind: "join", groupId: "g2" });
  });
  it("desktop me merges mobile hosts", () => {
    expect(planAfterDial("me", "desktop", room, set("h1", "h2"))).toEqual({ kind: "merge", groups: ["g1", "g2"], unattached: [] });
  });
});

describe("merge completion and commit", () => {
  const room = snap(h1, m1, h2, u, me);
  it("group with an unlinked member is not whole", () => {
    expect(mergeComplete(room, ["g1"], set("h1"))).toBe(false);
    expect(commitPlan("me", room, ["g1"], set("h1"))).toBeNull();
    expect(mergeComplete(room, ["g1", "g2"], set("h1", "m1", "h2"))).toBe(true);
    expect(commitPlan("me", room, ["g1", "g2"], set("h1", "m1", "h2"))).toEqual({ groups: ["g1", "g2"], peers: ["h1", "m1", "h2"] });
  });
  it("a group that vanished does not block completion", () => {
    expect(mergeComplete(room, ["gone", "g2"], set("h2"))).toBe(true);
  });
  it("linked unattached with no whole group commits", () => {
    expect(commitPlan("me", room, ["g1"], set("u", "h1"))).toEqual({ groups: [], peers: ["u"] });
  });
  it("one whole group only → null", () => {
    expect(commitPlan("me", room, ["g1", "g2"], set("h2"))).toBeNull();
  });
});

describe("linksToClose", () => {
  it("links to joining or unattached peers are never closed", () => {
    const room = snap(h1, { id: "me", status: "member", group: "g1" }, { id: "n", status: "joining" }, u);
    expect(linksToClose("me", room, set("h1", "n", "u"))).toEqual([]);
  });
  it("links to peers gone from the room are closed", () => {
    const room = snap(h1, { id: "me", status: "member", group: "g1" });
    expect(linksToClose("me", room, set("h1", "n"))).toEqual(["n"]);
  });
  it("member closes links to other hosts and members", () => {
    const room = snap(h1, { id: "me", status: "member", group: "g1" }, h2, { id: "m2", status: "member", group: "g2" });
    expect(linksToClose("me", room, set("h1", "h2", "m2"))).toEqual(["h2", "m2"]);
  });
  it("host closes links to members of other groups and other hosts", () => {
    const room = snap({ id: "me", status: "host", group: "g9" }, { id: "x", status: "member", group: "g9" }, h1, m1);
    expect(linksToClose("me", room, set("x", "h1", "m1"))).toEqual(["h1", "m1"]);
  });
  it("waiting peer keeps settled links", () => {
    expect(linksToClose("me", snap(h1, m1, me), set("h1", "m1"))).toEqual([]);
  });
});
