# Browser Connection (Next Steps 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening the web page on two devices on the same Wi-Fi puts them in one group automatically: the page talks to the deployed signaling server, connects to a group host over a LAN-only WebRTC DataChannel, verifies the path, and shows the waiting / connected / failure screens with "따로 시작하기".

**Architecture:** A static Vite + TypeScript site in `web/`. Pure, unit-tested modules hold every decision: SDP candidate filtering (`sdp.ts`), selected-pair verification (`pairCheck.ts`), and the join state machine (`joiner.ts`, with WebRTC and the socket injected). Thin browser glue (`signaling.ts`, `peer.ts`, `main.ts`) wires them to `WebSocket` and `RTCPeerConnection` and is verified by hand on real devices. Protocol types are imported type-only from `server/src/protocol.ts`, so client and server cannot drift.

**Tech Stack:** TypeScript, Vite, vitest (node environment), Cloudflare Pages (`wrangler pages deploy`).

**Spec:** `docs/designs/wifi-chat.md` (연결 설정, 호스트 선출과 그룹, Next Steps 3). Server: `server/src/protocol.ts` (message shapes), deployed at `wss://wifi-chat-signal.wifi-chat-signal.workers.dev/ws`.

## Scope

In: non-trickle SDP, host-only candidates, `getStats()` path check, trying all group hosts at once (5 s), join / unattached / 따로 시작하기, failure screen, unattached auto-retry when the room's hosts change, the screens and copy below, Pages deploy, laptop↔phone check.

Out — **Next Steps 3b (separate plan)**: 다리 합치기 and 미연결 기기 끌어오기 (a joiner dialing unattached devices; server merge messages). Out — later steps: chat messages, nicknames, history (4), heartbeat/succession (5), room/mode URL UI, QR, meeting token creation (6).

## Global Constraints

- `new RTCPeerConnection({ iceServers: [] })` everywhere. No STUN, no TURN, no trickle: send SDP only after `iceGatheringState === "complete"` (gather timeout `GATHER_TIMEOUT_MS = 3000`, then send what was gathered).
- Every received SDP passes through `keepHostCandidatesOnly` before `setRemoteDescription`.
- Path rule after connect: local candidate `host`; remote `host`, or `prflx` whose address is private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), ULA (fc00::/7) or an mDNS `.local` name. `srflx`, `relay`, or public `prflx` → close immediately.
- Join timeout `DIAL_TIMEOUT_MS = 5000` per attempt; all hosts are dialed concurrently.
- Signaling URL: `?signal=<wss url>` query override, else `wss://wifi-chat-signal.wifi-chat-signal.workers.dev/ws`. The page forwards its own `room`, `mode`, `key` query params to the socket URL unchanged, and adds `device`.
- `device`: `desktop` when `matchMedia("(pointer: fine)").matches` and the UA has no `Mobi|Android|iPhone|iPad`; otherwise `mobile`.
- No message content, nickname or IP is ever sent to the signaling server (only the four Protocol client messages).
- Library code is bundled from the repo (Vite build); no CDN scripts.
- Copy (Korean, verbatim from spec):
  - Waiting, alone, no one else in the room: `아직 이 Wi-Fi에 다른 사람이 없어요. 기다리는 중`
  - Host whose group has no members (banner, always visible): `아직 나와 연결된 사람이 없어요`
  - Failure: `이 Wi-Fi의 다른 사람과 연결할 수 없어요. 같은 Wi-Fi가 아니거나, 이 네트워크가 기기 간 연결을 막고 있어요`
  - Button: `따로 시작하기`
  - Entry line: `메시지는 이 Wi-Fi 밖으로 나가지 않아요`

## Rulings baked into this plan

