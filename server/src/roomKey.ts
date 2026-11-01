export type Device = "desktop" | "mobile";

/**
 * A room is two independent choices on top of its name:
 * `key` — only people with the link (an unguessable token) can join; null = anyone on the same network.
 * `anon` — everyone is shown as "익명 N" instead of a nickname.
 */
export type RoomParams = {
  room: string;
  key: string | null;
  anon: boolean;
  device: Device;
};

const DEFAULT_ROOM = "기본";
const MAX_ROOM_CODE_POINTS = 40;
const LINK_KEY = /^[A-Za-z0-9_-]{22}$/;

function parseIPv4(s: string): string | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
  }
  return parts.map(Number).join(".");
}

/** Expands an IPv6 address into 8 lowercase 4-digit hextets, or null. */
function expandIPv6(s: string): string[] | null {
  const halves = s.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const split = (h: string) => (h === "" ? [] : h.split(":"));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0"));
}

/**
 * The source-network part of the room key: an IPv4 address as is, an IPv6
 * address as its /64 prefix, an IPv4-mapped IPv6 address as its IPv4 address.
 */
export function networkId(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) return v4;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return parseIPv4(mapped[1]);

  const groups = expandIPv6(ip);
  if (!groups) return null;
  return groups.slice(0, 4).join(":") + "::/64";
}

export function parseRoomParams(url: URL): RoomParams | { error: string } {
  const q = url.searchParams;

  const room = (q.get("room") ?? "").normalize("NFC").trim() || DEFAULT_ROOM;
  if (Array.from(room).length > MAX_ROOM_CODE_POINTS) {
    return { error: `room name is longer than ${MAX_ROOM_CODE_POINTS} characters` };
  }

  const device = q.get("device") ?? "mobile";
  if (device !== "desktop" && device !== "mobile") return { error: "device must be desktop or mobile" };

  const key = q.get("key");
  if (key !== null && !LINK_KEY.test(key)) return { error: "key must be 22 base64url characters" };

  const anonParam = q.get("anon");
  if (anonParam !== null && anonParam !== "1") return { error: "anon must be 1" };

  return { room, key, anon: anonParam === "1", device };
}

/** JSON, not a delimiter, so no room name can collide with another key. */
export function roomKeyString(netId: string, p: RoomParams): string {
  return JSON.stringify([netId, p.room, p.key, p.anon]);
}
