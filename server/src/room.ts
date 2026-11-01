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
 * Bridge merges are validated here against the current records only; the
 * server trusts the bridge's claim of which peers it is linked to.
 * Not yet here: host succession (Next Steps 5). Until then a leaving host
 * dissolves its group.
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
        if (!this.spendSignal(me, now)) return error(peerId, "too-many", "too many signals, slow down");
        return [{ to: msg.to, msg: { t: "signal", from: peerId, sdp: msg.sdp } }];

      case "joined": {
        if (!waiting) return error(peerId, "bad-state", "only a waiting peer can join a group");
        if (!this.hostOf(msg.groupId)) return error(peerId, "no-such-group", "no such group in this room");
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

      case "merge-start": {
        if (!waiting) return error(peerId, "bad-state", "only a waiting peer can bridge");
        if (msg.groups.length + msg.unattached.length === 0) return error(peerId, "bad-state", "nothing to merge");
        const hosts = msg.groups.map((g) => this.hostOf(g));
        if (hosts.some((h) => !h)) return error(peerId, "no-such-group", "no such group in this room");
        if (msg.unattached.some((id) => id === peerId || this.peers.get(id)?.status !== "unattached")) {
          return error(peerId, "no-such-peer", "no such unattached peer in this room");
        }
        if (!this.spendSignal(me, now)) return error(peerId, "too-many", "too many signals, slow down");
        return [...this.peers.values()]
          .filter((r) => r.status === "member" && msg.groups.includes(r.groupId!))
          .map((r) => ({ to: r.peerId, msg: { t: "merge-request", bridgeId: peerId } }));
      }

      case "merge-commit": {
        if (!waiting) return error(peerId, "bad-state", "only a waiting peer can bridge");
        const claimed = new Set(msg.peers);
        const whole = [...new Set(msg.groups)].flatMap((groupId) => {
          const peers = [...this.peers.values()].filter((r) => r.groupId === groupId && (r.status === "host" || r.status === "member"));
          const host = peers.find((r) => r.status === "host");
          return host && peers.every((r) => claimed.has(r.peerId)) ? [{ host, peers }] : [];
        });
        const pulled = [...claimed]
          .map((id) => this.peers.get(id))
          .filter((r): r is PeerRecord => !!r && r.peerId !== peerId && r.status === "unattached");
        if (whole.length < 2 && pulled.length === 0) return error(peerId, "bad-state", "nothing to merge");

        const term = Math.max(0, ...whole.map((g) => g.host.term)) + 1;
        this.becomeHost(me, term);
        for (const r of [...whole.flatMap((g) => g.peers), ...pulled]) {
          r.status = "member";
          r.groupId = me.groupId;
          r.term = 0;
        }
        return this.broadcast();
      }
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

  private becomeHost(r: PeerRecord, term = 1): void {
    r.status = "host";
    r.groupId = this.newId();
    r.term = term;
  }

  private hostOf(groupId: string): PeerRecord | undefined {
    return [...this.peers.values()].find((r) => r.status === "host" && r.groupId === groupId);
  }

  /** Counts one relay against the sender's window; false when over the limit. */
  private spendSignal(me: PeerRecord, now: number): boolean {
    if (now - me.signalWindow >= SIGNAL_WINDOW_MS) {
      me.signalWindow = now;
      me.signals = 0;
    }
    if (me.signals >= SIGNAL_LIMIT) return false;
    me.signals++;
    return true;
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
