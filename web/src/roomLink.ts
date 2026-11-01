import { type Mode, parseRoomParams } from "../../server/src/roomKey";

/** The server's limit, repeated for the link panel's error message. */
export const MAX_ROOM = 40;

export interface RoomInfo {
  room: string;
  mode: Mode;
  key: string | null;
}

/**
 * The room this page asks for, by the server's own rules (shared code, so the
 * page refuses exactly what the server would refuse instead of opening a
 * socket that is rejected).
 */
export function readRoom(page: URL): RoomInfo | { error: string } {
  const probe = new URL(page.href);
  probe.searchParams.delete("device");
  const parsed = parseRoomParams(probe);
  if ("error" in parsed) return parsed;
  return { room: parsed.room, mode: parsed.mode, key: parsed.key };
}

/** An unguessable meeting token: 16 random bytes as 22 base64url characters. */
export function meetingKey(fill: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = fill(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A link to a room on this site; only room (and mode/key for a meeting) are kept. */
export function roomLink(base: URL, room: string, mode: Mode, key?: string): string | { error: string } {
  const url = new URL(base.origin + base.pathname);
  url.searchParams.set("room", room);
  if (mode === "meeting") {
    url.searchParams.set("mode", "meeting");
    url.searchParams.set("key", key ?? "");
  }
  const check = readRoom(url);
  if ("error" in check) return check;
  if (check.room !== room.normalize("NFC").trim()) return { error: "room name changed" };
  return url.toString();
}
