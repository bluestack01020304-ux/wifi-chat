import { describe, expect, it } from "vitest";
import { candidateSummary } from "../src/debug";

describe("candidateSummary", () => {
  it("lists each candidate as type/address/protocol, mDNS names shortened", () => {
    const sdp = [
      "v=0",
      "a=candidate:1 1 udp 2113937151 0b3c1d2e-aaaa-bbbb-cccc-1234567890ab.local 54321 typ host generation 0",
      "a=candidate:2 1 udp 2113939711 192.168.45.7 54322 typ host generation 0",
      "a=candidate:3 1 tcp 1518280447 192.168.45.7 9 typ host tcptype active",
      "",
    ].join("\r\n");
    expect(candidateSummary(sdp)).toBe("host 0b3c….local udp, host 192.168.45.7 udp, host 192.168.45.7 tcp");
  });

  it("says when there are no candidates", () => {
    expect(candidateSummary("v=0\r\n")).toBe("(후보 없음)");
  });
});
