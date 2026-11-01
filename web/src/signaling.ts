import type { ClientMessage, ServerMessage } from "../../server/src/protocol";

/** JSON over one WebSocket to the signaling server. Sends made before `open` are queued. */
export class Signaling {
  private ws: WebSocket;
  private queue: string[] = [];
  private messageListeners: ((m: ServerMessage) => void)[] = [];
  private closeListeners: (() => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      for (const frame of this.queue) this.ws.send(frame);
      this.queue = [];
    });
    this.ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      let m: ServerMessage;
      try {
        m = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      for (const cb of this.messageListeners) cb(m);
    });
    this.ws.addEventListener("close", () => {
      for (const cb of this.closeListeners) cb();
    });
  }

  onMessage(cb: (m: ServerMessage) => void): void {
    this.messageListeners.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  send(m: ClientMessage): void {
    const frame = JSON.stringify(m);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(frame);
  }

  close(): void {
    this.ws.close();
  }
}
