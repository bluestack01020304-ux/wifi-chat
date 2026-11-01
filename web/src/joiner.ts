import type { ClientMessage, GroupView, RoomSnapshot } from "../../server/src/protocol";

export const DIAL_TIMEOUT_MS = 5000;

/** Resolves once connected and path-checked; rejects on failure. Must close everything when `signal` aborts. */
export type Dial = (hostId: string, signal: AbortSignal) => Promise<void>;

export type View =
  | { kind: "connecting" }
  | { kind: "host"; groupId: string; members: string[]; aloneInRoom: boolean }
  | { kind: "member"; groupId: string; hostId: string }
  | { kind: "failed" };

interface Attempt {
  controllers: Map<string, AbortController>;
  timer: ReturnType<typeof setTimeout>;
  remaining: number;
  reportFailure: boolean;
}

/**
 * Decides what this browser does from the server's room snapshots: dial every
 * group host at once, join the first that connects, or wait as unattached and
 * retry when new hosts appear. Bridge merges come in Next Steps 3b.
 */
export class Joiner {
  private peerId = "";
  private room: RoomSnapshot = { peers: [], groups: [] };
  private attempt: Attempt | null = null;
  private attempted = new Set<string>();
  private pendingGroup: string | null = null;
  private startedAlone = false;
  private current: View | null = null;
  private listeners: ((v: View) => void)[] = [];
  private send: (msg: ClientMessage) => void;
  private dial: Dial;
  private timeoutMs: number;

  constructor(deps: { send(msg: ClientMessage): void; dial: Dial; timeoutMs?: number }) {
    this.send = deps.send;
    this.dial = deps.dial;
    this.timeoutMs = deps.timeoutMs ?? DIAL_TIMEOUT_MS;
  }

  get view(): View {
    return this.current ?? { kind: "connecting" };
  }

  onChange(cb: (v: View) => void): void {
    this.listeners.push(cb);
  }

  onWelcome(peerId: string, room: RoomSnapshot): void {
    this.peerId = peerId;
    this.onRoom(room);
  }

  onRoom(room: RoomSnapshot): void {
    this.room = room;
    const me = room.peers.find((p) => p.peerId === this.peerId);
    if (!me) return;
    if (me.status !== "unattached") this.startedAlone = false;

    switch (me.status) {
      case "host": {
        const group = room.groups.find((g) => g.hostId === this.peerId);
        this.pendingGroup = null;
        this.attempted.clear();
        if (group) {
          this.setView({ kind: "host", groupId: group.groupId, members: group.members, aloneInRoom: room.peers.length === 1 });
        }
        return;
      }
      case "member": {
        const group = room.groups.find((g) => g.groupId === me.groupId);
        this.pendingGroup = null;
        this.attempted.clear();
        if (group) this.setView({ kind: "member", groupId: group.groupId, hostId: group.hostId });
        return;
      }
      case "joining":
        this.setView({ kind: "connecting" });
        if (this.attempt) return;
        if (this.pendingGroup && room.groups.some((g) => g.groupId === this.pendingGroup)) return;
        this.pendingGroup = null;
        this.start(room.groups, true);
        return;
      case "unattached": {
        this.setView({ kind: "failed" });
        if (this.attempt) return;
        if (room.groups.length === 0) {
          const earliest = room.peers.find((p) => p.status === "unattached");
          if (earliest?.peerId === this.peerId && !this.startedAlone) this.sendStartAlone();
          return;
        }
        if (room.groups.some((g) => !this.attempted.has(g.hostId))) this.start(room.groups, false);
        return;
      }
    }
  }

  /** The "따로 시작하기" button. */
  startAlone(): void {
    if (this.view.kind !== "failed" || this.startedAlone) return;
    this.sendStartAlone();
  }

  private sendStartAlone(): void {
    this.startedAlone = true;
    this.send({ t: "start-alone" });
  }

  private start(groups: GroupView[], reportFailure: boolean): void {
    const attempt: Attempt = {
      controllers: new Map(),
      timer: setTimeout(() => this.fail(attempt), this.timeoutMs),
      remaining: groups.length,
      reportFailure,
    };
    this.attempt = attempt;
    if (groups.length === 0) {
      this.fail(attempt);
      return;
    }
    for (const g of groups) {
      const controller = new AbortController();
      attempt.controllers.set(g.hostId, controller);
      this.attempted.add(g.hostId);
      this.dial(g.hostId, controller.signal).then(
        () => this.succeed(attempt, g, controller),
        () => {
          if (this.attempt !== attempt || controller.signal.aborted) return;
          if (--attempt.remaining === 0) this.fail(attempt);
        },
      );
    }
  }

  private succeed(attempt: Attempt, group: GroupView, winner: AbortController): void {
    if (this.attempt !== attempt || winner.signal.aborted) return;
    this.finish(attempt, winner);
    this.pendingGroup = group.groupId;
    this.send({ t: "joined", groupId: group.groupId });
  }

  private fail(attempt: Attempt): void {
    if (this.attempt !== attempt) return;
    this.finish(attempt);
    if (attempt.reportFailure) this.send({ t: "unattached" });
    this.setView({ kind: "failed" });
  }

  /** Ends the attempt, aborting every dial except `keep`. */
  private finish(attempt: Attempt, keep?: AbortController): void {
    clearTimeout(attempt.timer);
    this.attempt = null;
    for (const c of attempt.controllers.values()) if (c !== keep) c.abort();
  }

  private setView(v: View): void {
    if (this.current && JSON.stringify(this.current) === JSON.stringify(v)) return;
    this.current = v;
    for (const cb of this.listeners) cb(v);
  }
}
