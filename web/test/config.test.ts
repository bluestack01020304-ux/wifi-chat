import { describe, expect, it } from "vitest";
import { detectDevice, signalUrl } from "../src/config";

describe("signalUrl", () => {
  it("uses the deployed server and forwards room", () => {
    expect(signalUrl(new URL("https://p.dev/?room=거실"), "mobile")).toBe(
      "wss://wifi-chat-signal.wifi-chat-signal.workers.dev/ws?room=%EA%B1%B0%EC%8B%A4&device=mobile",
    );
  });

  it("honours ?signal= and forwards only room, key and anon", () => {
    const key = "A".repeat(22);
    expect(signalUrl(new URL(`https://p.dev/?signal=ws://localhost:8787/ws&mode=meeting&key=${key}&anon=1&junk=1`), "desktop")).toBe(
      `ws://localhost:8787/ws?key=${key}&anon=1&device=desktop`,
    );
  });

  it("works with no parameters", () => {
    expect(signalUrl(new URL("https://p.dev/"), "mobile")).toBe(
      "wss://wifi-chat-signal.wifi-chat-signal.workers.dev/ws?device=mobile",
    );
  });
});

describe("detectDevice", () => {
  it("desktop needs a fine pointer and a non-mobile UA", () => {
    expect(detectDevice("Mozilla/5.0 (Windows NT 10.0)", true)).toBe("desktop");
    expect(detectDevice("Mozilla/5.0 (Linux; Android 14) Mobile", true)).toBe("mobile");
    expect(detectDevice("Mozilla/5.0 (iPad; CPU OS 18_0)", true)).toBe("mobile");
    expect(detectDevice("Mozilla/5.0 (Windows NT 10.0)", false)).toBe("mobile");
  });
});
