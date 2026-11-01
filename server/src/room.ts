import type { ClientMessage, ErrorCode, GroupView, PeerStatus, RoomSnapshot, ServerMessage } from "./protocol";
import type { Device } from "./roomKey";

/**
 * One connected peer. `term` is the group's term on host records, 0 otherwise.
 * `signalWindow`/`signals` rate-limit SDP relays from this peer.
 * Host records also carry `lastBeat` (last heartbeat), `windowEnd` (end of an
 * open confirm window after a host change, 0 if none) and `tried` (peers
 * already tried as host in this succession chain). Member records carry
 * `confirmedTerm`, the last term they confirmed reaching their host in.
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
  lastBeat: number;
  windowEnd: number;
  tried: string[];
  confirmedTerm: number;
}

/** Spec: a host with no heartbeat for 2 s is replaced. */
export const HOST_TIMEOUT_MS = 2000;
/** Spec: members that reach the new host within 5 s stay in the group. */
export const CONFIRM_WINDOW_MS = 5000;

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
 *
 * Succession: a host that leaves, or sends no heartbeat for HOST_TIMEOUT_MS,
 * is replaced by the best untried member (desktop first, then earliest) with
 * term + 1; a still-connected old host is demoted to `joining`. Members then
 * have CONFIRM_WINDOW_MS to confirm the new term. If nobody did, the next
 * candidate is tried; if somebody did, the rest rejoin from scratch. With no
 * candidate left the group dissolves.
 */
export class RoomState {
  private peers = new Map<string, PeerRecord>();

  constructor(records: PeerRecord[], private newId: () => string) {
    for (const r of records) {
      // Records written before succession existed lack the new fields.
      this.peers.set(r.peerId, {
        ...r,
        lastBeat: r.lastBeat ?? 0,
        windowEnd: r.windowEnd ?? 0,
        tried: r.tried ?? (r.status === "host" ? [r.peerId] : []),
        confirmedTerm: r.confirmedTerm ?? 0,
      });
    }
  }

  get size(): number {
    return this.peers.size;
  }

  records(): PeerRecord[] {
    return [...this.peers.values()].map((r) => ({ ...r, tried: [...r.tried] }));
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
    const record: PeerRecord = {
      peerId, device, status: "joining", groupId: null, term: 0, joinedAt: now, signalWindow: now, signals: 0,
      lastBeat: 0, windowEnd: 0, tried: [], confirmedTerm: 0,
    };
    this.peers.set(peerId, record);
    if (!hasHost) this.becomeHost(record, now);

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
        this.becomeHost(me, now);
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
        this.becomeHost(me, now, term);
        for (const r of [...whole.flatMap((g) => g.peers), ...pulled]) {
          r.status = "member";
          r.groupId = me.groupId;
          r.term = 0;
        }
        return this.broadcast();
      }

      case "heartbeat":
        if (me.status === "host" && this.spendSignal(me, now)) me.lastBeat = now;
        return [];

      case "confirm": {
        const host = this.hostOf(msg.groupId);
        if (me.status === "member" && me.groupId === msg.groupId && host?.term === msg.term) me.confirmedTerm = msg.term;
        return [];
      }
    }
  }

  hasHost(): boolean {
    return [...this.peers.values()].some((r) => r.status === "host");
  }

  /** Runs host timeouts and confirm-window ends. Returns a room broadcast if anything changed. */
  tick(now: number): Outgoing[] {
    let changed = false;
    for (const host of [...this.peers.values()].filter((r) => r.status === "host")) {
      if (now - host.lastBeat > HOST_TIMEOUT_MS) {
        const { groupId, term, tried } = host;
        this.demote(host);
        this.succeed(groupId!, term, tried, now);
        changed = true;
      } else if (host.windowEnd > 0 && now >= host.windowEnd) {
        this.endWindow(host, now);
        changed = true;
      }
    }
    return changed ? this.broadcast() : [];
  }

  leave(peerId: string, now: number = Date.now()): Outgoing[] {
    const me = this.peers.get(peerId);
    if (!me) return [];
    this.peers.delete(peerId);
    if (me.status === "host") this.succeed(me.groupId!, me.term, me.tried, now);
    return this.broadcast();
  }

  /** Hands group `groupId` (whose host is already gone or demoted) to its best untried member, or dissolves it. */
  private succeed(groupId: string, term: number, tried: string[], now: number): void {
    const members = this.membersOf(groupId);
    const next = members
      .filter((r) => !tried.includes(r.peerId))
      .sort((a, b) => Number(b.device === "desktop") - Number(a.device === "desktop") || a.joinedAt - b.joinedAt)[0];
    if (!next) {
      for (const r of members) this.demote(r);
      return;
    }
    next.status = "host";
    next.term = term + 1;
    next.lastBeat = now;
    next.tried = [...tried, next.peerId];
    next.windowEnd = members.length > 1 ? now + CONFIRM_WINDOW_MS : 0;
  }

  private endWindow(host: PeerRecord, now: number): void {
    host.windowEnd = 0;
    const members = this.membersOf(host.groupId!);
    if (members.length === 0) return;
    const confirmed = members.filter((r) => r.confirmedTerm === host.term);
    if (confirmed.length === 0) {
      // Nobody reached this host: try the next candidate.
      const { groupId, term, tried } = host;
      this.demote(host);
      this.succeed(groupId!, term, tried, now);
      return;
    }
    for (const r of members) if (r.confirmedTerm !== host.term) this.demote(r);
  }

  /** Back to the start of the join flow. */
  private demote(r: PeerRecord): void {
    r.status = "joining";
    r.groupId = null;
    r.term = 0;
    r.windowEnd = 0;
    r.tried = [];
  }

  private membersOf(groupId: string): PeerRecord[] {
    return [...this.peers.values()].filter((r) => r.status === "member" && r.groupId === groupId);
  }

  private becomeHost(r: PeerRecord, now: number, term = 1): void {
    r.status = "host";
    r.groupId = this.newId();
    r.term = term;
    r.lastBeat = now;
    r.windowEnd = 0;
    r.tried = [r.peerId];
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
