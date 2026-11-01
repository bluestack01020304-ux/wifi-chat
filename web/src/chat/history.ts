import { type ChatMessage, MAX_HISTORY } from "./wire";

const byTime = (a: ChatMessage, b: ChatMessage) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The last MAX_HISTORY messages, in memory only, de-duplicated by id. */
export class History {
  private msgs: ChatMessage[] = [];
  private ids = new Set<string>();
  private listeners: (() => void)[] = [];

  add(msg: ChatMessage): boolean {
    if (!this.insert(msg)) return false;
    this.trim();
    this.changed();
    return true;
  }

  merge(msgs: ChatMessage[]): void {
    let any = false;
    for (const m of msgs) any = this.insert(m) || any;
    if (!any) return;
    this.trim();
    this.changed();
  }

  list(): ChatMessage[] {
    return [...this.msgs];
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private insert(msg: ChatMessage): boolean {
    if (this.ids.has(msg.id)) return false;
    this.ids.add(msg.id);
    this.msgs.push(msg);
    this.msgs.sort(byTime);
    return true;
  }

  private trim(): void {
    while (this.msgs.length > MAX_HISTORY) this.ids.delete(this.msgs.shift()!.id);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }
}
