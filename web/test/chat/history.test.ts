import { describe, expect, it, vi } from "vitest";
import { History } from "../../src/chat/history";
import type { ChatMessage } from "../../src/chat/wire";

const m = (id: string, at: number): ChatMessage => ({ id, from: "a", nick: "n", text: id, at });

describe("History", () => {
  it("orders by at, then id", () => {
    const h = new History();
    h.add(m("b", 2));
    h.add(m("c", 1));
    h.add(m("a", 2));
    expect(h.list().map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores a duplicate id", () => {
    const h = new History();
    const cb = vi.fn();
    h.onChange(cb);
    expect(h.add(m("a", 1))).toBe(true);
    expect(h.add({ ...m("a", 9), text: "changed" })).toBe(false);
    expect(h.list()).toEqual([m("a", 1)]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("history keeps the newest 100", () => {
    const h = new History();
    for (let i = 1; i <= 150; i++) h.add(m("m" + i, i));
    expect(h.list()).toHaveLength(100);
    expect(h.list()[0].id).toBe("m51");
  });

  it("merge unions and fires onChange once", () => {
    const h = new History();
    h.add(m("a", 1));
    const cb = vi.fn();
    h.onChange(cb);
    h.merge([m("a", 1), m("b", 0), m("c", 3)]);
    expect(h.list().map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
