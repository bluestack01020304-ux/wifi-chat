import type { Sdp } from "../../server/src/protocol";
import { candidateSummary, debug, pairCounters } from "./debug";
import type { Dial } from "./joiner";
import type { Links } from "./links";
import { checkSelectedPair, type PairResult, type StatLike } from "./pairCheck";
import { keepHostCandidatesOnly } from "./sdp";
import type { Signaling } from "./signaling";

export const GATHER_TIMEOUT_MS = 3000;

export interface Connection {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  path: Extract<PairResult, { ok: true }>;
  dialedByMe: boolean;
  close(): void;
}
export type OnConnected = (peerId: string, c: Connection) => void;

/** No STUN, no TURN: the only candidates are local (host) ones. */
export function newPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: [] });
}

/** Logs ICE and connection state changes of `pc` to the on-screen debug log (`?debug=1`). */
export function watch(pc: RTCPeerConnection, label: string): void {
  if (!debug.enabled) return;
  pc.addEventListener("iceconnectionstatechange", () => debug.log(`${label} ice=${pc.iceConnectionState}`));
  // While checking, show every second which direction of the connectivity checks gets through.
  const timer = setInterval(async () => {
    if (pc.iceConnectionState !== "checking" && pc.iceConnectionState !== "new") {
      clearInterval(timer);
      return;
    }
    try {
      const report = await pc.getStats();
      debug.log(`${label} pairs: ${pairCounters([...report.values()] as StatLike[])}`);
    } catch {
      clearInterval(timer);
    }
  }, 1000);
  pc.addEventListener("connectionstatechange", () => debug.log(`${label} conn=${pc.connectionState}`));
}

/** Non-trickle: wait until all candidates are in the local description, or give up after GATHER_TIMEOUT_MS. */
export function waitForGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export function waitForOpen(pc: RTCPeerConnection, dc: RTCDataChannel): Promise<void> {
  if (dc.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    dc.addEventListener("open", () => resolve(), { once: true });
    dc.addEventListener("close", () => reject(new Error("data channel closed")), { once: true });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") reject(new Error(`connection ${pc.connectionState}`));
    });
  });
}

export async function verifyPath(pc: RTCPeerConnection): Promise<PairResult> {
  const report = await pc.getStats();
  return checkSelectedPair([...report.values()] as StatLike[]);
}

/** Registers a verified connection; it leaves the registry by itself when it fails or closes. */
export function register(links: Links<Connection>, peerId: string, pc: RTCPeerConnection, dc: RTCDataChannel, path: Connection["path"], dialedByMe: boolean): Connection {
  const conn: Connection = { pc, dc, path, dialedByMe, close: () => pc.close() };
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") links.remove(peerId, conn);
  });
  dc.addEventListener("close", () => links.remove(peerId, conn));
  links.add(peerId, conn);
  return conn;
}

export function remoteDescription(sdp: Sdp): RTCSessionDescriptionInit {
  return { type: sdp.type, sdp: keepHostCandidatesOnly(sdp.sdp).sdp };
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    p.then(resolve, reject);
  });
}

/** Offerer side: dials a peer through the signaling server. A dial resolves once the peer is reachable, even if glare keeps the other connection. */
export function createDialer(sig: Signaling, links: Links<Connection>, onConnected: OnConnected) {
  const pendingAnswers = new Map<string, (sdp: Sdp) => void>();

  const dial: Dial = async (hostId, signal) => {
    const pc = newPeerConnection();
    const label = `→${hostId.slice(0, 4)}`;
    watch(pc, label);
    const dc = pc.createDataChannel("control");
    const abort = () => {
      pendingAnswers.delete(hostId);
      pc.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await abortable(waitForGathering(pc), signal);
      const answer = new Promise<Sdp>((resolve) => pendingAnswers.set(hostId, resolve));
      sig.send({ t: "signal", to: hostId, sdp: { type: "offer", sdp: pc.localDescription!.sdp } });
      debug.log(`${label} offer sent, mine: ${candidateSummary(pc.localDescription!.sdp)}`);
      const sdp = await abortable(answer, signal);
      debug.log(`${label} answer, theirs: ${candidateSummary(sdp.sdp)}`);
      pendingAnswers.delete(hostId);
      await pc.setRemoteDescription(remoteDescription(sdp));
      await abortable(waitForOpen(pc, dc), signal);
      const path = await verifyPath(pc);
      debug.log(`${label} path: ${path.ok ? `${path.verdict} (${path.local} ↔ ${path.remote})` : `REJECTED ${path.reason}`}`);
      if (!path.ok) throw new Error(path.reason);
      if (signal.aborted) throw new Error("aborted");
      signal.removeEventListener("abort", abort);
      const conn = register(links, hostId, pc, dc, path, true);
      if (links.get(hostId) === conn) onConnected(hostId, conn);
    } catch (e) {
      debug.log(`${label} failed: ${e instanceof Error ? e.message : String(e)} (ice=${pc.iceConnectionState})`);
      abort();
      throw e;
    }
  };

  /** Answers with no dial waiting for them (late, or never asked for) are dropped. */
  const onAnswer = (from: string, sdp: Sdp) => {
    if (sdp.type === "answer") pendingAnswers.get(from)?.(sdp);
  };

  return { dial, onAnswer };
}
