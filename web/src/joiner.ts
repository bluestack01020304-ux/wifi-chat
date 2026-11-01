import type { ClientMessage, ErrorCode, RoomSnapshot } from "../../server/src/protocol";
import type { Device } from "../../server/src/roomKey";
import { commitPlan, dialTargets, MERGE_TIMEOUT_MS, mergeComplete, planAfterDial } from "./merge";

export const DIAL_TIMEOUT_MS = 5000;

/** Resolves once connected and path-checked; rejects on failure. Must close everything when `signal` aborts. */
export type Dial = (peerId: string, signal: AbortSignal) => Promise<void>;

export type View =
  | { kind: "connecting" }
  | { kind: "host"; groupId: string; members: string[]; aloneInRoom: boolean; term: number }
  | { kind: "member"; groupId: string; hostId: string; term: number }
  | { kind: "failed" };

interface Attempt {
  controllers: Map<string, AbortController>;
  timer: ReturnType<typeof setTimeout>;
  pending: number;
  reached: Set<string>;
  reportFailure: boolean;
}

interface Merge {
  groups: string[];
  unattached: string[];
  timer: ReturnType<typeof setTimeout>;
}

export interface JoinerDeps {
  send(msg: ClientMessage): void;
  dial: Dial;
  device: Device;
  /** Peers I currently hold a verified connection with. */
  linked(): ReadonlySet<string>;
  timeoutMs?: number;
  mergeTimeoutMs?: number;
  /** The server took my host role away (stalled host): close every link before rejoining. */
  onDemoted?(): void;
}

/**
 * Decides what this browser does from the server's room snapshots: dial every
 * group host and unattached peer at once, then join one group, bridge-merge
 * the ones it reached, or wait as unattached and retry when the room changes.
 */
export class Joiner {
  private peerId = "";
  private room: RoomSnapshot = { peers: [], groups: [] };
  private attempt: Attempt | null = null;
  private merge: Merge | null = null;
  private committing = false;
  private attempted = new Set<string>();
  private pendingGroup: string | null = null;
  private startedAlone = false;
  private bridgeDials = new Set<string>();
  private lastStatus: string | null = null;
  /** `${groupId}:${term}` I already confirmed, and a dial in flight to confirm a newer one. */
  private confirmed: string | null = null;
  private confirmDial: { key: string; controller: AbortController } | null = null;
  private current: View | null = null;
  private listeners: ((v: View) => void)[] = [];
  private deps: JoinerDeps;
  private timeoutMs: number;
  private mergeTimeoutMs: number;

  constructor(deps: JoinerDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? DIAL_TIMEOUT_MS;
    this.mergeTimeoutMs = deps.mergeTimeoutMs ?? MERGE_TIMEOUT_MS;
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
    const was = this.lastStatus;
    this.lastStatus = me.status;
    if (was === "host" && (me.status === "joining" || me.status === "unattached")) this.deps.onDemoted?.();
    if (me.status !== "member") this.abortConfirm();

    switch (me.status) {
      case "host": {
        this.settle();
        const group = room.groups.find((g) => g.hostId === this.peerId);
        if (group) {
          this.setView({
            kind: "host",
            groupId: group.groupId,
            members: group.members,
            aloneInRoom: room.peers.length === 1,
            term: group.term,
          });
        }
        return;
      }
      case "member": {
        this.settle();
        const group = room.groups.find((g) => g.groupId === me.groupId);
        if (group) {
          this.setView({ kind: "member", groupId: group.groupId, hostId: group.hostId, term: group.term });
          this.confirm();
        }
        return;
      }
      case "joining":
        this.setView({ kind: "connecting" });
        if (this.busy()) return;
        if (this.pendingGroup && room.groups.some((g) => g.groupId === this.pendingGroup)) return;
        this.pendingGroup = null;
        this.start(true);
        return;
      case "unattached": {
        if (!this.merge && !this.committing) this.setView({ kind: "failed" });
        if (this.busy()) return;
        if (room.groups.length === 0) {
          const earliest = room.peers.find((p) => p.status === "unattached");
          if (earliest?.peerId === this.peerId && !this.startedAlone) this.sendStartAlone();
          return;
        }
        if (dialTargets(this.peerId, room).some((id) => !this.attempted.has(id))) this.start(false);
        return;
      }
    }
  }

  /** The "따로 시작하기" button. */
  startAlone(): void {
    if (this.view.kind !== "failed" || this.startedAlone) return;
    this.sendStartAlone();
  }

  /** The server asked me (a member) to prove I can reach a bridge. */
  onMergeRequest(bridgeId: string): void {
    if (this.view.kind !== "member" || this.bridgeDials.has(bridgeId)) return;
    this.bridgeDials.add(bridgeId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const done = () => {
      clearTimeout(timer);
      this.bridgeDials.delete(bridgeId);
    };
    this.deps.dial(bridgeId, controller.signal).then(done, done);
  }

  /** A link opened or closed; a merge may now be complete. */
  onLinksChanged(): void {
    this.checkMerge();
    this.confirm();
  }

  /** A server error. The only request that can fail while I wait is a merge commit: treat it as rejected and start over. */
  onError(_code: ErrorCode): void {
    if (!this.committing) return;
    this.committing = false;
    this.attempted.clear();
    this.onRoom(this.room);
  }

  /**
   * Tells the server I reach my current host in its current term: at once if I
   * hold a link to it, otherwise after dialing it (a new host after
   * succession). A failed dial sends nothing; the server's confirm window decides.
   */
  private confirm(): void {
    const view = this.view;
    if (view.kind !== "member") return;
    const key = `${view.groupId}:${view.term}`;
    if (this.confirmed === key) return;
    if (this.deps.linked().has(view.hostId)) {
      this.abortConfirm();
      this.confirmed = key;
      this.deps.send({ t: "confirm", groupId: view.groupId, term: view.term });
      return;
    }
    if (this.confirmDial?.key === key) return;
    this.abortConfirm();
    const controller = new AbortController();
    const dial = { key, controller };
    this.confirmDial = dial;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      if (this.confirmDial !== dial) return;
      this.confirmDial = null;
      if (ok) this.confirm();
    };
    this.deps.dial(view.hostId, controller.signal).then(
      () => done(true),
      () => done(false),
    );
  }

