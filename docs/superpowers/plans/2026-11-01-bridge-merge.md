# Bridge Merge (Next Steps 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Devices that landed in separate groups or sit unattached end up in one group when a newcomer can reach them all: the newcomer dials every group host **and** every unattached device, and if it reaches two groups, or a group plus an unattached device, it becomes the bridge host of a merged group, without dropping anyone who cannot reach it.

**Architecture:** The server stays stateless between events (records rebuilt from socket attachments, as now): `RoomState` gains `merge-start` (fan out a `merge-request` to the members who must prove they reach the bridge) and `merge-commit` (re-validate and rebuild the groups in one step). The browser gets two pure modules: `merge.ts` (what to do after dialing, what may be committed, which links to close) and `links.ts` (one live connection per remote peer, with a deterministic glare rule). `Joiner` orchestrates; `peer.ts`/`host.ts`/`main.ts` are rewired to the shared link registry.

**Tech Stack:** TypeScript, vitest, Cloudflare Workers + Durable Objects (`server/`), Vite (`web/`), Cloudflare Pages.

**Spec:** `docs/designs/wifi-chat.md` (호스트 선출과 그룹: 미연결 기기 끌어오기, 다리 합치기). Previous plan: `docs/superpowers/plans/2026-11-01-browser-connection.md` (3a; its Global Constraints all still apply).

## Scope

In: dialing unattached devices, bridge merge of 2+ groups and/or unattached devices, the 5 s all-members confirmation, desktop-host priority, merged term = max + 1, fallback to plain join, glare between two peers dialing each other, closing links that no longer belong to my group, server `merge-start`/`merge-commit`, deploy of both, device check.

Out: heartbeat, succession, demotion, term checks on messages (Next Steps 5); chat messages (4). A member whose link to its host dies stays a member with no link until Next Steps 5 (individual rejoin).

## Global Constraints

- Everything in 3a's Global Constraints (no STUN/TURN/trickle, host-only SDP, `getStats()` path rule, copy) still holds for every new connection, including member → bridge dials.
- `DIAL_TIMEOUT_MS = 5000` (dial phase), `MERGE_TIMEOUT_MS = 5000` (spec: "모든 참가자가 5초 안에 N과 연결을 확인").
- Merge validity (client and server use the same rule): the bridge may commit when, after confirmation, it has **≥ 2 whole groups, or ≥ 1 unattached device** (with any number of whole groups). A group is whole when its host **and every current member** has a live link to the bridge.
- Merged term = max term of the merged groups + 1; with no group merged, 1.
- Desktop-host priority: if I am `mobile` and any group host I reached is `desktop`, I join the earliest such group as a member and never merge.
- Glare: when two peers hold two connections to each other, both keep the one **offered by the lower peerId** (string comparison) and close the other.
- No new persistent server state: merge messages are validated against the current records only.

## Rulings baked into this plan

- **Zero groups reached, unattached reached:** the newcomer forms a new group with the unattached devices it reached (commit with `groups: []`). The spec only names "group + unattached", but leaving two mutually reachable devices apart contradicts 미연결 기기 끌어오기.
- **One whole group, no unattached:** not a merge. Join that group's host as a member, so the existing host is not displaced for nothing ("합칠 대상이 하나도 남지 않으면 … 일반 참가자로 합류").
- **Unattached devices also dial each other** on retry (targets = all hosts + all other unattached). Two unattached devices that reach each other therefore form a group, earliest-committing wins.
- **The server trusts the bridge's claim of who it is linked to.** It checks that the claim covers every current member of each claimed group, not that the links exist. A lying same-network peer can take over groups it cannot reach; its victims end up members with no host link (same failure as a dead host link, fixed by Next Steps 5).
- **Desktop priority is enforced by the client only.** A modified client could merge over a desktop host; harmless beyond host choice.

## Review Focus

