import { describe, expect, it, vi } from "vitest";
import { Links } from "../src/links";

const link = (dialedByMe: boolean) => ({ dialedByMe, close: vi.fn() });

describe("Links", () => {
  it("first link is kept", () => {
    const links = new Links(() => "m");
    const l = link(true);
    expect(links.add("p", l)).toBe(true);
    expect(links.get("p")).toBe(l);
    expect(l.close).not.toHaveBeenCalled();
  });

  it("retry in the same direction replaces and closes the old", () => {
    const links = new Links(() => "m");
    const old = link(false);
    const fresh = link(false);
    links.add("p", old);
    expect(links.add("p", fresh)).toBe(true);
    expect(old.close).toHaveBeenCalledOnce();
    expect(links.get("p")).toBe(fresh);
  });

  it("glare keeps the lower id's offer on both sides", () => {
    // "a" offered link X to "b"; "b" offered link Y to "a". Each side sees both.
    const aSide = new Links(() => "a");
    const bSide = new Links(() => "b");
    const xAtA = link(true), yAtA = link(false);
    const xAtB = link(false), yAtB = link(true);

    aSide.add("b", xAtA);
    expect(aSide.add("b", yAtA)).toBe(false);
    bSide.add("a", yAtB);
    expect(bSide.add("a", xAtB)).toBe(true);

    expect(aSide.get("b")).toBe(xAtA);
    expect(bSide.get("a")).toBe(xAtB);
    expect(yAtA.close).toHaveBeenCalledOnce();
    expect(yAtB.close).toHaveBeenCalledOnce();
    expect(xAtA.close).not.toHaveBeenCalled();
    expect(xAtB.close).not.toHaveBeenCalled();
  });

  it("stale remove does not evict the replacement", () => {
    const links = new Links(() => "m");
    const old = link(true);
    const fresh = link(true);
    links.add("p", old);
    links.add("p", fresh);
    links.remove("p", old);
    expect(links.get("p")).toBe(fresh);
    links.remove("p", fresh);
    expect(links.get("p")).toBeUndefined();
  });

  it("close closes and forgets", () => {
    const links = new Links(() => "m");
    const l = link(true);
    links.add("p", l);
    links.add("q", link(true));
    links.close(["p", "zz"]);
    expect(l.close).toHaveBeenCalledOnce();
    expect(links.ids()).toEqual(new Set(["q"]));
  });

  it("onChange fires on add, remove and close", () => {
    const links = new Links(() => "m");
    const cb = vi.fn();
    links.onChange(cb);
    const l = link(true);
    links.add("p", l);
    links.remove("p", l);
    links.add("q", link(true));
    links.close(["q"]);
    links.close(["q"]);
    expect(cb).toHaveBeenCalledTimes(4);
  });
});
