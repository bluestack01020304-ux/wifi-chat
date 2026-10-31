import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {}

export default {
  fetch: () => new Response("ok"),
} satisfies ExportedHandler;
