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
