declare namespace Cloudflare {
  interface Env {
    ROOMS: DurableObjectNamespace<import("../src/roomDO").Room>;
  }
}
