export type PairVerdict = "host" | "prflx-lan" | "prflx-hidden";
export type StatLike = { id: string; type: string; [k: string]: unknown };
export type PairResult =
  | { ok: true; verdict: PairVerdict; local: string; remote: string }
  | { ok: false; reason: string };

function ipv4Lan(a: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((o) => Number(o) > 255)) return false;
  return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
}

function ipv6Lan(a: string): boolean {
  if (!a.includes(":")) return false;
  const first = /^([0-9a-f]{1,4}):/i.exec(a);
  if (!first) return false;
  const v = parseInt(first[1].padStart(4, "0"), 16);
  return (v & 0xffc0) === 0xfe80 /* fe80::/10 */ || (v & 0xfe00) === 0xfc00 /* fc00::/7 */;
}

/** Private, link-local or ULA address, or an mDNS `.local` name. */
export function isLanAddress(addr: string): boolean {
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/i.test(addr)) return true;
  return ipv4Lan(addr) || ipv6Lan(addr);
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const describe = (c: StatLike) => `${str(c.candidateType)} ${str(c.address) || str(c.ip)}:${String(c.port ?? "?")} ${str(c.protocol)}`;

/**
 * Applies the spec's path rule to a getStats() report: local must be host;
 * remote must be host, or prflx on a LAN address (or one the browser hides).
 */
export function checkSelectedPair(stats: Iterable<StatLike>): PairResult {
  const byId = new Map<string, StatLike>();
  for (const s of stats) byId.set(s.id, s);

  let pair: StatLike | undefined;
  for (const s of byId.values()) {
    if (s.type === "transport" && typeof s.selectedCandidatePairId === "string") pair = byId.get(s.selectedCandidatePairId);
  }
  if (!pair) {
    pair = [...byId.values()].find((s) => s.type === "candidate-pair" && s.nominated === true && s.state === "succeeded");
  }
  if (!pair) return { ok: false, reason: "no selected candidate pair" };

  const local = byId.get(str(pair.localCandidateId));
  const remote = byId.get(str(pair.remoteCandidateId));
  if (!local || !remote) return { ok: false, reason: "selected pair has no candidates" };

  const summary = { local: describe(local), remote: describe(remote) };
  if (local.candidateType !== "host") return { ok: false, reason: `local candidate is ${str(local.candidateType)}` };

  if (remote.candidateType === "host") return { ok: true, verdict: "host", ...summary };
  if (remote.candidateType === "prflx") {
    const addr = str(remote.address) || str(remote.ip);
    if (!addr) return { ok: true, verdict: "prflx-hidden", ...summary };
    if (isLanAddress(addr)) return { ok: true, verdict: "prflx-lan", ...summary };
  }
  return { ok: false, reason: `remote path is ${summary.remote}` };
}
