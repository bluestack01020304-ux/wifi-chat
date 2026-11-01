import { describe, expect, it } from "vitest";
import { keepHostCandidatesOnly } from "../src/sdp";

const sdp = [
  "v=0",
  "a=candidate:1 1 udp 2113937151 abcd.local 5000 typ host generation 0",
  "a=candidate:2 1 udp 1677729535 1.2.3.4 6000 typ srflx raddr 0.0.0.0 rport 0",
  "a=candidate:3 1 udp 33562623 5.6.7.8 7000 typ relay raddr 1.2.3.4 rport 6000",
  "a=candidate:4 1 tcp 1518280447 192.168.0.5 9 typ host tcptype active",
  "a=end-of-candidates",
  "",
].join("\r\n");

describe("keepHostCandidatesOnly", () => {
  it("drops srflx and relay candidates and keeps host ones", () => {
    const out = keepHostCandidatesOnly(sdp);
    expect(out.dropped).toBe(2);
    expect(out.sdp).toContain("abcd.local 5000 typ host");
    expect(out.sdp).toContain("typ host tcptype active");
    expect(out.sdp).not.toMatch(/typ (srflx|relay)/);
  });

  it("keeps other lines and CRLF endings", () => {
    const out = keepHostCandidatesOnly(sdp);
    expect(out.sdp).toContain("a=end-of-candidates");
    expect(out.sdp.startsWith("v=0\r\n")).toBe(true);
    expect(out.sdp.endsWith("\r\n")).toBe(true);
  });

  it("matches the candidate type token exactly", () => {
    expect(keepHostCandidatesOnly("a=candidate:9 1 udp 1 hosty.local 1 typ hostx").dropped).toBe(1);
  });

  it("drops prflx candidates offered in SDP", () => {
    expect(keepHostCandidatesOnly("a=candidate:5 1 udp 1 10.0.0.2 1 typ prflx raddr 0.0.0.0 rport 0").dropped).toBe(1);
  });
});
