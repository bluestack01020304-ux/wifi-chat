import type { Mode } from "../../../server/src/roomKey";
import type { History } from "./history";
import { cleanText, MAX_TEXT, parseToMember, type RosterEntry, type ToHost } from "./wire";

/**
 * The host only listens on my channel once its own copy of the room snapshot
 * arrives, which can be after my hello lands; a frame with no listener is lost.
 * So hello is re-sent until the host answers with history.
 */
export const HELLO_RETRY_MS = 1000;

export interface MemberChatDeps {
  myNick: string;
  history: History;
  /** My host's current term; frames stamped with any other term are dropped. */
  term: number;
  /** meeting: my hello carries no nickname. */
  mode: Mode;
  send(frame: string): void;
  newId(): string;
}

/**
 * The member side of the star. My own messages appear only when the host
 * relays them back, so the host's order and timestamps are the single truth.
 */
export class MemberChat {
  private people: RosterEntry[] = [];
  private listeners: (() => void)[] = [];
  private helloTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: MemberChatDeps) {}

  /** A new nickname (family only): tell the host again. */
  setNick(nick: string): void {
    if (this.deps.mode === "meeting") return;
    this.deps.myNick = nick;
    this.sendFrame({ t: "hello", nick });
  }

  open(): void {
    // Meeting rooms are anonymous even toward the host: it numbers me itself.
    const hello = () => this.sendFrame({ t: "hello", nick: this.deps.mode === "meeting" ? "익명" : this.deps.myNick });
    hello();
    this.close();
    this.helloTimer = setInterval(hello, HELLO_RETRY_MS);
  }

  /** Stops the hello retry. */
  close(): void {
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.helloTimer = null;
  }

  onFrame(raw: unknown): void {
    const frame = parseToMember(raw);
    if (!frame || frame.term !== this.deps.term) return;
    switch (frame.t) {
      case "msg":
        this.deps.history.add(frame.msg);
        return;
      case "history":
        this.close();
        this.deps.history.merge(frame.msgs);
        return;
      case "roster":
        this.people = frame.people;
        for (const cb of this.listeners) cb();
        return;
    }
  }

  say(text: string): boolean {
    const clean = cleanText(text, MAX_TEXT);
    if (!clean) return false;
    this.sendFrame({ t: "say", id: this.deps.newId(), text: clean });
    return true;
  }

  roster(): RosterEntry[] {
    return this.people;
  }

  onRoster(cb: () => void): void {
    this.listeners.push(cb);
  }

  private sendFrame(frame: ToHost): void {
    this.deps.send(JSON.stringify(frame));
  }
}
