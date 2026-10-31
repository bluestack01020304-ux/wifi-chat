# Signaling Server (Next Steps 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browsers open one WebSocket to a Cloudflare Worker, get placed in a room keyed by their source network, see the room's group list, and exchange non-trickle SDP with each other through the server — replacing the spike's copy-paste.

**Architecture:** A Worker (`server/src/index.ts`) validates the URL, computes the room key from `CF-Connecting-IP` + room + mode + meeting key, and forwards the WebSocket upgrade to one Durable Object per room key (`Room`). The DO uses the WebSocket Hibernation API and keeps **no in-memory state**: every event rebuilds a pure `RoomState` from the per-socket attachments, applies the event, writes attachments back, and sends the resulting messages. All room logic lives in `RoomState` and is unit-tested without Cloudflare APIs.

**Tech Stack:** TypeScript, Cloudflare Workers + SQLite-backed Durable Objects (free tier), wrangler, vitest + `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/designs/wifi-chat.md` (sections 방 키, 연결 설정, 호스트 선출과 그룹; Next Steps 2)

## Scope

In: WebSocket connect, room key, group list (create on empty room, join, unattached, "따로 시작하기", leave), SDP relay, room size cap, deploy, IPv4-only hostname check.

Out (later plans): **다리 합치기 / 미연결 기기 끌어오기 server messages** (Next Steps 3), **heartbeat, term bump, 강등, 승계** (Next Steps 5 — until then, when a host leaves its group is dissolved and members become `unattached`), browser client (Next Steps 3), CI deploy.

## Global Constraints

- Messages never pass through the server; it relays only SDP (`{type, sdp}`) and room membership.
- IPs live only in memory/attachments for the life of a connection; never `console.log` an IP or room key; no storage writes.
- 방 키 = (출발지 네트워크 식별자, 방 이름, 모드[, 회의 토큰]). IPv4 → the address; IPv6 → its /64 prefix; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) → the IPv4 address.
- Defaults: `room=기본`, `mode=family`. 회의 모드 requires `key` = 128-bit random, base64url, regex `^[A-Za-z0-9_-]{22}$`. 가족 모드 ignores `key`.
- Room name: `normalize("NFC").trim()`, 1–40 code points after trimming; empty/missing → `기본`.
- `device` query param: `desktop` | `mobile`, default `mobile`.
- Limits: max 32 peers per room key (`MAX_PEERS = 32`); max client message 32768 chars (`MAX_MESSAGE = 32768`).
- Durable Object class `Room`, binding `ROOMS`, migration `new_sqlite_classes: ["Room"]`, worker name `wifi-chat-signal`.
- Never log message bodies.

## Protocol (shared by all tasks)

Endpoint: `GET /ws?room=&mode=&key=&device=` with `Upgrade: websocket`. `GET /` → `200 ok`.

Client → server (JSON text frames):
| `t` | fields | meaning |
|---|---|---|
| `signal` | `to: string`, `sdp: {type: "offer"\|"answer", sdp: string}` | forward SDP to `to` |
| `joined` | `groupId: string` | "I connected to this group's host" → become member |
| `unattached` | — | "I reached no host" → wait as unattached |
| `start-alone` | — | "따로 시작하기" → host a new group |

Server → client:
| `t` | fields |
|---|---|
| `welcome` | `peerId`, `room: RoomSnapshot` |
| `room` | `room: RoomSnapshot` (sent to everyone on any membership change) |
| `signal` | `from: string`, `sdp` |
| `error` | `code: ErrorCode`, `message: string` |

```ts
type PeerStatus = "host" | "member" | "joining" | "unattached";
type ErrorCode = "bad-json" | "bad-message" | "too-large" | "no-such-peer" | "no-such-group" | "bad-state";
interface PeerView { peerId: string; device: "desktop" | "mobile"; status: PeerStatus; groupId: string | null }
interface GroupView { groupId: string; hostId: string; term: number; members: string[] } // members excludes host
interface RoomSnapshot { peers: PeerView[]; groups: GroupView[] }
```

---

