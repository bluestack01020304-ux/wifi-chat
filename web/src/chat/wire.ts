/** Chat frames on the `control` DataChannel. Nothing here ever reaches the signaling server. */

export const MAX_TEXT = 500;
export const MAX_NICK = 20;
export const MAX_FRAME = 64 * 1024;
export const MAX_HISTORY = 100;

export interface ChatMessage {
  id: string;
  from: string;
  nick: string;
  text: string;
  at: number;
}
export interface RosterEntry {
  peerId: string;
  nick: string;
  host: boolean;
  away: boolean;
}

export type ToHost = { t: "hello"; nick: string } | { t: "say"; id: string; text: string };
/** Every host → member frame carries the host's term; members drop frames from any other term. */
export type ToMember =
  | { t: "msg"; msg: ChatMessage; term: number }
  | { t: "history"; msgs: ChatMessage[]; term: number }
  | { t: "roster"; people: RosterEntry[]; term: number };

// C0 controls except "\n", DEL and C1 controls.
const CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/** Strips control characters (keeping "\n"), trims, and cuts to `max` code points. */
export function cleanText(s: string, max: number): string {
  return Array.from(s.replace(CONTROLS, "").trim()).slice(0, max).join("").trim();
}

const cleanNick = (s: string) => cleanText(s.replace(/\n/g, " "), MAX_NICK);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;

function decode(raw: unknown): Obj | null {
  if (typeof raw !== "string" || raw.length > MAX_FRAME) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = cleanText(v, MAX_TEXT);
  return s ? s : null;
}

function nick(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = cleanNick(v);
  return s ? s : null;
}

function message(v: unknown): ChatMessage | null {
  if (!isObj(v) || !isId(v.id) || !isId(v.from)) return null;
  const n = nick(v.nick);
  const t = text(v.text);
  if (n === null || t === null || typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
  return { id: v.id, from: v.from, nick: n, text: t, at: v.at };
}

function rosterEntry(v: unknown): RosterEntry | null {
  if (!isObj(v) || !isId(v.peerId) || typeof v.host !== "boolean" || typeof v.away !== "boolean") return null;
  const n = nick(v.nick);
  return n === null ? null : { peerId: v.peerId, nick: n, host: v.host, away: v.away };
}

function all<T>(v: unknown, max: number, item: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: T[] = [];
  for (const x of v) {
    const parsed = item(x);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * The history frame for a newcomer: the newest messages whose JSON fits in
 * MAX_FRAME UTF-8 bytes. The receiver checks UTF-16 length, which is never
 * larger than the UTF-8 byte count, so a frame built here always passes.
 */
export function historyFrame(msgs: ChatMessage[], term: number): string {
  const encoder = new TextEncoder();
  let start = 0;
  for (;;) {
    const frame = JSON.stringify({ t: "history", msgs: msgs.slice(start), term } satisfies ToMember);
    if (encoder.encode(frame).length <= MAX_FRAME || start >= msgs.length) return frame;
    start++;
  }
}

export function parseToHost(raw: unknown): ToHost | null {
  const v = decode(raw);
  if (!v) return null;
  if (v.t === "hello") {
    const n = nick(v.nick);
    return n === null ? null : { t: "hello", nick: n };
  }
  if (v.t === "say") {
    const t = text(v.text);
    return isId(v.id) && t !== null ? { t: "say", id: v.id, text: t } : null;
  }
  return null;
}

export function parseToMember(raw: unknown): ToMember | null {
  const v = decode(raw);
  if (!v) return null;
  const term = v.term;
  if (typeof term !== "number" || !Number.isSafeInteger(term) || term < 1) return null;
  switch (v.t) {
    case "msg": {
      const msg = message(v.msg);
      return msg ? { t: "msg", msg, term } : null;
    }
    case "history": {
      const msgs = all(v.msgs, MAX_HISTORY, message);
      return msgs ? { t: "history", msgs, term } : null;
    }
    case "roster": {
      const people = all(v.people, 64, rosterEntry);
      return people ? { t: "roster", people, term } : null;
    }
    default:
      return null;
  }
}
