import type { Sdp } from "../../server/src/protocol";
import { DIAL_TIMEOUT_MS } from "./joiner";
import {
  type Connection,
  newPeerConnection,
  type OnConnected,
  remoteDescription,
  verifyPath,
  waitForGathering,
  waitForOpen,
} from "./peer";
import type { Signaling } from "./signaling";

/** Answerer side: a group host accepts offers, one RTCPeerConnection per remote peer. */
export function createHost(sig: Signaling, onConnected: OnConnected) {
  const connections = new Map<string, Connection>();
  const inFlight = new Map<string, RTCPeerConnection>();

  const drop = (peerId: string, pc: RTCPeerConnection) => {
    pc.close();
    if (connections.get(peerId)?.pc === pc) connections.delete(peerId);
    if (inFlight.get(peerId) === pc) inFlight.delete(peerId);
  };

  async function onOffer(from: string, sdp: Sdp): Promise<void> {
    if (sdp.type !== "offer") return;
    // A retry replaces whatever we had for this peer.
    const old = connections.get(from)?.pc ?? inFlight.get(from);
    if (old) drop(from, old);

    const pc = newPeerConnection();
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

      const dc = await channel;
      await waitForOpen(pc, dc);
      const path = await verifyPath(pc);
      if (!path.ok || inFlight.get(from) !== pc) {
        drop(from, pc);
        return;
      }
      inFlight.delete(from);
      const conn = { pc, dc, path };
      connections.set(from, conn);
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") drop(from, pc);
      });
      onConnected(from, conn);
    } catch {
      drop(from, pc);
    } finally {
      clearTimeout(timer);
    }
  }

  function closeAll(): void {
    for (const [id, c] of connections) drop(id, c.pc);
    for (const [id, pc] of inFlight) drop(id, pc);
  }

  return { onOffer, connections, closeAll };
}
