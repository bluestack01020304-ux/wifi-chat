import type { View } from "../joiner";
import type { History } from "./history";
import { HostHub } from "./hostHub";
import { MemberChat } from "./memberChat";
import { cleanText, MAX_TEXT, type RosterEntry } from "./wire";

/** What the session needs from a link: its open `control` DataChannel. */
export interface ChannelLike {
  readyState: string;
  send(data: string): void;
  addEventListener(type: "message" | "close", cb: (e: { data?: unknown }) => void): void;
}

export interface ChatSessionDeps {
  myNick: string;
  history: History;
  channel(peerId: string): ChannelLike | undefined;
  myId(): string;
  now(): number;
  newId(): string;
}

const isOpen = (ch: ChannelLike | undefined): ch is ChannelLike => !!ch && ch.readyState === "open";

/**
 * Runs the chat role my view calls for: a HostHub over my members' channels,
 * or a MemberChat over my host's channel. History outlives every role change.
 * Listeners on a channel stay forever, so each one checks that it still
 * belongs to the current role and channel before doing anything.
 */
export class ChatSession {
  private hub: HostHub | null = null;
  private attached = new Map<string, ChannelLike>();
  private member: { chat: MemberChat; hostId: string; channel: ChannelLike } | null = null;
  private listeners: (() => void)[] = [];

  constructor(private deps: ChatSessionDeps) {}

  update(view: View): void {
    if (view.kind === "host") {
      this.dropMember();
      this.updateHost(view.members);
    } else if (view.kind === "member") {
      this.dropHub();
      this.updateMember(view.hostId);
    } else {
      this.dropHub();
      this.dropMember();
    }
  }

  say(text: string): boolean {
    if (this.hub) {
      const clean = cleanText(text, MAX_TEXT);
      if (!clean) return false;
      this.hub.say(clean);
      return true;
    }
    return this.member?.chat.say(text) ?? false;
  }

  canSend(): boolean {
    return !!this.hub || !!this.member;
  }

  roster(): RosterEntry[] {
    return this.hub?.roster() ?? this.member?.chat.roster() ?? [];
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private updateHost(members: string[]): void {
    if (!this.hub) {
      const hub = new HostHub({
        myId: this.deps.myId(),
        myNick: this.deps.myNick,
        history: this.deps.history,
        now: this.deps.now,
        newId: this.deps.newId,
        send: (peerId, frame) => {
          const ch = this.attached.get(peerId);
          if (this.hub === hub && isOpen(ch)) ch.send(frame);
        },
      });
      hub.onRoster(() => this.changed());
      this.hub = hub;
      this.changed();
    }
    const hub = this.hub;
    const wanted = new Set(members);

    for (const [peerId, ch] of this.attached) {
      if (!wanted.has(peerId) || this.deps.channel(peerId) !== ch || !isOpen(ch)) {
        this.attached.delete(peerId);
        hub.detach(peerId);
      }
    }
    for (const peerId of members) {
      const ch = this.deps.channel(peerId);
      if (!isOpen(ch) || this.attached.get(peerId) === ch) continue;
      this.attached.set(peerId, ch);
      hub.attach(peerId);
      const current = () => this.hub === hub && this.attached.get(peerId) === ch;
      ch.addEventListener("message", (e) => {
        if (current()) hub.onFrame(peerId, e.data);
      });
      ch.addEventListener("close", () => {
        if (!current()) return;
        this.attached.delete(peerId);
        hub.detach(peerId);
      });
    }
  }

  private updateMember(hostId: string): void {
    const ch = this.deps.channel(hostId);
    if (this.member && this.member.hostId === hostId && this.member.channel === ch && isOpen(ch)) return;
    this.dropMember();
    if (!isOpen(ch)) return;

    const chat = new MemberChat({
      myNick: this.deps.myNick,
      history: this.deps.history,
      newId: this.deps.newId,
      send: (frame) => {
        if (this.member?.chat === chat && isOpen(ch)) ch.send(frame);
      },
    });
    const entry = { chat, hostId, channel: ch };
    this.member = entry;
    chat.onRoster(() => this.changed());
    ch.addEventListener("message", (e) => {
      if (this.member === entry) chat.onFrame(e.data);
    });
    ch.addEventListener("close", () => {
      if (this.member !== entry) return;
      this.member = null;
      this.changed();
    });
    chat.open();
    this.changed();
  }

  private dropHub(): void {
    if (!this.hub) return;
    this.hub.close();
    this.hub = null;
    this.attached.clear();
    this.changed();
  }

  private dropMember(): void {
    if (!this.member) return;
    this.member = null;
    this.changed();
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }
}
