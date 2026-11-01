import type { RosterEntry } from "./wire";

/** A local system line (never relayed): built on each device from roster changes. */
export interface Note {
  at: number;
  text: string;
}

/**
 * Lines for the change from the last non-empty roster to the next one.
 * `prev === null` is the first roster after entering: nothing to announce.
 * `gapMs` is how long this device was without its host, when it measured one.
 */
export function rosterNotes(prev: RosterEntry[] | null, next: RosterEntry[], myId: string, now: number, gapMs: number | null): Note[] {
  if (!prev) return [];
  const notes: Note[] = [];
  const oldHost = prev.find((p) => p.host)?.peerId;
  const newHost = next.find((p) => p.host);
  if (newHost && oldHost !== undefined && newHost.peerId !== oldHost) {
    const gap = gapMs === null ? "" : ` (끊김 ${(gapMs / 1000).toFixed(1)}초)`;
    notes.push({ at: now, text: `호스트가 나갔어요 · ${newHost.nick}님이 이어받았어요${gap}` });
  }
  const known = new Set(prev.map((p) => p.peerId));
  for (const p of next) {
    if (known.has(p.peerId) || p.peerId === myId || (p.host && p.peerId !== oldHost)) continue;
    notes.push({ at: now, text: `${p.nick}님이 Wi-Fi에 들어왔어요` });
  }
  return notes;
}

/**
 * Everyone seen since entering, with `next`'s host as the only host. A new
 * host's roster starts with just itself and refills as members re-attach;
 * comparing against this keeps those re-attachments from reading as arrivals.
 */
export function knownRoster(prev: RosterEntry[] | null, next: RosterEntry[]): RosterEntry[] {
  const ids = new Set(next.map((p) => p.peerId));
  const gone = (prev ?? []).filter((p) => !ids.has(p.peerId)).map((p) => ({ ...p, host: false }));
  return [...next, ...gone];
}