- **Hidden-address `prflx`:** Chrome may report a remote `prflx` with an empty address (the spike saw this). Treated as **allowed** with `verdict: "prflx-hidden"`, because our side has no STUN/TURN and the local candidate is verified `host`, so the packets stay on our LAN interface; rejecting would break the common mDNS race the spec explicitly allows. Cost if wrong: a modified remote client with a public reflexive path in the same room key would be accepted.
- **Interim host-loss rule (until Next Steps 5):** the server dissolves a group when its host leaves, leaving members `unattached` with no host anywhere. If a peer is `unattached`, the room has **zero groups**, and it is the earliest-joined `unattached` peer in the snapshot, it sends `start-alone`; the others retry against the new host when the `room` update arrives. Deterministic, so no two peers start alone at once.
- **Hosting:** Cloudflare Pages, separate from the Worker (spec Distribution Plan). Cross-origin `wss://` to the Worker needs no CORS.

## Review Focus

1. **Answer from a host we never dialed / stale answer after timeout** — must be ignored, not applied to a closed `RTCPeerConnection` (throws). Task 2 test `late answer after abort is ignored` pins the coordinator side; Task 3 `peer.ts` must drop answers with no pending dial.
2. **Two hosts both answer in time** — exactly one `joined` is sent, the other connection is closed (no merge in 3a). Task 2 test `first success wins`.
3. **Room updates arrive while dialing** — must not start a second concurrent attempt or send `unattached` after `joined`. Task 2 test `room update during dial does not redial`.
4. **Phone tab backgrounded mid-dial** — dial times out; peer becomes `unattached`, then retries when hosts change. Covered by Task 2 timeout tests; checked by hand in Task 4.
5. **Host receives an offer from a peer already connected** (retry after flaky link) — the old connection for that peer is closed and replaced, not leaked. Task 3 `host.ts` keeps one `RTCPeerConnection` per remote peerId.

---

### Task 1: Web scaffold + SDP filter + path check

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html` (placeholder body), `web/.gitignore` (`node_modules`, `dist`)
- Create: `web/src/sdp.ts`, `web/src/pairCheck.ts`
- Test: `web/test/sdp.test.ts`, `web/test/pairCheck.test.ts`

**Interfaces:**
- Produces:
  - `keepHostCandidatesOnly(sdp: string): { sdp: string; dropped: number }` — removes `a=candidate:` lines whose type is not `host`; keeps every other line and the original line ending (`\r\n`).
  - `isLanAddress(addr: string): boolean` — the address classes in Global Constraints, plus `.local`.
  - `type PairVerdict = "host" | "prflx-lan" | "prflx-hidden"`
  - `type StatLike = { id: string; type: string; [k: string]: unknown }`
  - `checkSelectedPair(stats: Iterable<StatLike>): { ok: true; verdict: PairVerdict; local: string; remote: string } | { ok: false; reason: string }` — finds the pair via `transport.selectedCandidatePairId`, falling back to a `candidate-pair` with `nominated && state === "succeeded"`; reads `address ?? ip` on candidates; `local`/`remote` are human-readable summaries like `host 192.168.0.5:54321 udp`.

- [ ] **Step 1: Scaffold.** `cd web && npm init -y && npm i -D vite typescript vitest`. Approve install scripts the same way as `server/` (`npm install-scripts approve esbuild`). Scripts: `dev: "vite --host"`, `build: "tsc --noEmit && vite build"`, `test: "vitest run"`, `typecheck: "tsc --noEmit"`. `tsconfig` strict, `lib: ["es2022","dom"]`, includes `src`, `test`, and `../server/src/protocol.ts` + `../server/src/roomKey.ts` (type imports only).
- [ ] **Step 2: Failing tests.**

```ts
// sdp.test.ts
const sdp = ["v=0", "a=candidate:1 1 udp 2113937151 abcd.local 5000 typ host generation 0",
  "a=candidate:2 1 udp 1677729535 1.2.3.4 6000 typ srflx raddr 0.0.0.0 rport 0",
  "a=candidate:3 1 udp 33562623 5.6.7.8 7000 typ relay raddr 1.2.3.4 rport 6000",
  "a=candidate:4 1 tcp 1518280447 192.168.0.5 9 typ host tcptype active", "a=end-of-candidates", ""].join("\r\n");
