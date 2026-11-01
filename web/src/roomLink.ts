import { parseRoomParams } from "../../server/src/roomKey";

/** The server's limit, repeated for the link panel's error message. */
export const MAX_ROOM = 40;

/** `key`: only people with the link can join (null = anyone on the network). `anon`: everyone is "익명 N". */
export interface RoomInfo {
  room: string;
  key: string | null;
  anon: boolean;
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
  return { room: parsed.room, key: parsed.key, anon: parsed.anon };
}

/** An unguessable link token: 16 random bytes as 22 base64url characters. */
export function linkKey(fill: (bytes: Uint8Array<ArrayBuffer>) => unknown): string {
  const bytes = new Uint8Array(16);
  fill(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A link to a room on this site; only room, key and anon are kept. */
export function roomLink(base: URL, room: string, key: string | null, anon: boolean): string | { error: string } {
  const url = new URL(base.origin + base.pathname);
  url.searchParams.set("room", room);
  if (key !== null) url.searchParams.set("key", key);
  if (anon) url.searchParams.set("anon", "1");
  const check = readRoom(url);
  if ("error" in check) return check;
  // An empty or blank name would silently become the default room.
  if (check.room !== room.normalize("NFC").trim()) return { error: "empty room name" };
  return url.toString();
}
