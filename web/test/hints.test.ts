import { describe, expect, it } from "vitest";
import { permissionHint } from "../src/hints";
import type { View } from "../src/joiner";

const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";
const WEBVIEW = "Mozilla/5.0 (Linux; Android 17; SM-S942N Build/CP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 NAVER(inapp)";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const failed: View = { kind: "failed" };
const lonelyHost: View = { kind: "host", groupId: "g", members: [], aloneInRoom: false, term: 1 };
const busyHost: View = { kind: "host", groupId: "g", members: ["x"], aloneInRoom: false, term: 1 };
const member: View = { kind: "member", groupId: "g", hostId: "h", term: 1 };

describe("permissionHint", () => {
  it("an Android browser that cannot reach anyone is told to allow nearby devices", () => {
    expect(permissionHint(CHROME_ANDROID, failed, 1)).toBe("self");
    expect(permissionHint(CHROME_ANDROID, lonelyHost, 1)).toBe("self");
  });

  it("an in-app WebView is not told (it is not restricted)", () => {
    expect(permissionHint(WEBVIEW, failed, 1)).toBe("peer");
  });

  it("other devices that fail are told the peer may need it", () => {
    expect(permissionHint(DESKTOP, failed, 1)).toBe("peer");
    expect(permissionHint(DESKTOP, lonelyHost, 1)).toBe("peer");
  });

  it("nothing when connected or truly alone", () => {
    expect(permissionHint(CHROME_ANDROID, busyHost, 1)).toBeNull();
    expect(permissionHint(CHROME_ANDROID, member, 1)).toBeNull();
    expect(permissionHint(CHROME_ANDROID, lonelyHost, 0)).toBeNull();
    expect(permissionHint(DESKTOP, { kind: "connecting" }, 1)).toBeNull();
  });
});