const out = keepHostCandidatesOnly(sdp);
expect(out.dropped).toBe(2);
expect(out.sdp).toContain("abcd.local 5000 typ host");
expect(out.sdp).toContain("typ host tcptype active");
expect(out.sdp).not.toMatch(/typ (srflx|relay)/);
expect(out.sdp).toContain("a=end-of-candidates");
expect(out.sdp.endsWith("\r\n")).toBe(true);
expect(keepHostCandidatesOnly("a=candidate:9 1 udp 1 hosty.local 1 typ hostx").dropped).toBe(1); // exact token match

// pairCheck.test.ts — isLanAddress
for (const a of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.9", "169.254.3.3",
  "fe80::1", "febf::1", "fc00::1", "fdab::9", "x-y.local"]) expect(isLanAddress(a)).toBe(true);
for (const a of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "11.0.0.1", "fec0::1", "2001:db8::1", "fd", "local", ""])
  expect(isLanAddress(a)).toBe(false);

// checkSelectedPair — helper builds stats: transport{selectedCandidatePairId:"p"}, candidate-pair p, local-candidate L, remote-candidate R
expect(check("host", "192.168.0.5", "host", "abcd.local")).toMatchObject({ ok: true, verdict: "host" });
expect(check("host", "192.168.0.5", "prflx", "192.168.0.7")).toMatchObject({ ok: true, verdict: "prflx-lan" });
expect(check("host", "192.168.0.5", "prflx", "")).toMatchObject({ ok: true, verdict: "prflx-hidden" });
expect(check("host", "192.168.0.5", "prflx", "8.8.8.8")).toMatchObject({ ok: false });
expect(check("host", "192.168.0.5", "srflx", "1.2.3.4")).toMatchObject({ ok: false });
expect(check("host", "192.168.0.5", "relay", "5.6.7.8")).toMatchObject({ ok: false });
expect(check("srflx", "1.2.3.4", "host", "x.local")).toMatchObject({ ok: false });
expect(checkSelectedPair([])).toMatchObject({ ok: false });
// fallback without transport.selectedCandidatePairId: nominated+succeeded pair is used
```

- [ ] **Step 3: Run** `npm test` → FAIL (modules missing).
- [ ] **Step 4: Implement** both modules. Candidate type = the token right after `typ`.
- [ ] **Step 5: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `Add web scaffold, SDP host filter and path check`

---

### Task 2: Join state machine

**Files:**
- Create: `web/src/joiner.ts`
- Test: `web/test/joiner.test.ts`

**Interfaces:**
- Consumes: `RoomSnapshot`, `ClientMessage` (type-only from `server/src/protocol.ts`).
- Produces:

```ts
export const DIAL_TIMEOUT_MS = 5000;
/** Resolves once connected and path-checked; rejects on failure. Must close everything when `signal` aborts. */
export type Dial = (hostId: string, signal: AbortSignal) => Promise<void>;
export type View =
  | { kind: "connecting" }
  | { kind: "host"; groupId: string; members: string[]; aloneInRoom: boolean }
  | { kind: "member"; groupId: string; hostId: string }
  | { kind: "failed" };
