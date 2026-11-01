import { describe, expect, it } from "vitest";
import { candidateSummary, pairCounters } from "../src/debug";

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

describe("pairCounters", () => {
  it("summarizes each candidate pair's check counters", () => {
    const stats = [
      { id: "L1", type: "local-candidate", candidateType: "host", address: "192.168.45.124", port: 5000 },
      { id: "R1", type: "remote-candidate", candidateType: "prflx", address: "192.168.45.116", port: 6000 },
      { id: "R2", type: "remote-candidate", candidateType: "host", address: "7b67-aaaa.local", port: 6001 },
      { id: "P1", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", state: "in-progress", requestsSent: 3, requestsReceived: 2, responsesReceived: 0, responsesSent: 2 },
      { id: "P2", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R2", state: "waiting", requestsSent: 0, requestsReceived: 0, responsesReceived: 0, responsesSent: 0 },
    ];
    expect(pairCounters(stats)).toBe(
      "host 192.168.45.124 ↔ prflx 192.168.45.116 in-progress req 3/2 resp 0/2; host 192.168.45.124 ↔ host 7b67….local waiting req 0/0 resp 0/0",
    );
  });

  it("says when there are no pairs", () => {
    expect(pairCounters([])).toBe("(후보 쌍 없음)");
  });
});
