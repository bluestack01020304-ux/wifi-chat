import type { History } from "./history";
import { cleanText, MAX_TEXT, parseToMember, type RosterEntry, type ToHost } from "./wire";

export interface MemberChatDeps {
  myNick: string;
  history: History;
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

  constructor(private deps: MemberChatDeps) {}

  open(): void {
    this.sendFrame({ t: "hello", nick: this.deps.myNick });
  }

  onFrame(raw: unknown): void {
    const frame = parseToMember(raw);
    if (!frame) return;
    switch (frame.t) {
      case "msg":
        this.deps.history.add(frame.msg);
        return;
      case "history":
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
