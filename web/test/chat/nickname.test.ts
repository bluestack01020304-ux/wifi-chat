import { describe, expect, it } from "vitest";
import { makeNickname } from "../../src/chat/nickname";
import { MAX_NICK } from "../../src/chat/wire";

describe("makeNickname", () => {
  it("is an adjective and an animal", () => {
    const a = makeNickname(() => 0);
    const b = makeNickname(() => 0.999);
    expect(a).not.toBe(b);
    for (const n of [a, b]) {
      expect(n).toMatch(/^\S+ \S+$/);
      expect(Array.from(n).length).toBeLessThanOrEqual(MAX_NICK);
    }
  });

  it("has at least 1600 combinations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) for (let k = 0; k < 40; k++) {
      const calls = [(i + 0.5) / 40, (k + 0.5) / 40];
      seen.add(makeNickname(() => calls.shift()!));
    }
    expect(seen.size).toBe(1600);
  });
});