1. **Two bridges merge the same groups at once** — the second `merge-commit` must be rejected (its groups no longer exist / its peers are no longer unattached) and that bridge must restart joining from the current snapshot, ending in one group. Task 1 test `second commit over the same groups is rejected`; Task 4 test `rejected commit redials from the current snapshot`.
2. **Two peers dial each other at the same moment (glare)** — both must keep the same single connection, not close both. Task 3 test `glare keeps the lower id's offer on both sides`.
3. **An unrelated room update arrives mid-merge** — must not close a member's fresh link to the not-yet-host bridge. Task 2 test `links to joining or unattached peers are never closed`.
4. **A group gains a member during the merge window** — that group must not be merged unless the new member also linked to the bridge. Task 1 test `commit drops a group whose new member is not covered`; Task 2 test `group with an unlinked member is not whole`.
5. **The bridge closes its tab mid-merge** — members close their link to it and stay in their old group. Task 2 test `links to peers gone from the room are closed`.

---

### Task 1: Server merge messages

**Files:**
- Modify: `server/src/protocol.ts` (types + `parseClientMessage`), `server/src/room.ts` (`handle`, class comment)
- Test: `server/test/protocol.test.ts`, `server/test/room.test.ts`

**Interfaces:**
- Produces (protocol):
  - `ClientMessage` adds `{ t: "merge-start"; groups: string[]; unattached: string[] }` and `{ t: "merge-commit"; groups: string[]; peers: string[] }`.
  - `ServerMessage` adds `{ t: "merge-request"; bridgeId: string }`.
  - `MAX_MERGE_IDS = 32`: each id list ≤ 32 entries, every entry a non-empty string, no other fields kept.