  private abortConfirm(): void {
    this.confirmDial?.controller.abort();
    this.confirmDial = null;
  }

  private busy(): boolean {
    if (this.merge && this.mergeOvertaken(this.merge)) {
      // Someone else rebuilt the groups I was merging: start over from the current room.
      clearTimeout(this.merge.timer);
      this.merge = null;
      this.attempted.clear();
      this.start(this.myStatus() === "joining");
    }
    if (this.merge) this.checkMerge();
    return !!(this.attempt || this.merge || this.committing);
  }

  /** A planned group is gone, or a planned unattached peer settled elsewhere. */
  private mergeOvertaken(merge: Merge): boolean {
    const groupGone = merge.groups.some((id) => !this.room.groups.some((g) => g.groupId === id));
    const pulledAway = merge.unattached.some((id) => this.room.peers.find((p) => p.peerId === id)?.status !== "unattached");
    return groupGone || pulledAway;
  }

  /** I am settled in a group: drop every in-progress join state. */
  private settle(): void {
    if (this.attempt) this.endAttempt(this.attempt);
    if (this.merge) clearTimeout(this.merge.timer);
    this.merge = null;
    this.committing = false;
    this.pendingGroup = null;
    this.attempted.clear();
  }

  private sendStartAlone(): void {
    this.startedAlone = true;
    this.deps.send({ t: "start-alone" });
  }

  private start(reportFailure: boolean): void {
    const targets = dialTargets(this.peerId, this.room);
    const attempt: Attempt = {
      controllers: new Map(),
      timer: setTimeout(() => this.decide(attempt), this.timeoutMs),
      pending: targets.length,
      reached: new Set(),
      reportFailure,
    };
    this.attempt = attempt;
    if (targets.length === 0) {
      this.decide(attempt);
      return;
    }
    for (const id of targets) {
      const controller = new AbortController();
      attempt.controllers.set(id, controller);
      this.attempted.add(id);
      const settled = (ok: boolean) => {
        if (this.attempt !== attempt || controller.signal.aborted) return;
        if (ok) attempt.reached.add(id);
        if (--attempt.pending === 0) this.decide(attempt);
      };
      this.deps.dial(id, controller.signal).then(
        () => settled(true),
        () => settled(false),
      );
    }
  }

  /** Ends the dial phase, aborting dials that have not succeeded. */
  private endAttempt(attempt: Attempt): void {
    clearTimeout(attempt.timer);
    this.attempt = null;
    for (const [id, c] of attempt.controllers) if (!attempt.reached.has(id)) c.abort();
  }

  private decide(attempt: Attempt): void {
    if (this.attempt !== attempt) return;
    this.endAttempt(attempt);
    const plan = planAfterDial(this.peerId, this.deps.device, this.room, attempt.reached);
    switch (plan.kind) {
      case "none":
        this.fail(attempt.reportFailure);
        return;
      case "join":
        this.join(plan.groupId);
        return;
      case "merge":
        this.deps.send({ t: "merge-start", groups: plan.groups, unattached: plan.unattached });
        this.setView({ kind: "connecting" });
        this.merge = { groups: plan.groups, unattached: plan.unattached, timer: setTimeout(() => this.finishMerge(), this.mergeTimeoutMs) };
        this.checkMerge();
        return;
    }
  }

  private checkMerge(): void {
    if (this.merge && mergeComplete(this.room, this.merge.groups, this.deps.linked())) this.finishMerge();
  }

  private finishMerge(): void {
    const merge = this.merge;
    if (!merge) return;
    clearTimeout(merge.timer);
    this.merge = null;
    const linked = this.deps.linked();
    const commit = commitPlan(this.peerId, this.room, merge.groups, linked);
    if (commit) {
      this.committing = true;
      this.deps.send({ t: "merge-commit", ...commit });
      return;
    }
    const fallback = this.room.groups.find((g) => merge.groups.includes(g.groupId) && linked.has(g.hostId));
    if (fallback) this.join(fallback.groupId);
    else this.fail(this.myStatus() === "joining");
  }

  private join(groupId: string): void {
    this.pendingGroup = groupId;
    this.deps.send({ t: "joined", groupId });
  }

  private fail(report: boolean): void {
    if (report) this.deps.send({ t: "unattached" });
    this.setView({ kind: "failed" });
  }

  private myStatus() {
    return this.room.peers.find((p) => p.peerId === this.peerId)?.status;
  }

  private setView(v: View): void {
    if (this.current && JSON.stringify(this.current) === JSON.stringify(v)) return;
    this.current = v;
    for (const cb of this.listeners) cb(v);
  }
}
