import { describe, expect, it } from "vitest";
import { MAX_FRAME, MAX_HISTORY, parseToHost, parseToMember } from "../../src/chat/wire";

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

describe("parseToMember", () => {
  it("parses msg, history and roster", () => {
    expect(parseToMember(j({ t: "msg", msg: { ...msg, x: 1 } }))).toEqual({ t: "msg", msg });
    expect(parseToMember(j({ t: "history", msgs: [msg] }))).toEqual({ t: "history", msgs: [msg] });
    const p = { peerId: "a", nick: "n", host: true, away: false };
    expect(parseToMember(j({ t: "roster", people: [{ ...p, y: 2 }] }))).toEqual({ t: "roster", people: [p] });
  });

  it("rejects malformed frames", () => {
    expect(parseToMember(j({ t: "msg", msg: { ...msg, at: "5" } }))).toBeNull();
    expect(parseToMember(j({ t: "history", msgs: Array(MAX_HISTORY + 1).fill(msg) }))).toBeNull();
    expect(parseToMember(j({ t: "roster", people: [{ peerId: "a", nick: "n", host: true }] }))).toBeNull();
    expect(parseToMember(j({ t: "say", id: "m", text: "x" }))).toBeNull();
    expect(parseToMember("x".repeat(MAX_FRAME + 1))).toBeNull();
  });
});
