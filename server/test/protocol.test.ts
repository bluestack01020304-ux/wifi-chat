import { describe, expect, it } from "vitest";
import { MAX_MESSAGE, parseClientMessage } from "../src/protocol";

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
