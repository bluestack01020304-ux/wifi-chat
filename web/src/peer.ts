import type { Sdp } from "../../server/src/protocol";
import type { Dial } from "./joiner";
import { checkSelectedPair, type PairResult, type StatLike } from "./pairCheck";
import { keepHostCandidatesOnly } from "./sdp";
import type { Signaling } from "./signaling";

export const GATHER_TIMEOUT_MS = 3000;

export interface Connection {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  path: Extract<PairResult, { ok: true }>;
}
export type OnConnected = (peerId: string, c: Connection) => void;

/** No STUN, no TURN: the only candidates are local (host) ones. */
export function newPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: [] });
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

/** Offerer side: dials a group host through the signaling server. */
export function createDialer(sig: Signaling, onConnected: OnConnected) {
  const pendingAnswers = new Map<string, (sdp: Sdp) => void>();
  const connections = new Map<string, Connection>();

  const dial: Dial = async (hostId, signal) => {
    const pc = newPeerConnection();
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
      const sdp = await abortable(answer, signal);
      pendingAnswers.delete(hostId);
      await pc.setRemoteDescription(remoteDescription(sdp));
      await abortable(waitForOpen(pc, dc), signal);
      const path = await verifyPath(pc);
      if (!path.ok) throw new Error(path.reason);
      if (signal.aborted) throw new Error("aborted");
      signal.removeEventListener("abort", abort);
      const conn = { pc, dc, path };
      connections.get(hostId)?.pc.close();
      connections.set(hostId, conn);
      onConnected(hostId, conn);
    } catch (e) {
      abort();
      throw e;
    }
  };

  /** Answers with no dial waiting for them (late, or never asked for) are dropped. */
  const onAnswer = (from: string, sdp: Sdp) => {
    if (sdp.type === "answer") pendingAnswers.get(from)?.(sdp);
  };

  return { dial, onAnswer, connections };
}