export class Joiner {
  constructor(deps: { send(msg: ClientMessage): void; dial: Dial; timeoutMs?: number });
  onWelcome(peerId: string, room: RoomSnapshot): void;
  onRoom(room: RoomSnapshot): void;
  startAlone(): void;               // the "따로 시작하기" button; no-op unless view is failed
  get view(): View;
  onChange(cb: (v: View) => void): void;
}
```

Rules (from my status in the latest snapshot):
- `host` → view `host` (`aloneInRoom` = I am the only peer in the snapshot).
- `member` → view `member`; clear the set of attempted hosts.
- `joining`, not dialing → dial **every** group host concurrently, each with its own `AbortController` and a `timeoutMs` timer. First to resolve: abort the rest, send `{t:"joined", groupId}`, view stays `connecting` until the server's `room` says `member`. All rejected/timed out → send `{t:"unattached"}`, view `failed`.
- `unattached` → view `failed`. On each snapshot, if not dialing and some group host is **not** in the attempted set → dial all current hosts again (same as above, but on total failure send nothing — already unattached). If there are **zero** groups and I am the earliest `unattached` peer → send `start-alone` (interim rule).
- Never more than one attempt in flight; never send `unattached` after `joined` in the same attempt.
- After sending `joined{groupId}`, remember it as `pendingGroup`. While my status is still `joining` and `pendingGroup` still exists in the snapshot → wait (no redial). If `pendingGroup` is gone (its host left) → forget it and dial again.

- [ ] **Step 1: Failing tests** (vitest fake timers; `dial` is a test double whose per-host promises the test resolves/rejects; `snap()` builds snapshots):
  - `host on welcome`: welcome with me as host → view `{kind:"host", aloneInRoom:true, members:[]}`; nothing sent.
  - `host with members is not alone`.
  - `dials all hosts at once`: two groups → `dial` called with both host ids before any resolves.
  - `first success wins`: host2 resolves first → sent exactly `[{t:"joined", groupId:"g2"}]`; host1's signal is aborted.
  - `all fail → unattached`: both reject → sent `[{t:"unattached"}]`, view `failed`.
  - `timeout counts as failure`: dial never settles; advance 5000 ms → `unattached` sent, signals aborted.
  - `late answer after abort is ignored`: after timeout, resolving host1 sends nothing more.
  - `room update during dial does not redial`: `onRoom` with an extra group mid-dial → `dial` call count unchanged.
  - `waits for member after joined`: after `joined` sent, a `room` still showing me `joining` with g2 present → no new dial; a `room` where g2 is gone → dials again.
  - `member clears attempts`: after `room` shows me `member`, view `member`.
  - `unattached retries on new host`: failed with hosts {h1}; `onRoom` adds h3 → dials h1 and h3; same hosts again → no dial.
  - `unattached with no groups: earliest starts alone`: me earliest unattached, zero groups → sends `start-alone` once; if another unattached peer joined earlier → sends nothing.
  - `startAlone button`: in `failed` → sends `start-alone`; in `connecting` → nothing.
  - `onChange fires on view change`.
- [ ] **Step 2: Run** `npm test -- joiner` → FAIL.
- [ ] **Step 3: Implement** `Joiner`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Add join state machine for browser client`

---

### Task 3: Browser glue and screens

**Files:**
- Create: `web/src/signaling.ts`, `web/src/peer.ts`, `web/src/host.ts`, `web/src/config.ts`, `web/src/main.ts`, `web/src/style.css`
- Modify: `web/index.html`
- Test: `web/test/config.test.ts`

**Interfaces:**
- Consumes: `keepHostCandidatesOnly`, `checkSelectedPair` (Task 1); `Joiner`, `Dial`, `View`, `DIAL_TIMEOUT_MS` (Task 2); Protocol types.
- Produces:
  - `config.ts`: `signalUrl(page: URL, device: "desktop" | "mobile"): string`; `detectDevice(ua: string, finePointer: boolean): "desktop" | "mobile"`.
  - `signaling.ts`: `class Signaling { constructor(url: string); onMessage(cb: (m: ServerMessage) => void); send(m: ClientMessage): void; close(): void }` — JSON over `WebSocket`; `onClose(cb)` too.
  - `peer.ts`: `GATHER_TIMEOUT_MS = 3000`; `createDialer(sig: Signaling): { dial: Dial; onAnswer(from: string, sdp: Sdp): void; connections: Map<string, RTCPeerConnection> }` — offerer side: creates a `control` DataChannel, waits for gathering, sends `signal`, waits for the answer from that host (answers with no pending dial are dropped), `setRemoteDescription(keepHostCandidatesOnly(...))`, waits for DataChannel `open`, runs `checkSelectedPair(await pc.getStats())`, closes and rejects on a bad path; on abort closes the pc. A successful pc stays in `connections`.
  - `host.ts`: `createHost(sig: Signaling): { onOffer(from: string, sdp: Sdp): Promise<void>; connections: Map<string, RTCPeerConnection> }` — one pc per remote peerId (an existing one is closed first), answer after gathering, same path check on connect, close on bad path.
  - `main.ts`: reads the page URL, opens `Signaling`, routes `welcome`/`room` → `Joiner`, `signal` answers → dialer, offers → host (only while my view is `host`), renders `Joiner.view`.

