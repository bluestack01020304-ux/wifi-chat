export interface Link {
  close(): void;
  dialedByMe: boolean;
}

/**
 * One live connection per remote peer, shared by the dialer and the host side.
 * Glare (both peers dialed each other): both sides keep the connection offered
 * by the lower peerId, so they agree without talking.
 */
export class Links<L extends Link> {
  private map = new Map<string, L>();
  private listeners: (() => void)[] = [];

  constructor(private myId: () => string) {}

  /** Keeps exactly one link per peer; closes the loser. Returns whether `link` was kept. */
  add(peerId: string, link: L): boolean {
    const existing = this.map.get(peerId);
    if (existing && existing !== link && existing.dialedByMe !== link.dialedByMe) {
      const canonicalDialedByMe = this.myId() < peerId;
      if (existing.dialedByMe === canonicalDialedByMe) {
        link.close();
        return false;
      }
    }
    if (existing && existing !== link) existing.close();
    this.map.set(peerId, link);
    this.changed();
    return true;
  }

  /** Forgets `link` only if it is the current one for `peerId`. */
  remove(peerId: string, link: L): void {
    if (this.map.get(peerId) !== link) return;
    this.map.delete(peerId);
    this.changed();
  }

  get(peerId: string): L | undefined {
    return this.map.get(peerId);
  }

  ids(): Set<string> {
    return new Set(this.map.keys());
  }

  close(peerIds: Iterable<string>): void {
    let any = false;
    for (const id of peerIds) {
      const link = this.map.get(id);
      if (!link) continue;
      this.map.delete(id);
      link.close();
      any = true;
    }
    if (any) this.changed();
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }
}
