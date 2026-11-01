import type { ClientMessage, ErrorCode, GroupView, PeerStatus, RoomSnapshot, ServerMessage } from "./protocol";
import type { Device } from "./roomKey";

/**
 * One connected peer. `term` is the group's term on host records, 0 otherwise.
 * `signalWindow`/`signals` rate-limit SDP relays from this peer.
 */
export interface PeerRecord {
  peerId: string;
  device: Device;
  status: PeerStatus;
  groupId: string | null;
  term: number;
  joinedAt: number;
  signalWindow: number;
  signals: number;
}

/** A joiner may offer to every other peer at once (up to 31), so leave room for that. */
export const SIGNAL_LIMIT = 64;
export const SIGNAL_WINDOW_MS = 10_000;

export type Outgoing = { to: string; msg: ServerMessage };

/**
 * Pure room logic for one room key. Groups are never stored: a group is a
 * host record plus the member records that point at its groupId.
 *
 * Not yet here: bridge merges (Next Steps 3) and host succession (Next
 * Steps 5). Until then a leaving host dissolves its group.
 */
export class RoomState {
  private peers = new Map<string, PeerRecord>();

  constructor(records: PeerRecord[], private newId: () => string) {
    for (const r of records) this.peers.set(r.peerId, { ...r });
  }

  get size(): number {
    return this.peers.size;
  }

  records(): PeerRecord[] {
    return [...this.peers.values()].map((r) => ({ ...r }));
  }

  snapshot(): RoomSnapshot {
    const sorted = [...this.peers.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const groups: GroupView[] = sorted
      .filter((r) => r.status === "host")
      .map((h) => ({
        groupId: h.groupId!,
        hostId: h.peerId,
        term: h.term,
        members: sorted.filter((r) => r.status === "member" && r.groupId === h.groupId).map((r) => r.peerId),
      }));
    return {
      peers: sorted.map(({ peerId, device, status, groupId }) => ({ peerId, device, status, groupId })),
      groups,
    };
  }

  join(peerId: string, device: Device, now: number): Outgoing[] {
    const hasHost = [...this.peers.values()].some((r) => r.status === "host");
    const record: PeerRecord = { peerId, device, status: "joining", groupId: null, term: 0, joinedAt: now, signalWindow: now, signals: 0 };
    this.peers.set(peerId, record);
    if (!hasHost) this.becomeHost(record);

    const room = this.snapshot();
    return [
      { to: peerId, msg: { t: "welcome", peerId, room } },
      ...this.broadcast(peerId),
    ];
  }

  handle(peerId: string, msg: ClientMessage, now: number = Date.now()): Outgoing[] {
    const me = this.peers.get(peerId);
    if (!me) return [];
    const waiting = me.status === "joining" || me.status === "unattached";

    switch (msg.t) {
      case "signal":
        if (msg.to === peerId || !this.peers.has(msg.to)) {
          return error(peerId, "no-such-peer", "no such peer in this room");
        }
        if (now - me.signalWindow >= SIGNAL_WINDOW_MS) {
          me.signalWindow = now;
          me.signals = 0;
        }
        if (me.signals >= SIGNAL_LIMIT) return error(peerId, "too-many", "too many signals, slow down");
        me.signals++;
        return [{ to: msg.to, msg: { t: "signal", from: peerId, sdp: msg.sdp } }];

      case "joined": {
        if (!waiting) return error(peerId, "bad-state", "only a waiting peer can join a group");
        const host = [...this.peers.values()].find((r) => r.status === "host" && r.groupId === msg.groupId);
        if (!host) return error(peerId, "no-such-group", "no such group in this room");
        me.status = "member";
        me.groupId = msg.groupId;
        return this.broadcast();
      }

      case "unattached":
        if (me.status !== "joining") return error(peerId, "bad-state", "only a joining peer can be unattached");
        me.status = "unattached";
        return this.broadcast();

      case "start-alone":
        if (!waiting) return error(peerId, "bad-state", "only a waiting peer can start alone");
        this.becomeHost(me);
        return this.broadcast();
    }
  }

  leave(peerId: string): Outgoing[] {
    const me = this.peers.get(peerId);
    if (!me) return [];
    this.peers.delete(peerId);
    if (me.status === "host") {
      for (const r of this.peers.values()) {
        if (r.status === "member" && r.groupId === me.groupId) {
          r.status = "unattached";
          r.groupId = null;
        }
      }
    }
    return this.broadcast();
  }

  private becomeHost(r: PeerRecord): void {
    r.status = "host";
    r.groupId = this.newId();
    r.term = 1;
  }

  /** A `room` message to every peer except `except`. */
  private broadcast(except?: string): Outgoing[] {
    const room = this.snapshot();
    return [...this.peers.keys()]
      .filter((id) => id !== except)
      .map((to) => ({ to, msg: { t: "room", room } }));
  }
}

function error(to: string, code: ErrorCode, message: string): Outgoing[] {
  return [{ to, msg: { t: "error", code, message } }];
}
