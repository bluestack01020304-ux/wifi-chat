import { describe, expect, it } from "vitest";
import { knownRoster, rosterNotes } from "../../src/chat/notes";
import type { RosterEntry } from "../../src/chat/wire";

const p = (peerId: string, nick: string, host = false): RosterEntry => ({ peerId, nick, host, away: false });
const before = [p("h", "노란 오리", true), p("me", "주황 고양이")];

describe("rosterNotes", () => {
  it("the first roster after entering says nothing", () => {
    expect(rosterNotes(null, before, "me", 5, null)).toEqual([]);
  });

  it("announces an arrival", () => {
    expect(rosterNotes(before, [...before, p("w", "푸른 고래")], "me", 7, null)).toEqual([{ at: 7, text: "푸른 고래님이 Wi-Fi에 들어왔어요" }]);
  });

  it("says nothing about my own arrival", () => {
    expect(rosterNotes([p("h", "노란 오리", true)], before, "me", 7, null)).toEqual([]);
  });

  it("says nothing about departures", () => {
    expect(rosterNotes([...before, p("w", "푸른 고래")], before, "me", 7, null)).toEqual([]);
  });

  it("announces a handover with the measured gap", () => {
    const after = [p("w", "익명 2", true), p("me", "익명 3")];
    expect(rosterNotes([p("h", "익명 1", true), p("me", "익명 3"), p("w", "익명 2")], after, "me", 9, 834)).toEqual([
      { at: 9, text: "호스트가 나갔어요 · 익명 2님이 이어받았어요 (끊김 0.8초)" },
    ]);
  });

  it("announces a handover without a gap", () => {
    const after = [p("w", "푸른 고래", true), p("me", "주황 고양이")];
    expect(rosterNotes(before, after, "me", 9, null)).toEqual([{ at: 9, text: "호스트가 나갔어요 · 푸른 고래님이 이어받았어요" }]);
  });

  it("puts the handover before arrivals and does not announce the new host twice", () => {
    const after = [p("w", "푸른 고래", true), p("me", "주황 고양이"), p("z", "회색 여우")];
    expect(rosterNotes(before, after, "me", 9, null).map((n) => n.text)).toEqual([
      "호스트가 나갔어요 · 푸른 고래님이 이어받았어요",
      "회색 여우님이 Wi-Fi에 들어왔어요",
    ]);
  });

  it("taking over myself is announced with my name", () => {
    const after = [p("me", "주황 고양이", true)];
    expect(rosterNotes(before, after, "me", 9, null)).toEqual([{ at: 9, text: "호스트가 나갔어요 · 주황 고양이님이 이어받았어요" }]);
  });
});

describe("knownRoster", () => {
  it("a handover followed by members re-attaching announces nothing new", () => {
    const full = [p("h", "노란 오리", true), p("me", "주황 고양이"), p("x", "푸른 고래")];
    // I take over: my new roster starts with only me, then x re-attaches.
    const step1 = [p("me", "주황 고양이", true)];
    const known1 = knownRoster(full, step1);
    expect(rosterNotes(full, step1, "me", 1, null).map((n) => n.text)).toEqual(["호스트가 나갔어요 · 주황 고양이님이 이어받았어요"]);
    const step2 = [p("me", "주황 고양이", true), p("x", "푸른 고래")];
    expect(rosterNotes(known1, step2, "me", 2, null)).toEqual([]);
    expect(knownRoster(known1, step2).find((e) => e.host)?.peerId).toBe("me");
  });
});