Rules in `RoomState.handle` (sender must be `joining` or `unattached`, else `bad-state`):
- `merge-start`: every `groups` id exists (`no-such-group`), every `unattached` id is another peer whose status is `unattached` (`no-such-peer`), at least one id in total (`bad-state`). Counts as one signal against the existing rate limit. Returns a `merge-request { bridgeId: sender }` to each **member** (not host) of the listed groups; nothing else changes.
- `merge-commit`: whole groups = listed groups that exist and whose host and all members are in `peers`; pulled = `peers` entries whose status is `unattached` (excluding the sender). If not (whole ≥ 2 or pulled ≥ 1) → `bad-state`, nothing changes. Otherwise: new groupId; sender becomes `host` with term = max(whole groups' terms) + 1 (1 if none); every peer of the whole groups and every pulled peer becomes `member` of the new group; broadcast `room` to everyone.

- [ ] **Step 1: Failing tests.** `protocol.test.ts`: both new messages parse and are rebuilt without extra fields; non-array, non-string entry, empty string, and 33 ids are `bad-message`. `room.test.ts` (reuse its helpers):
  - `merge-start asks members of the listed groups only`: groups A (host a, member a1) and B (host b, no members), joining n → `merge-start {groups:[A,B], unattached:[]}` → exactly `[{to:a1, msg:{t:"merge-request", bridgeId:n}}]`.
  - `merge-start validates targets`: unknown group → `no-such-group`; a member listed as unattached → `no-such-peer`; empty lists → `bad-state`; from a member → `bad-state`.
  - `merge-start is rate-limited`: after `SIGNAL_LIMIT` signals, `merge-start` → `too-many`.
  - `commit merges two whole groups`: A term 1, B term 3 → `merge-commit {groups:[A,B], peers:[a,a1,b]}` → n host with term 4; a, a1, b members of n's new group; A and B gone from `snapshot().groups`.
  - `commit pulls unattached`: group A (host a), unattached u → `{groups:[A], peers:[a,u]}` → n host term 2, a and u members.
  - `commit with only unattached forms a new group`: `{groups:[], peers:[u]}` → n host term 1, u member.
  - `commit drops a group whose new member is not covered`: A has a, a1; commit `{groups:[A], peers:[a, u]}` → n hosts u only; A unchanged.
  - `one whole group alone is rejected`: `{groups:[A], peers:[a]}` → `bad-state`, nothing changed.
  - `second commit over the same groups is rejected`: n commits A+B; then m (joining) commits A+B with the same peers → `bad-state`, n's group intact.
- [ ] **Step 2: Run** `cd server && npm test` → new tests FAIL.
- [ ] **Step 3: Implement** the parser cases and the two `handle` cases. Update the class comment (bridge merges are now here; succession still Next Steps 5).
- [ ] **Step 4: Run** `npm test && npm run typecheck` in `server/` → PASS. Run `cd ../web && npm run typecheck` → PASS (protocol is shared).
- [ ] **Step 5: Commit** `Add bridge merge messages to signaling server`

---

### Task 2: Merge decisions (pure)

**Files:**
- Create: `web/src/merge.ts`
- Test: `web/test/merge.test.ts`

**Interfaces:**
- Consumes: `RoomSnapshot`, `PeerView`, `Device` types.
- Produces:

```ts
export const MERGE_TIMEOUT_MS = 5000;
export type Plan =
  | { kind: "none" }
  | { kind: "join"; groupId: string }
  | { kind: "merge"; groups: string[]; unattached: string[] };
/** Targets I should dial: every group host and every other unattached peer, snapshot order. */
export function dialTargets(myId: string, room: RoomSnapshot): string[];
/** What to do once the dial phase settled. `reached` = peers whose dial succeeded. */
export function planAfterDial(myId: string, myDevice: Device, room: RoomSnapshot, reached: ReadonlySet<string>): Plan;
/** Every member of every listed group (still in the room) is linked. */
export function mergeComplete(room: RoomSnapshot, groups: string[], linked: ReadonlySet<string>): boolean;
/** The commit to send, or null when the merge validity rule fails. */
export function commitPlan(myId: string, room: RoomSnapshot, groups: string[], linked: ReadonlySet<string>): { groups: string[]; peers: string[] } | null;
/** Linked peers whose connection no longer belongs to me. */
export function linksToClose(myId: string, room: RoomSnapshot, linked: ReadonlySet<string>): string[];
```

Rules:
- `planAfterDial`: reached hosts (groups whose host is in `reached`, snapshot order) and reached unattached. Nothing reached → `none`. I am `mobile` and a reached host is `desktop` → `join` the first such group. Reached hosts ≥ 2 or reached unattached ≥ 1 → `merge` with those groups and unattached ids. Otherwise `join` the one reached group.
- `commitPlan`: whole groups (host and all current members in `linked`), plus every `linked` peer whose status is `unattached`; apply the merge validity rule; `peers` = union of whole groups' peers and those unattached peers.
- `linksToClose`: a linked peer is closed when it is gone from the room; or it is `host`/`member` and not mine to keep (I am host → keep my group's members; I am member → keep my host; I am `joining`/`unattached` → keep everyone). Links to `joining`/`unattached` peers are never closed.

- [ ] **Step 1: Failing tests** (`snap()` builder as in `joiner.test.ts`):
  - `dialTargets`: hosts and other unattached, not members, not me, not joining peers.
  - `planAfterDial`: nothing reached → none; one host → join; two hosts → merge both; one host + one unattached → merge; only unattached → merge with `groups: []`; mobile me + desktop host among two → join the desktop group; desktop me + mobile hosts → merge.
  - `group with an unlinked member is not whole`: group A (a, a1), linked {a} → `mergeComplete` false, `commitPlan(groups [A])` null; linked {a, a1} plus group B whole → commit both.
  - `commitPlan` with linked unattached u and no whole group → `{groups: [], peers: [u]}`; one whole group only → null.
  - `links to joining or unattached peers are never closed`: me member of A, linked {host a, joining n, unattached u} → `[]`.
  - `links to peers gone from the room are closed`.
  - `member closes links to other hosts`; `host closes links to members of other groups`; `waiting peer keeps settled links`.
- [ ] **Step 2: Run** `npm test -- merge` in `web/` → FAIL.
- [ ] **Step 3: Implement** `merge.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Add bridge merge decisions for browser client`

---

### Task 3: Shared link registry with glare rule

**Files:**
- Create: `web/src/links.ts`
- Modify: `web/src/peer.ts` (`Connection` gains `dialedByMe`; dialer writes into `Links`), `web/src/host.ts` (accepts every offer; writes into `Links`)
- Test: `web/test/links.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Link { close(): void; dialedByMe: boolean }
export class Links<L extends Link> {
  constructor(myId: () => string);
  /** Keeps exactly one link per peer; closes the loser. Returns whether `link` was kept. */
  add(peerId: string, link: L): boolean;
  /** Forgets `link` only if it is the current one for `peerId` (a stale close must not evict its replacement). */
  remove(peerId: string, link: L): void;
  get(peerId: string): L | undefined;
  ids(): Set<string>;
  close(peerIds: Iterable<string>): void;
  onChange(cb: () => void): void;  // fires after add/remove/close changed the set
}
```

- `add` rule: no existing → keep. Same `dialedByMe` as existing → new replaces (a retry). Different direction → keep the one with `dialedByMe === (myId < peerId)`, close the other.
- `peer.ts`: `createDialer(sig, links: Links<Connection>, onConnected)`; on success `links.add(hostId, conn)`; the dial resolves either way (the peer is reachable). Every `Connection`'s pc removes itself via `links.remove` on `connectionstatechange` to `failed`/`closed`.
- `host.ts`: renamed role "acceptor" but same file and `createHost(sig, links, onConnected)`; answers every offer regardless of my view; a new offer from X replaces only an in-flight or accepted (`dialedByMe: false`) connection from X, never one I dialed; on success `links.add(from, conn)`. `closeAll` is removed (pruning moves to `main.ts`).

- [ ] **Step 1: Failing tests** with fake links (`{ close: vi.fn(), dialedByMe }`), `myId` "m":
  - `first link is kept`; `retry in the same direction replaces and closes the old`.
  - `glare keeps the lower id's offer on both sides`: side "a" (peer "b") and side "b" (peer "a") each `add` a dialed link and an accepted link in opposite orders → on both sides the kept link is the one "a" offered (a's dialed, b's accepted), and the other is closed exactly once.
  - `stale remove does not evict the replacement`.
  - `close closes and forgets`; `onChange fires on add, remove and close`.
- [ ] **Step 2: Run** `npm test -- links` → FAIL.
- [ ] **Step 3: Implement** `links.ts`, then rewire `peer.ts` and `host.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS (`main.ts` will not compile until Task 5 if signatures changed: update its calls minimally here so typecheck passes).
- [ ] **Step 5: Commit** `Share one link per peer between dialer and host`

---

### Task 4: Joiner bridge flow

**Files:**
- Modify: `web/src/joiner.ts`
- Test: `web/test/joiner.test.ts` (keep every 3a test passing; adapt only where 3a's "first success wins / abort the rest" is replaced below)

**Interfaces:**
- Consumes: `dialTargets`, `planAfterDial`, `mergeComplete`, `commitPlan`, `MERGE_TIMEOUT_MS` (Task 2); `ClientMessage`, `ErrorCode` (Task 1).
- Produces:

```ts
constructor(deps: {
  send(msg: ClientMessage): void;
  dial: Dial;
  device: Device;
  linked(): ReadonlySet<string>;
  timeoutMs?: number;       // dial phase, default DIAL_TIMEOUT_MS
  mergeTimeoutMs?: number;  // default MERGE_TIMEOUT_MS
});
onMergeRequest(bridgeId: string): void;  // server asked me (a member) to reach a bridge
onLinksChanged(): void;                  // a link opened or closed; may finish a merge early
onError(code: ErrorCode): void;          // server error; a commit in flight is treated as rejected
```

Behavior changes from 3a:
- Dial phase targets `dialTargets(...)` (hosts + other unattached). It ends when **every** dial settled or `timeoutMs` passed (unsettled dials are aborted; successful ones are **not** aborted). Then `planAfterDial`:
  - `none` → as 3a (`unattached` if I was joining, view `failed`).
  - `join` → send `joined`, `pendingGroup` as 3a.
  - `merge` → send `merge-start {groups, unattached}`, view `connecting`, start a `mergeTimeoutMs` timer. Finish early when `mergeComplete(room, groups, linked())` on any `onRoom`/`onLinksChanged`. On finish: `commitPlan(...)` → send `merge-commit`, phase `committing`; null → `join` the first planned group whose host is still linked, else back to `none` handling.
- `committing`: my status turns `host` in a snapshot → done (view `host`). `onError` → forget attempts and dial again from the current snapshot.
- Retry trigger while `unattached`: any id in `dialTargets` not yet attempted.
- `onMergeRequest(bridgeId)`: only while my view is `member` and no dial to that bridge is running: `dial(bridgeId, signal)` with its own `timeoutMs` abort; result ignored (the bridge sees the link).

- [ ] **Step 1: Failing tests** (`linked` is a test-controlled `Set`):
  - `dials hosts and unattached`: one group + one unattached → dial called for both.
  - `waits for every dial before deciding`: h1 resolves, h2 still pending → nothing sent; h2 resolves → `merge-start {groups:[g1,g2], unattached:[]}`.
  - `single reachable host joins`: two hosts, h2 rejects, h1 resolves → `joined g1` once all settled; h1's signal not aborted.
  - `timeout decides with what was reached`: h1 resolves, h2 hangs, advance 5000 → `joined g1`, h2 aborted.
  - `merge commits when every member links`: g1 has member x → after `merge-start`, add x to `linked`, `onLinksChanged()` → `merge-commit {groups:[g1,g2], peers:[h1,x,h2]}` (order: snapshot order).
  - `merge timeout commits what is whole`: x never links, advance 5000 → commit with g2 only plus any unattached; if that fails the validity rule → `joined g1`.
  - `mobile joins desktop host instead of merging`.
  - `rejected commit redials from the current snapshot`: after `merge-commit`, `onError("bad-state")` then `onRoom` with a single group hosted by n2 → dial n2.
  - `merge request makes a member dial the bridge`: view member → `onMergeRequest("n")` → dial("n"); a second request while pending → no second dial; as host → nothing.
  - `unattached retries when a new unattached peer appears`.
- [ ] **Step 2: Run** `npm test -- joiner` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Add bridge merge flow to join state machine`

---

### Task 5: Wiring, pruning and three-tab check

**Files:**
- Modify: `web/src/main.ts`

**Interfaces:**
- Consumes: `Links` (Task 3), `linksToClose` (Task 2), new `Joiner` deps and methods (Task 4), `merge-request` (Task 1).

- One `Links<Connection>` (`myId` from `welcome`) shared by dialer and host; `links.onChange` → `joiner.onLinksChanged()`.
- After every `welcome`/`room` is handed to the joiner: `links.close(linksToClose(myId, room, links.ids()))`.
- `merge-request` → `joiner.onMergeRequest(m.bridgeId)`; `error` → `joiner.onError(m.code)` (still logged).
- Offers are answered in every view (no `view.kind === "host"` gate).
- Status line shows the path of the link to my host (member) or the latest member link (host); clear it when I have no relevant link.
- Dev-only test hook: when `import.meta.env.DEV` and the page has `?alone=1`, send `start-alone` right after `welcome` instead of dialing (forces a second group). Not present in production builds.

- [ ] **Step 1:** Implement the wiring.
- [ ] **Step 2: Run** `npm test && npm run build` → PASS; `grep -c "alone" dist/assets/*.js` shows the hook string is absent.
- [ ] **Step 3: Three-tab check against a local server** (`cd server && npm run dev`, pages with `?signal=ws://localhost:8787/ws&room=m1`): tab A normal → host; tab B `&alone=1` → second host; tab C normal → within ~6 s A and B both show `그룹에 연결됨 · 호스트 <C>` and C shows `연결된 사람 2명`. Then close C → A and B fall back per the interim rule (one starts alone, the other joins it).
- [ ] **Step 4: Commit** `Wire bridge merge into browser client`

---

### Task 6: Deploy and device check (manual, with the user)

**Files:**
- Modify: `docs/designs/wifi-chat.md` (results section)

- [ ] **Step 1:** `cd server && npm run deploy`, then `cd web && npm run build && npx wrangler pages deploy dist --project-name wifi-chat --branch main`.
- [ ] **Step 2:** Re-run the 3a two-tab check against `https://wifi-chat.pages.dev` (regression).
- [ ] **Step 3:** With the user: laptop + phone in `?room=집` still form one group; record the `경로:` verdict left unrecorded in 3a.
- [ ] **Step 4:** Write results under "Bridge Merge Results (Next Steps 3b)" in the design doc; commit `Record bridge merge check`.
