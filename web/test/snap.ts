import type { PeerStatus, RoomSnapshot } from "../../server/src/protocol";
import type { Device } from "../../server/src/roomKey";

export type P = { id: string; status: PeerStatus; group?: string; device?: Device; term?: number };

/** Peers in join order; a host's `group` is its groupId, a member's `group` points at one. */
export function snap(...peers: P[]): RoomSnapshot {
  return {
    peers: peers.map((p) => ({ peerId: p.id, device: p.device ?? "mobile", status: p.status, groupId: p.group ?? null })),
    groups: peers
      .filter((p) => p.status === "host")
      .map((h) => ({
        groupId: h.group!,
        hostId: h.id,
        term: h.term ?? 1,
        members: peers.filter((p) => p.status === "member" && p.group === h.group).map((p) => p.id),
      })),
  };
}
