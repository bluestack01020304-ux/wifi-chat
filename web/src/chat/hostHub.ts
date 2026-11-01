import type { History } from "./history";
import { type ChatMessage, historyFrame, MAX_NICK, parseToHost, type RosterEntry, type ToMember } from "./wire";

/** Spec: a member whose link dropped stays "잠시 자리 비움" for 30 s. */
export const AWAY_MS = 30_000;
export const SAY_LIMIT = 20;
export const SAY_WINDOW_MS = 10_000;

/** Spec 신뢰 모델: in an anonymous room everyone is shown as "익명 N", fixed while they stay. */
export const anonName = (n: number) => `익명 ${n}`;
const anonNumber = (nick: string) => Number(/^익명 (\d+)$/.exec(nick)?.[1] ?? 0);

interface Member {
  nick: string | null; // the shown nickname, numbered if taken; null until hello
  asked: string | null; // the nickname the member asked for
  away: boolean;
  awayTimer: ReturnType<typeof setTimeout> | null;
  windowStart: number;
  said: number;
}

export interface HostHubDeps {
  myId: string;
  myNick: string;
  history: History;
  /** The group's current term, stamped on every frame. */
  term: number;
  /** Everyone is "익명 N" and hello nicknames are ignored. */
  anonymous: boolean;
  /** The last roster I saw as a member: names carry over when I take the group over. */
  seed?: RosterEntry[];
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
  /** My shown name. */
  private myName: string;
  /** Names from the seed, reserved for those peers until they say hello. */
  private seeded = new Map<string, string>();
  /** Next "익명 N" number; numbers are never reused while this group lives. */
  private nextAnon = 0;

  constructor(private deps: HostHubDeps) {
    const seed = deps.seed ?? [];
    const mine = seed.find((p) => p.peerId === deps.myId)?.nick;
    // The previous host is gone (or rejoins under a fresh name), so its name is not reserved.
    for (const p of seed) if (p.peerId !== deps.myId && !p.host) this.seeded.set(p.peerId, p.nick);
    if (deps.anonymous) {
      // A number already on screen (roster or history) belongs to someone: never hand it out again.
      const used = [...seed.map((p) => p.nick), ...deps.history.list().map((m) => m.nick)].map(anonNumber);
      let next = Math.max(0, ...used) + 1;
      this.myName = mine && anonNumber(mine) > 0 ? mine : anonName(next++);
      this.nextAnon = Math.max(next, anonNumber(this.myName) + 1);
    } else {
      this.myName = mine ?? deps.myNick;
    }
  }

  /** A new nickname for me (nickname rooms only). */
  setMyNick(nick: string): void {
    if (this.closed || this.deps.anonymous) return;
    this.myName = this.uniqueNick(this.deps.myId, nick);
    this.rosterChanged();
  }

  attach(peerId: string): void {
    if (this.closed) return;
    const m = this.members.get(peerId);
    if (!m) {
      this.members.set(peerId, { nick: null, asked: null, away: false, awayTimer: null, windowStart: 0, said: 0 });
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

    // hello and say share one budget: a repeated hello costs a full history and a roster broadcast.
    if (!this.allow(m)) return;
    if (frame.t === "hello") {
      let changed = false;
      if (this.deps.anonymous) {
        if (m.nick === null) {
          m.nick = this.claimSeed(peerId) ?? anonName(this.nextAnon++);
          changed = true;
        }
      } else if (m.asked !== frame.nick) {
        const first = m.asked === null;
        m.asked = frame.nick;
        m.nick = (first ? this.claimSeed(peerId) : null) ?? this.uniqueNick(peerId, frame.nick);
        changed = true;
      }
      this.deps.send(peerId, historyFrame(this.deps.history.list(), this.deps.term));
      if (changed) this.rosterChanged();
      else this.sendTo(peerId, { t: "roster", people: this.roster(), term: this.deps.term });
      return;
    }
    if (m.nick === null) return;
    this.relay({ id: frame.id, from: peerId, nick: m.nick, text: frame.text, at: this.deps.now() });
  }

  /** The host's own message; `text` is already cleaned by the caller's wire rules. */
  say(text: string): void {
    if (this.closed || !text) return;
    const id = this.deps.newId?.() ?? crypto.randomUUID();
    this.relay({ id, from: this.deps.myId, nick: this.myName, text, at: this.deps.now() });
  }

  roster(): RosterEntry[] {
    const people: RosterEntry[] = [{ peerId: this.deps.myId, nick: this.myName, host: true, away: false }];
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

  /** The seeded name for `peerId`, if it has one that nobody else shows now. */
  private claimSeed(peerId: string): string | null {
    const name = this.seeded.get(peerId);
    this.seeded.delete(peerId);
    if (name === undefined || this.taken(peerId).has(name)) return null;
    return name;
  }

  /** Names shown by everyone but `peerId`, plus names reserved for seeded peers. */
  private taken(peerId: string): Set<string> {
    const taken = new Set<string>(this.seeded.values());
    if (peerId !== this.deps.myId) taken.add(this.myName);
    for (const [id, other] of this.members) if (id !== peerId && other.nick !== null) taken.add(other.nick);
    return taken;
  }

  /** `asked`, or `asked` with " 2", " 3"… when the host or another member already shows it. */
  private uniqueNick(peerId: string, asked: string): string {
    const taken = this.taken(peerId);
    if (!taken.has(asked)) return asked;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const base = Array.from(asked).slice(0, MAX_NICK - suffix.length).join("").trimEnd();
      if (!taken.has(base + suffix)) return base + suffix;
    }
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
    this.broadcast({ t: "msg", msg, term: this.deps.term });
  }

  private rosterChanged(): void {
    this.broadcast({ t: "roster", people: this.roster(), term: this.deps.term });
    for (const cb of this.listeners) cb();
  }

  private broadcast(frame: ToMember): void {
    for (const [peerId, m] of this.members) if (m.nick !== null && !m.away) this.sendTo(peerId, frame);
  }

  private sendTo(peerId: string, frame: ToMember): void {
    this.deps.send(peerId, JSON.stringify(frame));
  }
}
