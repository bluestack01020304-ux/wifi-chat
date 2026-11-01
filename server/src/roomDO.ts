import { DurableObject } from "cloudflare:workers";
import { parseClientMessage } from "./protocol";
import { type Outgoing, type PeerRecord, RoomState } from "./room";
import { parseRoomParams } from "./roomKey";

export const MAX_PEERS = 32;

/**
 * One Durable Object per room key. Uses the WebSocket Hibernation API and
 * keeps no room state in instance fields: every event rebuilds RoomState
 * from the per-socket attachments, so a hibernated object wakes up intact.
 * Nothing is written to storage, and IPs never reach this object.
 */
export class Room extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_PEERS) {
      return new Response("room is full", { status: 429 });
    }
    const params = parseRoomParams(new URL(request.url));
    if ("error" in params) return new Response(params.error, { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();
    const peerId = crypto.randomUUID();
    // Placeholder so the socket is identifiable before join() fills the record in.
    server.serializeAttachment({ peerId } as PeerRecord);
    this.ctx.acceptWebSocket(server);

    this.apply((state) => state.join(peerId, params.device, Date.now()), peerId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const peerId = peerIdOf(ws);
    const msg = parseClientMessage(data);
    if ("error" in msg) {
      safeSend(ws, { t: "error", code: msg.error, message: "invalid message" });
      return;
    }
    this.apply((state) => state.handle(peerId, msg));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.drop(ws, code === 1005 || code === 1006 ? 1000 : code);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.drop(ws, 1011);
  }

  private drop(ws: WebSocket, code: number): void {
    const gone = ws.deserializeAttachment() as PeerRecord;
    this.apply((state) => state.leave(gone.peerId), undefined, gone);
    try {
      ws.close(code, "closed");
    } catch {
      // already closed
    }
  }

  /**
   * Rebuilds state from the live sockets, applies one event, writes the
   * records back and delivers the messages.
   * `fresh` is a just-accepted socket whose attachment is still a placeholder.
   * `gone` is the record of a closing socket. The runtime has already removed
   * that socket from getWebSockets(), so its record is added here for leave()
   * to see; nothing is sent to it.
   */
  private apply(event: (state: RoomState) => Outgoing[], fresh?: string, gone?: PeerRecord): void {
    const sockets = new Map<string, WebSocket>();
    const records: PeerRecord[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const record = ws.deserializeAttachment() as PeerRecord | null;
      if (!record || record.peerId === gone?.peerId) continue;
      sockets.set(record.peerId, ws);
      if (record.peerId !== fresh) records.push(record);
    }
    if (gone) records.push(gone);

    const state = new RoomState(records, () => crypto.randomUUID());
    const out = event(state);

    for (const record of state.records()) sockets.get(record.peerId)?.serializeAttachment(record);
    for (const { to, msg } of out) {
      const ws = sockets.get(to);
      if (ws) safeSend(ws, msg);
    }
  }
}

function peerIdOf(ws: WebSocket): string {
  return (ws.deserializeAttachment() as PeerRecord).peerId;
}

/** A peer may have closed between our read and our send; that must not throw. */
function safeSend(ws: WebSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket already closed; its close event will clean up
  }
}
