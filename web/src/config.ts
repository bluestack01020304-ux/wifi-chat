import type { Device } from "../../server/src/roomKey";

export const DEFAULT_SIGNAL_URL = "wss://wifi-chat-signal.wifi-chat-signal.workers.dev/ws";
const FORWARDED = ["room", "key", "anon"] as const;

/** The signaling socket URL for this page: `?signal=` override, page room/key/anon forwarded, device added. */
export function signalUrl(page: URL, device: Device): string {
  const url = new URL(page.searchParams.get("signal") ?? DEFAULT_SIGNAL_URL);
  url.search = "";
  for (const name of FORWARDED) {
    const v = page.searchParams.get(name);
    if (v !== null) url.searchParams.set(name, v);
  }
  url.searchParams.set("device", device);
  return url.toString();
}

export function detectDevice(ua: string, finePointer: boolean): Device {
  return finePointer && !/Mobi|Android|iPhone|iPad/.test(ua) ? "desktop" : "mobile";
}
