import { describe, expect, it } from "vitest";
import { checkSelectedPair, isLanAddress, type StatLike } from "../src/pairCheck";

describe("isLanAddress", () => {
  it.each(["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.9", "169.254.3.3",
    "fe80::1", "febf::1", "fc00::1", "fdab::9", "FE80::1", "x-y.local"])("%s is LAN", (a) => {
    expect(isLanAddress(a)).toBe(true);
  });
  it.each(["172.15.0.1", "172.32.0.1", "8.8.8.8", "11.0.0.1", "fec0::1", "2001:db8::1",
    "fd", "local", "", "192.168.1"])("%s is not LAN", (a) => {
    expect(isLanAddress(a)).toBe(false);
  });
});

function stats(localType: string, localAddr: string, remoteType: string, remoteAddr: string, withTransport = true): StatLike[] {
  const out: StatLike[] = [
    { id: "p", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", nominated: true, state: "succeeded" },
    { id: "L", type: "local-candidate", candidateType: localType, address: localAddr, port: 5000, protocol: "udp" },
    { id: "R", type: "remote-candidate", candidateType: remoteType, address: remoteAddr, port: 6000, protocol: "udp" },
  ];
  if (withTransport) out.push({ id: "t", type: "transport", selectedCandidatePairId: "p" });
  return out;
}
const check = (lt: string, la: string, rt: string, ra: string) => checkSelectedPair(stats(lt, la, rt, ra));

describe("checkSelectedPair", () => {
  it("accepts host to host", () => {
    expect(check("host", "192.168.0.5", "host", "abcd.local")).toEqual({
      ok: true, verdict: "host", local: "host 192.168.0.5:5000 udp", remote: "host abcd.local:6000 udp",
    });
  });
  it("accepts LAN prflx", () => {
    expect(check("host", "192.168.0.5", "prflx", "192.168.0.7")).toMatchObject({ ok: true, verdict: "prflx-lan" });
  });
  it("accepts prflx whose address the browser hides", () => {
    expect(check("host", "192.168.0.5", "prflx", "")).toMatchObject({ ok: true, verdict: "prflx-hidden" });
  });
  it("rejects public prflx, srflx, relay and non-host local", () => {
    expect(check("host", "192.168.0.5", "prflx", "8.8.8.8")).toMatchObject({ ok: false });
    expect(check("host", "192.168.0.5", "srflx", "1.2.3.4")).toMatchObject({ ok: false });
    expect(check("host", "192.168.0.5", "relay", "5.6.7.8")).toMatchObject({ ok: false });
    expect(check("srflx", "1.2.3.4", "host", "x.local")).toMatchObject({ ok: false });
  });
  it("fails when there is no selected pair", () => {
    expect(checkSelectedPair([])).toMatchObject({ ok: false });
  });
  it("falls back to the nominated succeeded pair", () => {
    expect(checkSelectedPair(stats("host", "10.0.0.2", "host", "a.local", false))).toMatchObject({ ok: true, verdict: "host" });
  });
  it("reads ip when address is missing", () => {
    const s = stats("host", "", "host", "");
    (s[1] as Record<string, unknown>).ip = "10.0.0.2";
    delete (s[1] as Record<string, unknown>).address;
    expect(checkSelectedPair(s)).toMatchObject({ ok: true, local: "host 10.0.0.2:5000 udp" });
  });
});
