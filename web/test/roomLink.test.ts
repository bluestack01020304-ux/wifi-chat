import { describe, expect, it } from "vitest";
import { linkKey, readRoom, roomLink } from "../src/roomLink";

const page = (q: string) => new URL("https://wifi-chat.pages.dev/" + q);
const KEY = "A".repeat(22);

describe("readRoom", () => {
  it("defaults to 기본, open to the network, nicknames", () => {
    expect(readRoom(page(""))).toEqual({ room: "기본", key: null, anon: false });
  });

  it("trims and NFC-normalizes the room", () => {
    // "가" written as two jamo (NFD) must equal the composed form.
    expect(readRoom(page("?room=" + encodeURIComponent("  가  ")))).toEqual({ room: "가", key: null, anon: false });
  });

  it("reads a link-only anonymous room", () => {
    expect(readRoom(page(`?room=3층&key=${KEY}&anon=1`))).toEqual({ room: "3층", key: KEY, anon: true });
  });

  it("bad key or anon is an error", () => {
    for (const q of ["?key=", `?key=${"A".repeat(21)}`, `?key=${"A".repeat(21)}%2B`, "?anon=0", "?anon=yes"]) {
      expect(readRoom(page(q))).toHaveProperty("error");
    }
  });

  it("a room over 40 characters is an error", () => {
    expect(readRoom(page("?room=" + encodeURIComponent("가".repeat(41))))).toHaveProperty("error");
    expect(readRoom(page("?room=" + encodeURIComponent("가".repeat(40))))).toMatchObject({ room: "가".repeat(40) });
  });
});

describe("linkKey", () => {
  it("link key shape", () => {
    expect(linkKey((b) => b.fill(0))).toBe("A".repeat(22));
    const ff = linkKey((b) => b.fill(0xff));
    expect(ff).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ff).not.toMatch(/[+/=]/);
  });

  it("asks for exactly 16 bytes", () => {
    let asked = 0;
    linkKey((b) => {
      asked = b.length;
    });
    expect(asked).toBe(16);
  });
});

describe("roomLink", () => {
  const base = page("?signal=ws://x/ws&room=old&junk=1");

  it("round-trips an odd room name", () => {
    const name = "3층 회의실&x#y <b>";
    const link = roomLink(base, name, null, false);
    expect(typeof link).toBe("string");
    expect(readRoom(new URL(link as string))).toEqual({ room: name, key: null, anon: false });
  });

  it("each choice is independent", () => {
    for (const [key, anon] of [[KEY, false], [null, true], [KEY, true]] as const) {
      const link = roomLink(base, "3층", key, anon) as string;
      expect(readRoom(new URL(link))).toEqual({ room: "3층", key, anon });
    }
  });

  it("an open nickname link has only the room, and drops other params", () => {
    const link = new URL(roomLink(base, "집", null, false) as string);
    expect([...link.searchParams.keys()]).toEqual(["room"]);
    expect(link.origin + link.pathname).toBe("https://wifi-chat.pages.dev/");
  });

  it("refuses a room over 40 characters or an empty one", () => {
    expect(roomLink(base, "가".repeat(41), null, false)).toHaveProperty("error");
    expect(roomLink(base, "   ", null, false)).toHaveProperty("error");
  });
});