Screens (`main.ts` renders into `#app`; one `<section>` per view):
- top line always: entry copy + a small status line (`연결 중…`, my role, path verdict of the latest connection, e.g. `경로: host↔host`).
- `connecting`: `연결 중…`.
- `host` + `aloneInRoom`: waiting copy. `host` with no members: the 혼자 banner. `host` with members: `호스트 · 연결된 사람 N명`.
- `member`: `그룹에 연결됨 · 호스트 <first 4 chars of hostId>`.
- `failed`: failure copy + `따로 시작하기` button → `joiner.startAlone()`.
- socket closed: `중개 서버와 연결이 끊겼어요. 새로고침해 주세요` (no auto-reconnect in 3a).

- [ ] **Step 1: Failing tests** in `config.test.ts`:

```ts
expect(signalUrl(new URL("https://p.dev/?room=거실"), "mobile"))
  .toBe("wss://wifi-chat-signal.wifi-chat-signal.workers.dev/ws?room=%EA%B1%B0%EC%8B%A4&device=mobile");
expect(signalUrl(new URL("https://p.dev/?signal=ws://localhost:8787/ws&mode=meeting&key=" + "A".repeat(22) + "&junk=1"), "desktop"))
  .toBe("ws://localhost:8787/ws?mode=meeting&key=" + "A".repeat(22) + "&device=desktop"); // only room/mode/key forwarded
expect(detectDevice("Mozilla/5.0 (Windows NT 10.0)", true)).toBe("desktop");
expect(detectDevice("Mozilla/5.0 (Linux; Android 14) Mobile", true)).toBe("mobile");
expect(detectDevice("Mozilla/5.0 (Windows NT 10.0)", false)).toBe("mobile");
```
- [ ] **Step 2: Run** `npm test -- config` → FAIL.
- [ ] **Step 3: Implement** `config.ts`, then the glue modules and screens per Interfaces.
- [ ] **Step 4: Run** `npm test && npm run build` → PASS, `dist/` produced.
- [ ] **Step 5: Manual two-tab check on the laptop:** `npm run dev`, open `http://localhost:5173/?room=t1` in two tabs. Expected: tab 1 shows the waiting copy → after tab 2 opens, tab 2 shows `그룹에 연결됨`, tab 1 shows `연결된 사람 1명`, status line shows a path verdict. Close tab 1 → tab 2 becomes host (interim rule) within ~1 s.
- [ ] **Step 6: Commit** `Add browser signaling, WebRTC glue and screens`

---

### Task 4: Pages deploy and device check (manual, with the user)

**Files:**
- Modify: `docs/designs/wifi-chat.md` (results section)

- [ ] **Step 1:** `cd web && npm run build && npx wrangler pages deploy dist --project-name wifi-chat` (create the project on first run). Record the `*.pages.dev` URL.
- [ ] **Step 2:** Laptop opens `<url>/?room=집`, phone (home Wi-Fi, mobile data off) opens the same. Expected: one group, path verdict shown on both. Record the verdict (`host` / `prflx-lan` / `prflx-hidden`).
- [ ] **Step 3:** Phone screen off 3 s, on again; record whether the connection survives (spec's open screen-off test).
- [ ] **Step 4:** Phone on mobile data opens the same URL. Expected: it lands in a different room (own host, waiting copy).
- [ ] **Step 5:** Write results into the design doc; commit `Record browser connection device check`.
