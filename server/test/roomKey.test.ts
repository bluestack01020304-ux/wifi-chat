import { describe, expect, it } from "vitest";
import { networkId, parseRoomParams, roomKeyString } from "../src/roomKey";

describe("networkId", () => {
  it("keeps IPv4 as is", () => {
    expect(networkId("203.0.113.5")).toBe("203.0.113.5");
  });
  it("unwraps IPv4-mapped IPv6", () => {
    expect(networkId("::ffff:203.0.113.5")).toBe("203.0.113.5");
  });
  it("reduces IPv6 to its /64", () => {
    expect(networkId("2001:db8:abcd:12::1")).toBe("2001:0db8:abcd:0012::/64");
    expect(networkId("2001:db8:abcd:12:ffff::9")).toBe("2001:0db8:abcd:0012::/64");
    expect(networkId("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(networkId("2001:DB8::1")).toBe("2001:0db8:0000:0000::/64");
  });
  it("rejects garbage", () => {
    expect(networkId("not-an-ip")).toBeNull();
    expect(networkId("1.2.3.999")).toBeNull();
    expect(networkId("1.2.3")).toBeNull();
    expect(networkId("1::2::3")).toBeNull();
    expect(networkId("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(networkId("12345::1")).toBeNull();
    expect(networkId("")).toBeNull();
  });
});

describe("parseRoomParams", () => {
  const p = (q: string) => parseRoomParams(new URL("https://x/ws" + q));

  it("applies defaults", () => {
    expect(p("")).toEqual({ room: "기본", mode: "family", key: null, device: "mobile" });
  });
  it("trims room and reads device", () => {
    expect(p("?room=%20%EA%B1%B0%EC%8B%A4%20&device=desktop")).toEqual({
      room: "거실", mode: "family", key: null, device: "desktop",
    });
  });
  it("blank room falls back to default", () => {
    expect(p("?room=%20%20")).toMatchObject({ room: "기본" });
  });
  it("NFC-normalizes room names", () => {
    expect(p("?room=" + encodeURIComponent("거실".normalize("NFD")))).toMatchObject({ room: "거실" });
  });
  it("family mode ignores key", () => {
    expect(p("?mode=family&key=AAAAAAAAAAAAAAAAAAAAAA")).toMatchObject({ key: null });
  });
  it("meeting mode requires a valid key", () => {
    expect(p("?mode=meeting&key=AAAAAAAAAAAAAAAAAAAAAA")).toMatchObject({
      mode: "meeting", key: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(p("?mode=meeting")).toHaveProperty("error");
    expect(p("?mode=meeting&key=short")).toHaveProperty("error");
    expect(p("?mode=meeting&key=AAAAAAAAAAAAAAAAAAAAA%2B")).toHaveProperty("error");
  });
  it("rejects unknown mode and device", () => {
    expect(p("?mode=party")).toHaveProperty("error");
    expect(p("?device=tv")).toHaveProperty("error");
  });
  it("limits room name to 40 code points", () => {
    expect(p("?room=" + encodeURIComponent("가".repeat(41)))).toHaveProperty("error");
    expect(p("?room=" + encodeURIComponent("가".repeat(40)))).not.toHaveProperty("error");
  });
});

describe("roomKeyString", () => {
  const base = { room: "거실", mode: "family", key: null, device: "mobile" } as const;

  it("cannot be forged by delimiters in the room name", () => {
    expect(roomKeyString("1.2.3.4", { ...base, room: "a|b" })).not.toBe(
      roomKeyString("1.2.3.4", { ...base, room: "a", key: "b" }),
    );
  });
  it("does not depend on device", () => {
    expect(roomKeyString("1.2.3.4", { ...base, device: "desktop" })).toBe(roomKeyString("1.2.3.4", base));
  });
  it("differs by network, room, mode and key", () => {
    const k = roomKeyString("1.2.3.4", base);
    expect(roomKeyString("1.2.3.5", base)).not.toBe(k);
    expect(roomKeyString("1.2.3.4", { ...base, room: "부엌" })).not.toBe(k);
    expect(roomKeyString("1.2.3.4", { ...base, mode: "meeting", key: "AAAAAAAAAAAAAAAAAAAAAA" })).not.toBe(k);
  });
});
