import type { Sdp } from "../../server/src/protocol";
import { candidateSummary, debug } from "./debug";
import { DIAL_TIMEOUT_MS } from "./joiner";
import type { Links } from "./links";
import {
  type Connection,
  newPeerConnection,
  type OnConnected,
  register,
  remoteDescription,
  verifyPath,
  waitForGathering,
  waitForOpen,
  watch,
} from "./peer";
import type { Signaling } from "./signaling";

/**
 * Answerer side: accepts offers in every state (a host from joiners, an
 * unattached peer or a bridge from anyone pulling it in). A new offer from a
 * peer replaces its in-flight one; the shared Links decides which live
 * connection survives.
 */
export function createHost(sig: Signaling, links: Links<Connection>, onConnected: OnConnected) {
  const inFlight = new Map<string, RTCPeerConnection>();

  const drop = (peerId: string, pc: RTCPeerConnection) => {
    pc.close();
    if (inFlight.get(peerId) === pc) inFlight.delete(peerId);
  };

  async function onOffer(from: string, sdp: Sdp): Promise<void> {
    if (sdp.type !== "offer") return;
    const old = inFlight.get(from);
    if (old) drop(from, old);

    const pc = newPeerConnection();
    const label = `←${from.slice(0, 4)}`;
    watch(pc, label);
    debug.log(`${label} offer, theirs: ${candidateSummary(sdp.sdp)}`);
    inFlight.set(from, pc);
    const channel = new Promise<RTCDataChannel>((resolve) => {
      pc.addEventListener("datachannel", (e) => resolve(e.channel), { once: true });
    });
    const timer = setTimeout(() => {
      if (inFlight.get(from) === pc) drop(from, pc);
    }, DIAL_TIMEOUT_MS * 2);

    try {
      await pc.setRemoteDescription(remoteDescription(sdp));
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForGathering(pc);
      if (inFlight.get(from) !== pc) return;
      sig.send({ t: "signal", to: from, sdp: { type: "answer", sdp: pc.localDescription!.sdp } });
      debug.log(`${label} answer sent, mine: ${candidateSummary(pc.localDescription!.sdp)}`);

      const dc = await channel;
      await waitForOpen(pc, dc);
      const path = await verifyPath(pc);
      debug.log(`${label} path: ${path.ok ? `${path.verdict} (${path.local} ↔ ${path.remote})` : `REJECTED ${path.reason}`}`);
      if (!path.ok || inFlight.get(from) !== pc) {
        drop(from, pc);
        return;
      }
      inFlight.delete(from);
      const conn = register(links, from, pc, dc, path, false);
      if (links.get(from) === conn) onConnected(from, conn);
    } catch (e) {
      debug.log(`${label} failed: ${e instanceof Error ? e.message : String(e)} (ice=${pc.iceConnectionState})`);
      drop(from, pc);
    } finally {
      clearTimeout(timer);
    }
  }

  return { onOffer };
}
