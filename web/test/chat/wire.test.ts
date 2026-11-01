import { describe, expect, it } from "vitest";
import { historyFrame, MAX_FRAME, MAX_HISTORY, parseToHost, parseToMember } from "../../src/chat/wire";

const msg = { id: "m1", from: "a", nick: "졸린 고양이", text: "hi", at: 5 };
const j = (v: unknown) => JSON.stringify(v);

describe("parseToHost", () => {
  it("parses hello and say, dropping extra fields", () => {
    expect(parseToHost(j({ t: "hello", nick: "졸린 고양이", x: 1 }))).toEqual({ t: "hello", nick: "졸린 고양이" });
    expect(parseToHost(j({ t: "say", id: "m1", text: "hi", from: "evil" }))).toEqual({ t: "say", id: "m1", text: "hi" });
  });

  it("cuts long text and rejects empty text", () => {
    const out = parseToHost(j({ t: "say", id: "m1", text: "가".repeat(600) }));
    expect(out).toMatchObject({ t: "say" });
    expect(Array.from((out as { text: string }).text)).toHaveLength(500);
    expect(parseToHost(j({ t: "say", id: "m1", text: "   \n " }))).toBeNull();
  });

  it("nickname is cleaned", () => {
    expect(parseToHost(j({ t: "hello", nick: "  a\u0007b\u0085  " }))).toEqual({ t: "hello", nick: "ab" });
    expect(parseToHost(j({ t: "hello", nick: "n".repeat(25) }))).toEqual({ t: "hello", nick: "n".repeat(20) });
    expect(parseToHost(j({ t: "hello", nick: "  " }))).toBeNull();
  });

  it("rejects oversized frames", () => {
    expect(parseToHost("x".repeat(MAX_FRAME + 1))).toBeNull();
  });

  it("rejects malformed frames", () => {
    for (const raw of [5, new ArrayBuffer(2), "nope", "[]", "null", j({ t: "hack" }), j({ t: "say", text: "hi" }), j({ t: "say", id: "m", text: 5 }), j({ t: "say", id: "", text: "hi" })]) {
      expect(parseToHost(raw)).toBeNull();
    }
  });
});

describe("historyFrame", () => {
  it("a full history of maximum-length emoji still fits and parses", () => {
    const msgs = Array.from({ length: MAX_HISTORY }, (_, i) => ({ ...msg, id: "m" + i, at: i, text: "😀".repeat(500) }));
    const frame = historyFrame(msgs, 1);
    expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(MAX_FRAME);
    const parsed = parseToMember(frame);
    expect(parsed).toMatchObject({ t: "history" });
    const ids = (parsed as { msgs: { id: string }[] }).msgs.map((m) => m.id);
    expect(ids.at(-1)).toBe("m99");
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(MAX_HISTORY);
  });

  it("a small history is sent whole", () => {
    expect(parseToMember(historyFrame([msg], 3))).toEqual({ t: "history", msgs: [msg], term: 3 });
  });
});

describe("parseToMember", () => {
  it("parses msg, history and roster", () => {
    expect(parseToMember(j({ t: "msg", msg: { ...msg, x: 1 }, term: 2 }))).toEqual({ t: "msg", msg, term: 2 });
    expect(parseToMember(j({ t: "history", msgs: [msg], term: 2 }))).toEqual({ t: "history", msgs: [msg], term: 2 });
    const p = { peerId: "a", nick: "n", host: true, away: false };
    expect(parseToMember(j({ t: "roster", people: [{ ...p, y: 2 }], term: 2 }))).toEqual({ t: "roster", people: [p], term: 2 });
  });

  it("rejects malformed frames", () => {
    expect(parseToMember(j({ t: "msg", msg: { ...msg, at: "5" } }))).toBeNull();
    expect(parseToMember(j({ t: "history", msgs: Array(MAX_HISTORY + 1).fill(msg) }))).toBeNull();
    expect(parseToMember(j({ t: "roster", people: [{ peerId: "a", nick: "n", host: true }] }))).toBeNull();
    expect(parseToMember(j({ t: "say", id: "m", text: "x" }))).toBeNull();
    expect(parseToMember("x".repeat(MAX_FRAME + 1))).toBeNull();
  });
});

describe("term on member frames", () => {
  it("rejects a missing or invalid term", () => {
    const m = { id: "m1", from: "a", nick: "n", text: "hi", at: 5 };
    expect(parseToMember(JSON.stringify({ t: "msg", msg: m }))).toBeNull();
    for (const term of [0, -1, 1.5, "2"]) expect(parseToMember(JSON.stringify({ t: "msg", msg: m, term }))).toBeNull();
  });
});
