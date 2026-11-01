import type { Device } from "./roomKey";

export const MAX_MESSAGE = 32768;
/** Upper bound on each id list in merge messages (a room holds at most 32 peers). */
export const MAX_MERGE_IDS = 32;

export type PeerStatus = "host" | "member" | "joining" | "unattached";
export type ErrorCode =
  | "bad-json"
  | "bad-message"
  | "too-large"
  | "no-such-peer"
  | "no-such-group"
  | "bad-state"
  | "too-many";

export interface PeerView {
  peerId: string;
  device: Device;
  status: PeerStatus;
  groupId: string | null;
}
/** `members` excludes the host. */
export interface GroupView {
  groupId: string;
  hostId: string;
  term: number;
  members: string[];
}
export interface RoomSnapshot {
  peers: PeerView[];
  groups: GroupView[];
}

export interface Sdp {
  type: "offer" | "answer";
  sdp: string;
}

export type ClientMessage =
  | { t: "signal"; to: string; sdp: Sdp }
  | { t: "joined"; groupId: string }
  | { t: "unattached" }
  | { t: "start-alone" }
  | { t: "merge-start"; groups: string[]; unattached: string[] }
  | { t: "merge-commit"; groups: string[]; peers: string[] };

export type ServerMessage =
  | { t: "welcome"; peerId: string; room: RoomSnapshot }
  | { t: "room"; room: RoomSnapshot }
  | { t: "signal"; from: string; sdp: Sdp }
  | { t: "merge-request"; bridgeId: string }
  | { t: "error"; code: ErrorCode; message: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parseIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_MERGE_IDS || !v.every(isId)) return null;
  return [...v];
}

function parseSdp(v: unknown): Sdp | null {
  if (!isObject(v)) return null;
  if (v.type !== "offer" && v.type !== "answer") return null;
  if (typeof v.sdp !== "string") return null;
  return { type: v.type, sdp: v.sdp };
}

/** Validates a client frame and rebuilds it from known fields only. */
export function parseClientMessage(raw: string | ArrayBuffer): ClientMessage | { error: ErrorCode } {
  if (typeof raw !== "string") return { error: "bad-message" };
  if (raw.length > MAX_MESSAGE) return { error: "too-large" };

  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: "bad-json" };
  }
  if (!isObject(v)) return { error: "bad-message" };

  switch (v.t) {
    case "unattached":
    case "start-alone":
      return { t: v.t };
    case "joined":
      return isId(v.groupId) ? { t: "joined", groupId: v.groupId } : { error: "bad-message" };
    case "signal": {
      const sdp = parseSdp(v.sdp);
      return isId(v.to) && sdp ? { t: "signal", to: v.to, sdp } : { error: "bad-message" };
    }
    case "merge-start": {
      const groups = parseIds(v.groups);
      const unattached = parseIds(v.unattached);
      return groups && unattached ? { t: "merge-start", groups, unattached } : { error: "bad-message" };
    }
    case "merge-commit": {
      const groups = parseIds(v.groups);
      const peers = parseIds(v.peers);
      return groups && peers ? { t: "merge-commit", groups, peers } : { error: "bad-message" };
    }
    default:
      return { error: "bad-message" };
  }
}
