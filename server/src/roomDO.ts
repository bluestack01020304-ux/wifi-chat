import { DurableObject } from "cloudflare:workers";
import { parseClientMessage } from "./protocol";
import { type Outgoing, type PeerRecord, RoomState } from "./room";
import { parseRoomParams } from "./roomKey";

export const MAX_PEERS = 32;
/** How often succession timeouts are checked while any host exists. */
export const TICK_MS = 1000;

/**
 * One Durable Object per room key. Uses the WebSocket Hibernation API and
 * keeps no room state in instance fields: every event rebuilds RoomState
 * from the per-socket attachments, so a hibernated object wakes up intact.
 * No room state is written to storage, and IPs never reach this object; the
 * only stored thing is the alarm that drives succession while a host exists.
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
    if (!peerId) return; // dropped socket
    const msg = parseClientMessage(data);
    if ("error" in msg) {
      safeSend(ws, { t: "error", code: msg.error, message: "invalid message" });
      return;
    }
    this.apply((state) => state.handle(peerId, msg, Date.now()));
  }

  /** Runs host timeouts and confirm windows, then keeps ticking while a host exists. */
  async alarm(): Promise<void> {
    const hasHost = this.apply((state) => state.tick(Date.now()), undefined, undefined, false);
    if (hasHost) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.drop(ws, code === 1005 || code === 1006 ? 1000 : code);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.drop(ws, 1011);
  }

  private drop(ws: WebSocket, code: number): void {
    const gone = ws.deserializeAttachment() as PeerRecord | null;
    if (!gone) return; // already dropped (error and close can both fire)
    // Tombstone first: a CLOSING socket can stay in getWebSockets(), and its
    // stale record must never be rebuilt into the room.
    ws.serializeAttachment(null);
    this.apply((state) => state.leave(gone.peerId, Date.now()), undefined, gone);
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
  private apply(event: (state: RoomState) => Outgoing[], fresh?: string, gone?: PeerRecord, schedule = true): boolean {
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
    const hasHost = state.hasHost();
    if (hasHost && schedule) void this.ensureAlarm();
    return hasHost;
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }
}

function peerIdOf(ws: WebSocket): string | null {
  return (ws.deserializeAttachment() as PeerRecord | null)?.peerId ?? null;
}

/** A peer may have closed between our read and our send; that must not throw. */
function safeSend(ws: WebSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket already closed; its close event will clean up
  }
}
