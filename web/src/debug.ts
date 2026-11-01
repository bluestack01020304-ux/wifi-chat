/**
 * Connection diagnostics shown on this device's own screen when the page has
 * `?debug=1`. Nothing here is sent anywhere.
 */
export const debug = {
  enabled: false,
  lines: [] as string[],
  listeners: [] as (() => void)[],
  log(line: string): void {
    if (!this.enabled) return;
    const t = new Date();
    const stamp = `${t.getMinutes().toString().padStart(2, "0")}:${t.getSeconds().toString().padStart(2, "0")}.${Math.floor(t.getMilliseconds() / 100)}`;
    this.lines.push(`${stamp} ${line}`);
    if (this.lines.length > 60) this.lines.shift();
    for (const cb of this.listeners) cb();
  },
};

/** "host 0b3c….local udp, host 192.168.0.5 udp" for every candidate line in an SDP. */
export function candidateSummary(sdp: string): string {
  const out: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=candidate:\S+ \d+ (\S+) \d+ (\S+) \d+ typ (\S+)/.exec(line);
    if (!m) continue;
    const [, proto, addr, type] = m;
    const shown = addr.endsWith(".local") ? `${addr.slice(0, 4)}….local` : addr;
    out.push(`${type} ${shown} ${proto.toLowerCase()}`);
  }
  return out.length ? out.join(", ") : "(후보 없음)";
}

type Stat = { id: string; type: string; [k: string]: unknown };

const shortAddr = (a: unknown) => {
  const s = typeof a === "string" ? a : "?";
  return s.endsWith(".local") ? `${s.slice(0, 4)}….local` : s || "(가림)";
};

/**
 * Per candidate pair: "local ↔ remote state req sent/received resp received/sent".
 * Shows which direction of the ICE connectivity checks is getting through.
 */
export function pairCounters(stats: Iterable<Stat>): string {
  const all = [...stats];
  const byId = new Map(all.map((s) => [s.id, s]));
  const cand = (id: unknown) => {
    const c = byId.get(String(id));
    return c ? `${c.candidateType} ${shortAddr(c.address ?? c.ip)}` : "?";
  };
  const pairs = all
    .filter((s) => s.type === "candidate-pair")
    .map(
      (p) =>
        `${cand(p.localCandidateId)} ↔ ${cand(p.remoteCandidateId)} ${p.state} req ${p.requestsSent ?? 0}/${p.requestsReceived ?? 0} resp ${p.responsesReceived ?? 0}/${p.responsesSent ?? 0}`,
    );
  return pairs.length ? pairs.join("; ") : "(후보 쌍 없음)";
}
