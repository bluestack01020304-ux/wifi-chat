import { describe, expect, it } from "vitest";
import { MAX_MERGE_IDS, MAX_MESSAGE, parseClientMessage } from "../src/protocol";

describe("parseClientMessage", () => {
  it("parses messages without fields", () => {
    expect(parseClientMessage('{"t":"unattached"}')).toEqual({ t: "unattached" });
    expect(parseClientMessage('{"t":"start-alone","extra":1}')).toEqual({ t: "start-alone" });
  });

  it("parses joined", () => {
    expect(parseClientMessage('{"t":"joined","groupId":"g1"}')).toEqual({ t: "joined", groupId: "g1" });
    expect(parseClientMessage('{"t":"joined"}')).toEqual({ error: "bad-message" });
    expect(parseClientMessage('{"t":"joined","groupId":""}')).toEqual({ error: "bad-message" });
  });

  it("parses signal and drops unknown fields", () => {
    const msg = { t: "signal", to: "p2", sdp: { type: "offer", sdp: "v=0", x: 1 }, y: 2 };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual({
      t: "signal", to: "p2", sdp: { type: "offer", sdp: "v=0" },
    });
  });

  it("rejects malformed signal", () => {
    expect(parseClientMessage('{"t":"signal","to":"p2","sdp":{"type":"pranswer","sdp":"x"}}')).toEqual({ error: "bad-message" });
    expect(parseClientMessage('{"t":"signal","to":5,"sdp":{"type":"offer","sdp":"x"}}')).toEqual({ error: "bad-message" });
    expect(parseClientMessage('{"t":"signal","to":"p2","sdp":{"type":"offer"}}')).toEqual({ error: "bad-message" });
    expect(parseClientMessage('{"t":"signal","to":"p2"}')).toEqual({ error: "bad-message" });
  });

  it("rejects non-JSON, non-objects and unknown types", () => {
    expect(parseClientMessage("nope")).toEqual({ error: "bad-json" });
    expect(parseClientMessage("[]")).toEqual({ error: "bad-message" });
    expect(parseClientMessage("null")).toEqual({ error: "bad-message" });
    expect(parseClientMessage('{"t":"hack"}')).toEqual({ error: "bad-message" });
  });

  it("rejects oversized and binary frames", () => {
    expect(parseClientMessage("x".repeat(MAX_MESSAGE + 1))).toEqual({ error: "too-large" });
    expect(parseClientMessage(new ArrayBuffer(4))).toEqual({ error: "bad-message" });
  });
});

describe("merge messages", () => {
  it("parses merge-start and merge-commit without extra fields", () => {
    expect(parseClientMessage('{"t":"merge-start","groups":["g1"],"unattached":["u"],"x":1}')).toEqual({
      t: "merge-start", groups: ["g1"], unattached: ["u"],
    });
    expect(parseClientMessage('{"t":"merge-commit","groups":[],"peers":["a","b"],"x":1}')).toEqual({
      t: "merge-commit", groups: [], peers: ["a", "b"],
    });
  });

  it("rejects malformed id lists", () => {
    const bad = (groups: unknown) => parseClientMessage(JSON.stringify({ t: "merge-start", groups, unattached: [] }));
    expect(bad("g1")).toEqual({ error: "bad-message" });
    expect(bad([1])).toEqual({ error: "bad-message" });
    expect(bad([""])).toEqual({ error: "bad-message" });
    expect(bad(Array.from({ length: MAX_MERGE_IDS + 1 }, (_, i) => "g" + i))).toEqual({ error: "bad-message" });
    expect(parseClientMessage('{"t":"merge-start","groups":[]}')).toEqual({ error: "bad-message" });
    expect(parseClientMessage('{"t":"merge-commit","groups":[],"peers":"a"}')).toEqual({ error: "bad-message" });
  });
});

describe("succession messages", () => {
  it("parses heartbeat and confirm", () => {
    expect(parseClientMessage(JSON.stringify({ t: "heartbeat", x: 1 }))).toEqual({ t: "heartbeat" });
    expect(parseClientMessage(JSON.stringify({ t: "confirm", groupId: "g1", term: 2, x: 1 }))).toEqual({ t: "confirm", groupId: "g1", term: 2 });
  });

  it("rejects a bad confirm", () => {
    for (const bad of [{ term: 0 }, { term: 1.5 }, { term: "2" }, { term: 2, groupId: "" }]) {
      expect(parseClientMessage(JSON.stringify({ t: "confirm", groupId: "g1", ...bad }))).toEqual({ error: "bad-message" });
    }
  });
});