### Task 1: Scaffold + room key

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/wrangler.jsonc`, `server/vitest.config.ts`, `server/.gitignore` (`node_modules`, `.wrangler`)
- Create: `server/src/roomKey.ts`
- Test: `server/test/roomKey.test.ts`

**Interfaces:**
- Produces:
  - `networkId(ip: string): string | null` — `null` for unparsable input.
  - `type RoomParams = { room: string; mode: "family" | "meeting"; key: string | null; device: "desktop" | "mobile" }`
  - `parseRoomParams(url: URL): RoomParams | { error: string }`
  - `roomKeyString(netId: string, p: RoomParams): string` — `JSON.stringify([netId, p.mode, p.room, p.key])` (JSON, not a delimiter, so room names can't collide).

- [ ] **Step 1: Scaffold.** `cd server && npm init -y && npm i -D wrangler @cloudflare/vitest-pool-workers vitest typescript @cloudflare/workers-types`. Scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, `"dev": "wrangler dev"`, `"deploy": "wrangler deploy"`. `wrangler.jsonc`: `name`, `main: "src/index.ts"`, `compatibility_date` = newest date the installed wrangler accepts (≤ today), DO binding + migration from Global Constraints. Configure vitest with the workers pool per the installed `@cloudflare/vitest-pool-workers` README, pointing at `wrangler.jsonc`. Stub `src/index.ts` exporting `default { fetch: () => new Response("ok") }` and an empty `Room` DO class so wrangler config validates.

- [ ] **Step 2: Write failing tests** in `roomKey.test.ts`:

```ts
expect(networkId("203.0.113.5")).toBe("203.0.113.5");
expect(networkId("::ffff:203.0.113.5")).toBe("203.0.113.5");
expect(networkId("2001:db8:abcd:12::1")).toBe("2001:0db8:abcd:0012::/64");
expect(networkId("2001:db8:abcd:12:ffff::9")).toBe("2001:0db8:abcd:0012::/64"); // same /64
expect(networkId("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
expect(networkId("not-an-ip")).toBeNull();

const p = (q: string) => parseRoomParams(new URL("https://x/ws" + q));
expect(p("")).toEqual({ room: "기본", mode: "family", key: null, device: "mobile" });
expect(p("?room=%20%EA%B1%B0%EC%8B%A4%20&device=desktop")).toEqual({ room: "거실", mode: "family", key: null, device: "desktop" });
expect(p("?mode=family&key=AAAAAAAAAAAAAAAAAAAAAA").key).toBeNull();
expect(p("?mode=meeting&key=AAAAAAAAAAAAAAAAAAAAAA")).toMatchObject({ mode: "meeting", key: "AAAAAAAAAAAAAAAAAAAAAA" });
expect(p("?mode=meeting")).toHaveProperty("error");
expect(p("?mode=meeting&key=short")).toHaveProperty("error");
expect(p("?mode=party")).toHaveProperty("error");
expect(p("?device=tv")).toHaveProperty("error");
expect(p("?room=" + "가".repeat(41))).toHaveProperty("error");
expect(p("?room=" + "가".repeat(40))).not.toHaveProperty("error");
expect(p("?room=" + encodeURIComponent("거실".normalize("NFD")))).toMatchObject({ room: "거실" }); // Review Focus 4

expect(roomKeyString("1.2.3.4", { room: "a|b", mode: "family", key: null, device: "mobile" }))
  .not.toBe(roomKeyString("1.2.3.4", { room: "a", mode: "family", key: "b", device: "mobile" }));
// device is not part of the key
const base = { room: "거실", mode: "family", key: null } as const;
expect(roomKeyString("1.2.3.4", { ...base, device: "desktop" })).toBe(roomKeyString("1.2.3.4", { ...base, device: "mobile" }));
```

- [ ] **Step 3: Run** `npm test -- roomKey` → FAIL (module missing).
- [ ] **Step 4: Implement** `roomKey.ts`. IPv6 parsing: expand `::`, require 8 hextets of 1–4 hex digits, pad to 4, lowercase, keep the first 4; handle embedded IPv4 tail only for the `::ffff:` mapped form. No regex-only shortcut that accepts `1.2.3.999`.
- [ ] **Step 5: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `git add server && git commit -m "Add signaling server scaffold and room key"`

---

### Task 2: Protocol parsing

**Files:**
- Create: `server/src/protocol.ts` (types from the Protocol section + parser)
- Test: `server/test/protocol.test.ts`

**Interfaces:**
- Produces: all Protocol types above, `ClientMessage` (discriminated union on `t`), `ServerMessage`, `MAX_MESSAGE`, and
  `parseClientMessage(raw: string | ArrayBuffer): ClientMessage | { error: ErrorCode }`.

- [ ] **Step 1: Write failing tests:**

```ts
expect(parseClientMessage('{"t":"unattached"}')).toEqual({ t: "unattached" });
expect(parseClientMessage('{"t":"start-alone","extra":1}')).toEqual({ t: "start-alone" }); // unknown fields dropped
expect(parseClientMessage('{"t":"joined","groupId":"g1"}')).toEqual({ t: "joined", groupId: "g1" });
expect(parseClientMessage(JSON.stringify({ t: "signal", to: "p2", sdp: { type: "offer", sdp: "v=0" } })))
  .toEqual({ t: "signal", to: "p2", sdp: { type: "offer", sdp: "v=0" } });
expect(parseClientMessage("nope")).toEqual({ error: "bad-json" });
expect(parseClientMessage("[]")).toEqual({ error: "bad-message" });
expect(parseClientMessage('{"t":"signal","to":"p2","sdp":{"type":"pranswer","sdp":"x"}}')).toEqual({ error: "bad-message" });
expect(parseClientMessage('{"t":"signal","to":5,"sdp":{"type":"offer","sdp":"x"}}')).toEqual({ error: "bad-message" });
expect(parseClientMessage('{"t":"joined"}')).toEqual({ error: "bad-message" });
expect(parseClientMessage('{"t":"hack"}')).toEqual({ error: "bad-message" });
expect(parseClientMessage("x".repeat(MAX_MESSAGE + 1))).toEqual({ error: "too-large" });
expect(parseClientMessage(new ArrayBuffer(4))).toEqual({ error: "bad-message" }); // binary frames rejected
```

- [ ] **Step 2: Run** `npm test -- protocol` → FAIL.
- [ ] **Step 3: Implement** `parseClientMessage`; size check before `JSON.parse`; rebuild the returned object from validated fields only.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add signaling protocol parser"`

---

### Task 3: RoomState (pure room logic)

**Files:**
- Create: `server/src/room.ts`
- Test: `server/test/room.test.ts`

**Interfaces:**
- Consumes: Protocol types, `ClientMessage` (Task 2).
- Produces:

```ts
interface PeerRecord { peerId: string; device: "desktop" | "mobile"; status: PeerStatus; groupId: string | null; term: number; joinedAt: number }
// term is meaningful only on host records (the group's term); 0 otherwise.
type Outgoing = { to: string; msg: ServerMessage };
class RoomState {
  constructor(records: PeerRecord[], newId: () => string);
  get size(): number;
  records(): PeerRecord[];
  snapshot(): RoomSnapshot;            // peers sorted by joinedAt; groups derived from host records
  join(peerId: string, device: "desktop" | "mobile", now: number): Outgoing[];
  handle(peerId: string, msg: ClientMessage): Outgoing[];
  leave(peerId: string): Outgoing[];
}
```

Rules (spec 호스트 선출과 그룹, minus merge/succession):
- `join`: if no `host` record exists → new peer is `host` of a new group (`groupId = newId()`, `term = 1`); else `joining`. Returns `welcome` to the new peer + `room` to every other peer.
- `signal`: unknown `to` or `to === peerId` → `error no-such-peer` to sender only. Else one `signal {from, sdp}` to `to`. No `room` broadcast.
- `joined`: sender must be `joining`/`unattached` (else `bad-state`); group must exist (else `no-such-group`) → `member` of it.
- `unattached`: sender must be `joining` (else `bad-state`) → `unattached`.
- `start-alone`: sender must be `joining`/`unattached` (else `bad-state`) → `host` of a new group, `term = 1`.
- `leave`: remove the peer; if it was a host, its members become `unattached` with `groupId = null`. Unknown peer → `[]`.
- Every state change (`join`, `joined`, `unattached`, `start-alone`, `leave` of a known peer) broadcasts `room` with the new snapshot to all remaining peers (to the new peer it is `welcome` instead). Errors change nothing and broadcast nothing.

- [ ] **Step 1: Write failing tests** (deterministic ids: `let n = 0; const ids = () => "g" + ++n;`):
  - `first peer becomes host`: `join("a","desktop",1)` → one `welcome` to `a`; `snapshot().groups` = `[{groupId:"g1", hostId:"a", term:1, members:[]}]`.
  - `second peer is joining and others are told`: then `join("b","mobile",2)` → `welcome` to `b` and `room` to `a`; `b.status === "joining"`.
  - `joined makes member`: `handle("b",{t:"joined",groupId:"g1"})` → groups[0].members `["b"]`; `room` sent to both `a` and `b`.
  - `joined to unknown group`: → `[{to:"b", msg:{t:"error", code:"no-such-group", …}}]`, state unchanged.
  - `member cannot rejoin`: `joined` again from `b` → `bad-state`.
  - `unattached then start-alone`: `c` joins → `unattached` → `start-alone` → `c` is host of `g2`, term 1; two groups in snapshot.
  - `start-alone from host`: → `bad-state`.
  - `signal relays only to target`: `handle("a",{t:"signal",to:"b",sdp})` → exactly `[{to:"b", msg:{t:"signal", from:"a", sdp}}]`.
  - `signal to self or unknown`: → `no-such-peer` to sender.
  - `host leaves dissolves group`: `leave("a")` → `b` is `unattached`, `groupId: null`; `groups` no longer has `g1`; `room` sent to remaining peers only (not `a`).
  - `leave unknown peer`: → `[]`.
  - `round-trip`: `new RoomState(s.records(), ids).snapshot()` equals `s.snapshot()` (the DO relies on this).
  - `new peer becomes host when only unattached peers remain`: after the host leaves, `join("d",…)` → `d` is host (unattached peers will retry against it in Next Steps 3).
- [ ] **Step 2: Run** `npm test -- room` → FAIL.
- [ ] **Step 3: Implement** `RoomState` (a `Map<string, PeerRecord>`; groups always derived, never stored separately).
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add pure room state for signaling server"`

---

### Task 4: Worker + Durable Object wiring

**Files:**
- Modify: `server/src/index.ts` (replace stub)
- Create: `server/src/roomDO.ts` (export `Room`, re-exported from `index.ts`)
- Test: `server/test/worker.test.ts`

**Interfaces:**
- Consumes: `networkId`, `parseRoomParams`, `roomKeyString` (Task 1); `parseClientMessage`, `MAX_MESSAGE` (Task 2); `RoomState`, `PeerRecord` (Task 3).
- Produces: deployed HTTP surface from the Protocol section. Env type `{ ROOMS: DurableObjectNamespace }`.

Behavior:
- Worker `fetch`: `GET /` → `200 "ok"`. `/ws` without `Upgrade: websocket` → `426`. Missing/unparsable `CF-Connecting-IP` → `400`. `parseRoomParams` error → `400` with the error text. Otherwise `env.ROOMS.get(env.ROOMS.idFromName(roomKeyString(...))).fetch(request)`. Other paths → `404`.
- `Room.fetch`: if `getWebSockets().length >= MAX_PEERS` → `429`. Else create a `WebSocketPair`, `ctx.acceptWebSocket(server)`, `peerId = crypto.randomUUID()`, run `join`, then persist + send (below), return `101` with the client socket. `device` comes from re-parsing the request URL.
- `webSocketMessage(ws, data)`: parse; on `{error}` send `error` to that socket only; else `handle`.
- `webSocketClose` / `webSocketError`: `leave(peerId)`; then close the socket if still open.
- Every event: `state = new RoomState(liveSockets.map(s => s.deserializeAttachment()), () => crypto.randomUUID())` → apply → for each live socket `serializeAttachment(record)` → send each `Outgoing` to the socket whose attachment `peerId === to`. Sending to a socket that already closed must not throw out of the handler (wrap `send` in try/catch). No instance fields hold room state.

- [ ] **Step 1: Write failing integration tests** using the pool's `SELF.fetch`. Helper `connect(ip, query)` sends `Upgrade: websocket` + `CF-Connecting-IP: ip`, calls `res.webSocket.accept()`, and returns `{ ws, next(): Promise<ServerMessage> }` that queues incoming JSON. Tests:
  - `GET / is ok` → 200.
  - `bad params rejected`: `/ws?mode=meeting` → 400; no `CF-Connecting-IP` → 400; no Upgrade → 426.
  - `first is host, second sees group`: A(`203.0.113.5`) welcome has A as host; B(same IP) welcome has `room.groups[0].hostId === A.peerId` and B `joining`; A next gets `room`.
  - `different network isolated`: C(`198.51.100.7`, same room) welcome has only C, as host.
  - `different room isolated`: D(same IP, `?room=거실`) welcome has only D.
  - `meeting key isolates`: two meeting sockets with different keys on the same IP each become host of their own room.
  - `IPv6 same /64 shares a room`: `2001:db8:1:2::a` and `2001:db8:1:2::b` see each other.
  - `signal relayed`: A sends `signal` to B → B receives `{t:"signal", from:A.peerId, sdp}`; nobody else receives it.
  - `bad frame gets error, connection stays`: A sends `"nope"` → `error bad-json`; A then sends a valid `signal` that is still delivered.
  - `joined and leave`: B `joined` → A gets `room` with B member; A closes → B gets `room` with B `unattached` and no groups.
  - `send to closed peer` (Review Focus 3): B closes, A immediately signals B → A gets `no-such-peer` or nothing, no exception; a new peer C can still join and sees A.
  - `room cap`: 32 sockets on one key succeed, the 33rd gets `429`.
- [ ] **Step 2: Run** `npm test -- worker` → FAIL.
- [ ] **Step 3: Implement** `index.ts` and `roomDO.ts` per Behavior.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → all PASS.
- [ ] **Step 5: Manual local check:** `npm run dev`, then in two browser tabs' consoles `new WebSocket("ws://localhost:8787/ws")` with `onmessage = e => console.log(e.data)` → second tab's welcome lists the first tab as host. (Note in the commit if local dev lacks `CF-Connecting-IP`; if so, accept `127.0.0.1`/`::1` fallback **only** when `env.DEV === "1"` set via `.dev.vars`.)
- [ ] **Step 6: Commit** `git commit -m "Wire signaling Worker and Room Durable Object"`

---

### Task 5: Deploy and IPv4-only hostname check (manual, with the user)

**Files:**
- Modify: `docs/designs/wifi-chat.md` (Spike Results + Open Questions)

- [ ] **Step 1:** User runs `! cd server && npx wrangler login`, then `npx wrangler deploy`. Record the `*.workers.dev` URL.
- [ ] **Step 2:** `nslookup -type=A <host>` and `nslookup -type=AAAA <host>`. Expected: workers.dev returns AAAA (dual-stack).
- [ ] **Step 3: Real-network check.** On the laptop and the phone on home Wi-Fi, open the deployed URL's `/` page in a browser, and in the laptop console run `new WebSocket("wss://<host>/ws")` with logging; on the phone use the spike page's console or a one-line test page. Pass = the second device's `welcome` lists the first as host. **Fail = they land in different rooms** — that is the dual-stack IPv4/IPv6 split the spec warns about.
- [ ] **Step 4:** If Step 3 fails or AAAA exists, ask the user whether they own a domain on Cloudflare. If yes: route the Worker to a custom hostname with IPv6 compatibility turned off and repeat Steps 2–3. If no: record it as the open fallback ("IPv4 전용 호스트에 키 발급 엔드포인트") for the Next Steps 3 plan.
- [ ] **Step 5:** Write results (URL, A/AAAA, Step 3 pass/fail, decision) into the design doc; commit `git commit -m "Record signaling deploy and IPv4 hostname check"`.

---

## Review Focus

1. **Dual-stack home network** — phone connects over IPv6, laptop over IPv4, so they get different room keys and never meet. Expected: the same room. Code can't fix this; Task 5 Step 3 is the test that catches it on real hardware.
2. **Hibernation wake** — after the DO sleeps, the room must be identical. Covered by Task 3 `round-trip` plus the Task 4 rule that no instance field holds state.
3. **Peer closes mid-relay** — a `signal` to a socket that just closed must not crash the handler or lose the room for others. Task 4: add test `send to closed peer`: B closes, A immediately signals B → A gets `no-such-peer` or nothing, and a third peer C can still join.
4. **Korean / odd room names** — `거실`, `3층회의실`, spaces, 40+ chars, NFD-composed input. Expected: NFC-equal names share a room. Task 1: add `expect(p("?room=" + encodeURIComponent("거실".normalize("NFD"))).room).toBe("거실")`.
5. **Hostile client on the same network** — junk frames, binary frames, 1 MB frames, signal spam. Expected: error to that sender only, other peers unaffected. Covered by Task 2 tests and Task 4 `bad frame gets error`.
