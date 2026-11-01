import { networkId, parseRoomParams, roomKeyString } from "./roomKey";

export { Room } from "./roomDO";

export interface Env {
  ROOMS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") return new Response("ok");
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    // Set by Cloudflare at the edge; a client-supplied value is overwritten.
    const netId = networkId(request.headers.get("CF-Connecting-IP") ?? "");
    if (!netId) return new Response("unknown source address", { status: 400 });

    const params = parseRoomParams(url);
    if ("error" in params) return new Response(params.error, { status: 400 });

    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomKeyString(netId, params)));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
