import { describe, expect, it } from "vitest";
import { meetingKey, readRoom, roomLink } from "../src/roomLink";

const page = (q: string) => new URL("https://wifi-chat.pages.dev/" + q);
const KEY = "A".repeat(22);

describe("readRoom", () => {
  it("defaults to 기본, family, no key", () => {
    expect(readRoom(page(""))).toEqual({ room: "기본", mode: "family", key: null });
  });

  it("trims and NFC-normalizes the room", () => {
    // "가" written as two jamo (NFD) must equal the composed form.
    expect(readRoom(page("?room=" + encodeURIComponent("  가  ")))).toEqual({ room: "가", mode: "family", key: null });
  });

  it("reads a meeting room", () => {
    expect(readRoom(page(`?room=3층&mode=meeting&key=${KEY}`))).toEqual({ room: "3층", mode: "meeting", key: KEY });
  });

  it("bad mode or key is an error", () => {
    for (const q of ["?mode=xyz", "?mode=meeting", `?mode=meeting&key=${"A".repeat(21)}`, `?mode=meeting&key=${"A".repeat(21)}%2B`]) {
      expect(readRoom(page(q))).toHaveProperty("error");
    }
  });

  it("a room over 40 characters is an error", () => {
    expect(readRoom(page("?room=" + encodeURIComponent("가".repeat(41))))).toHaveProperty("error");
    expect(readRoom(page("?room=" + encodeURIComponent("가".repeat(40))))).toMatchObject({ room: "가".repeat(40) });
  });

  it("ignores a key in family mode", () => {
    expect(readRoom(page(`?room=x&key=${KEY}`))).toEqual({ room: "x", mode: "family", key: null });
  });
});

describe("meetingKey", () => {
  it("meeting key shape", () => {
    expect(meetingKey((b) => b.fill(0))).toBe("A".repeat(22));
    const ff = meetingKey((b) => b.fill(0xff));
    expect(ff).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ff).not.toMatch(/[+/=]/);
  });

  it("asks for exactly 16 bytes", () => {
    let asked = 0;
    meetingKey((b) => {
      asked = b.length;
      return b;
    });
    expect(asked).toBe(16);
  });
});

describe("roomLink", () => {
  const base = page("?signal=ws://x/ws&room=old&junk=1");

  it("round-trips an odd room name", () => {
    const name = "3층 회의실&x#y <b>";
    const link = roomLink(base, name, "family");
    expect(typeof link).toBe("string");
    expect(readRoom(new URL(link as string))).toEqual({ room: name, mode: "family", key: null });
  });

  it("meeting link carries mode and key", () => {
    const link = roomLink(base, "3층", "meeting", KEY) as string;
    expect(readRoom(new URL(link))).toEqual({ room: "3층", mode: "meeting", key: KEY });
  });

  it("family link has no mode or key, and drops other params", () => {
    const link = new URL(roomLink(base, "집", "family") as string);
    expect([...link.searchParams.keys()]).toEqual(["room"]);
    expect(link.origin + link.pathname).toBe("https://wifi-chat.pages.dev/");
  });

  it("refuses a room over 40 characters", () => {
    expect(roomLink(base, "가".repeat(41), "family")).toHaveProperty("error");
  });
});
