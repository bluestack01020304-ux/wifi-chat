import type { History } from "./history";
import { type ChatMessage, parseToHost, type RosterEntry, type ToMember } from "./wire";

/** Spec: a member whose link dropped stays "잠시 자리 비움" for 30 s. */
export const AWAY_MS = 30_000;
export const SAY_LIMIT = 20;
export const SAY_WINDOW_MS = 10_000;

interface Member {
  nick: string | null; // null until hello
  away: boolean;
  awayTimer: ReturnType<typeof setTimeout> | null;
  windowStart: number;
  said: number;
}

export interface HostHubDeps {
  myId: string;
  myNick: string;
  history: History;
  send(peerId: string, frame: string): void;
  now(): number;
  newId?(): string;
}

/**
 * The host side of the star: stamps every message with the sender of the link
 * it arrived on, keeps it in history and relays it to every member.
 */
export class HostHub {
  private members = new Map<string, Member>();
  private listeners: (() => void)[] = [];
  private closed = false;

  constructor(private deps: HostHubDeps) {}

  attach(peerId: string): void {
    if (this.closed) return;
    const m = this.members.get(peerId);
    if (!m) {
      this.members.set(peerId, { nick: null, away: false, awayTimer: null, windowStart: 0, said: 0 });
      return;
    }
    if (m.awayTimer) clearTimeout(m.awayTimer);
    m.awayTimer = null;
    if (m.away) {
      m.away = false;
      this.rosterChanged();
    }
  }

  detach(peerId: string): void {
    const m = this.members.get(peerId);
    if (!m || m.away) return;
    if (m.nick === null) {
      this.members.delete(peerId);
      return;
    }
    m.away = true;
    m.awayTimer = setTimeout(() => {
      this.members.delete(peerId);
      this.rosterChanged();
    }, AWAY_MS);
    this.rosterChanged();
  }

  onFrame(peerId: string, raw: unknown): void {
    const m = this.members.get(peerId);
    if (this.closed || !m || m.away) return;
    const frame = parseToHost(raw);
    if (!frame) return;

    if (frame.t === "hello") {
      m.nick = frame.nick;
      this.sendTo(peerId, { t: "history", msgs: this.deps.history.list() });
      this.rosterChanged();
      return;
    }
    if (m.nick === null || !this.allow(m)) return;
    this.relay({ id: frame.id, from: peerId, nick: m.nick, text: frame.text, at: this.deps.now() });
  }

  /** The host's own message; `text` is already cleaned by the caller's wire rules. */
  say(text: string): void {
    if (this.closed || !text) return;
    const id = this.deps.newId?.() ?? crypto.randomUUID();
    this.relay({ id, from: this.deps.myId, nick: this.deps.myNick, text, at: this.deps.now() });
  }

  roster(): RosterEntry[] {
    const people: RosterEntry[] = [{ peerId: this.deps.myId, nick: this.deps.myNick, host: true, away: false }];
    for (const [peerId, m] of this.members) {
      if (m.nick !== null) people.push({ peerId, nick: m.nick, host: false, away: m.away });
    }
    return people;
  }

  onRoster(cb: () => void): void {
    this.listeners.push(cb);
  }

  close(): void {
    this.closed = true;
    for (const m of this.members.values()) if (m.awayTimer) clearTimeout(m.awayTimer);
    this.members.clear();
  }

  private allow(m: Member): boolean {
    const now = this.deps.now();
    if (now - m.windowStart >= SAY_WINDOW_MS) {
      m.windowStart = now;
      m.said = 0;
    }
    if (m.said >= SAY_LIMIT) return false;
    m.said++;
    return true;
  }

  private relay(msg: ChatMessage): void {
    if (!this.deps.history.add(msg)) return;
    this.broadcast({ t: "msg", msg });
  }

  private rosterChanged(): void {
    this.broadcast({ t: "roster", people: this.roster() });
    for (const cb of this.listeners) cb();
  }

  private broadcast(frame: ToMember): void {
    for (const [peerId, m] of this.members) if (m.nick !== null && !m.away) this.sendTo(peerId, frame);
  }

  private sendTo(peerId: string, frame: ToMember): void {
    this.deps.send(peerId, JSON.stringify(frame));
  }
}
