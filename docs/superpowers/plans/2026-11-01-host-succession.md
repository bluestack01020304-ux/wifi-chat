# Host Succession (Next Steps 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a group's host closes its tab, loses Wi-Fi or stalls (screen off, background tab), the signaling server names the next host within 2 s, the remaining members reconnect to it, and the conversation continues: target 3 s from host tab close to talking again. A stalled old host that comes back is demoted and rejoins as a normal participant, and no message from an old term is ever shown.

**Architecture:** Server-driven, as the spec says. `RoomState` gains a heartbeat clock on host records, a `tick(now)` that runs succession, a 5 s confirmation window per new term, candidate rotation and group dissolution. The Durable Object drives `tick` from a 1 s alarm while any host exists. The browser sends `heartbeat` every second while it is a host, sends `confirm` once it holds a link to its current host and term, closes every link when demoted, and stamps/filters every chat frame with the term.

**Tech Stack:** TypeScript, vitest (+ `@cloudflare/vitest-plugin` for the Durable Object), Cloudflare Workers/Durable Object alarms, Vite, Cloudflare Pages.

**Spec:** `docs/designs/wifi-chat.md` (호스트 승계, Success Criteria: "호스트 탭을 닫으면 3초 안에…", "옛 호스트가 살아 돌아와도 메시지가 두 갈래로 흐르지 않는다"). Previous plans: browser connection (3a), bridge merge (3b), chat relay (4); their Global Constraints still hold.

## Scope

In: heartbeat, 2 s host timeout, immediate succession on host socket close, desktop-first then earliest-joined candidate order, term + 1 on every host change, demotion of a stalled host, per-member reconnect with a 5 s confirm window, rotation to the next candidate when nobody confirmed, dissolution when no candidate is left, term on every chat frame, measurement of the 3 s target, deploy, device check.

Out: succession system message in the chat list and other wireframe UI (Next Steps 6); meeting mode (6).

## Global Constraints

- `HEARTBEAT_MS = 1000` (client send interval), `HOST_TIMEOUT_MS = 2000` (spec: heartbeat가 2초간 없으면), `CONFIRM_WINDOW_MS = 5000` (spec: 새 호스트에 5초 안에), `TICK_MS = 1000` (alarm period while any host exists).
- Candidate order for a group: `desktop` members before `mobile`, then earliest `joinedAt`. A candidate that was already host in this succession chain is not tried again.
- Term: every host change (succession or rotation) sets the group's term to previous + 1. Merge keeps 3b's rule (max + 1).
- A demoted or dissolved peer goes to status `joining` with `groupId: null`, so it runs the normal join flow.
- No new server → client message type: everything is visible in `room` snapshots (`GroupView.term`, `hostId`, statuses).
- The heartbeat and confirm messages carry no content, nickname or address (3a constraint: nothing but signaling reaches the server).

## Rulings baked into this plan

- **Members never leave on their own during succession.** They dial the new host and `confirm`; the server decides at the end of the 5 s window: nobody confirmed → rotate to the next candidate (members stay members and redial); someone confirmed → unconfirmed members go to `joining`. This is the only order in which the spec's "다음 후보로 바꾼다" can ever happen.
- **The unreachable host in a rotation goes to `joining`,** not member: nobody holds a link to it.
- **`confirm` is sent in every membership, not only after succession** (joined, merged, succeeded). The server stores it; it only matters inside a window. One code path on the client.
- **The 3a interim rule (earliest unattached peer starts alone when no group exists) stays.** Succession now covers host loss, so it only fires after a dissolution.
- **A stalled host is demoted by the server alone.** The client learns it from a snapshot where its status is no longer `host`, then closes every link at once (spec 강등: 즉시 중계를 멈추고 모든 DataChannel을 닫는다).

## Review Focus

1. **Host tab closed while a member is mid-merge or mid-dial** — succession must not leave a member in two groups or with a stale `confirm` counted for the wrong term. Task 1 test `confirm for an old term is ignored`.
2. **The stalled old host comes back and keeps relaying** — members must drop its frames (term mismatch) and close its channel. Task 4 test `frames from an old term are dropped`; Task 3 test `demotion closes every link`.
3. **Alarm keeps firing in an empty room** (cost) — the alarm must stop once no host exists. Task 2 test `alarm stops when no host remains`.
4. **Every member fails to reach the new host** (e.g., the new host is a phone whose screen just went off) — rotation to the next candidate, and dissolution when none is left, instead of a group whose host nobody reaches. Task 1 tests `nobody confirmed rotates`, `no candidate left dissolves`.
5. **Heartbeat from a non-host or a flood of heartbeats** — ignored / rate-limited, never turning a member into a host. Task 1 test `heartbeat from a member is ignored`.

---

### Task 1: Succession in RoomState

**Files:**
- Modify: `server/src/protocol.ts`, `server/src/room.ts`
- Test: `server/test/protocol.test.ts`, `server/test/room.test.ts`

**Interfaces:**
- Produces (protocol): `ClientMessage` adds `{ t: "heartbeat" }` and `{ t: "confirm"; groupId: string; term: number }` (term a positive safe integer).
- Produces (room.ts):

```ts
export const HOST_TIMEOUT_MS = 2000, CONFIRM_WINDOW_MS = 5000;
// PeerRecord gains: lastBeat (host: last heartbeat or becoming host), windowStart (host: start of an open confirm window, 0 if none),
// tried (host: peerIds already tried as host in this chain), confirmedTerm (member: last confirmed term, 0 if none).
class RoomState {
  tick(now: number): Outgoing[];   // runs timeouts and window ends; returns a room broadcast if anything changed
  hasHost(): boolean;
}
```

Rules:
- `heartbeat`: only from a `host` (else ignored, no error); sets `lastBeat = now`; counts against the existing signal rate limit; returns `[]`.
- `confirm`: only from a `member` of `groupId` whose host's current term equals `term` (else ignored); sets `confirmedTerm`; returns `[]`.
- `becomeHost` (join, start-alone, merge) sets `lastBeat = now`, `windowStart = 0`, `tried = [self]`.
- **Succession of group G** (from `leave` of its host, or `tick` when `now - lastBeat > HOST_TIMEOUT_MS`): candidates = G's members in candidate order, minus `tried`. None → dissolve G (every member → `joining`, null group). Otherwise the first becomes `host` of G with term + 1, `lastBeat = now`, `tried` = old tried + itself, `windowStart = now` if G still has other members (else 0). The old host, if still in the room, → `joining`.
- **Window end** (`tick` when `windowStart > 0` and `now - windowStart >= CONFIRM_WINDOW_MS`): members with `confirmedTerm === term` stay. None confirmed and members exist → rotate: the current host → `joining`, next untried candidate becomes host as above (or dissolve if none). Some confirmed → every unconfirmed member → `joining`; `windowStart = 0`.
- `leave` of a host runs succession immediately instead of making members `unattached`.

- [ ] **Step 1: Failing tests** (`room.test.ts`, records built directly as in the merge tests; desktop/mobile set per record):
  - protocol: `heartbeat` and `confirm` parse (extra fields dropped); `confirm` with term `0`, `1.5`, `"2"` or empty groupId → `bad-message`.
  - `heartbeat keeps a host alive`: host beats at t=1500 → `tick(3000)` changes nothing.
  - `heartbeat from a member is ignored`: member sends heartbeat → still member, `[]`.
  - `stalled host is replaced, desktop first`: group A (host a term 1; members m1 mobile joined 2, d1 desktop joined 3); `tick(2001)` with no beat → d1 host term 2; a → joining; m1 member of A; broadcast to all.
  - `host leaving hands over at once`: `leave("a")` → d1 host term 2 without waiting.
  - `a lone host leaving dissolves its group`: no members → group gone.
  - `confirm for an old term is ignored`: after succession to term 2, m1 confirms term 1 → window end treats m1 as unconfirmed.
  - `confirmed members stay, others rejoin`: members m1, m2 under new host d1; m1 confirms term 2; `tick(windowStart + 5000)` → m1 member, m2 joining.
  - `nobody confirmed rotates`: no confirms → d1 → joining, m1 host term 3, m2 member; a new window opens.
  - `no candidate left dissolves`: chain where every member was tried → all `joining`, group gone.
  - `merge sets lastBeat and tried`: a bridge host from `merge-commit` is not timed out before 2 s.
- [ ] **Step 2: Run** `cd server && npm test` → new tests FAIL.
- [ ] **Step 3: Implement.** Update the `RoomState` class comment (succession is here now).
- [ ] **Step 4: Run** `npm test && npm run typecheck` in `server/`, then `npm run typecheck` in `web/` → PASS.
- [ ] **Step 5: Commit** `Add host succession to signaling room state`

---

### Task 2: Durable Object alarm

**Files:**
- Modify: `server/src/roomDO.ts`
- Test: `server/test/worker.test.ts`

**Interfaces:**
- Consumes: `RoomState.tick`, `RoomState.hasHost` (Task 1).
- Produces: `TICK_MS = 1000`; `Room.alarm()` rebuilds state from the sockets, runs `tick(Date.now())`, delivers, and sets the next alarm at `now + TICK_MS` only if a host remains. After every `apply()`, if the state has a host and no alarm is pending, schedule one (`ctx.storage.getAlarm()` / `setAlarm()`, fire-and-forget from the sync path).

- [ ] **Step 1: Failing tests** (existing `connect` helpers; `runDurableObjectAlarm` from `cloudflare:test`; real `Date.now()` with short waits is acceptable only where unavoidable, prefer running the alarm after a stale `lastBeat` written via `runInDurableObject`):
  - `a joined host schedules an alarm`.
  - `alarm runs succession for a silent host`: two clients, host never beats; set its attachment `lastBeat` to `Date.now() - 3000` via `runInDurableObject`; run the alarm → the member receives a `room` where it is host with term 2.
  - `alarm stops when no host remains`: after the last socket closes, running the alarm leaves no alarm scheduled.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Drive succession from a Durable Object alarm`

---

### Task 3: Client confirm, demotion and term in views

**Files:**
- Modify: `web/src/joiner.ts`
- Test: `web/test/joiner.test.ts`

**Interfaces:**
- Consumes: protocol `confirm` (Task 1).
- Produces: `View` host and member variants gain `term: number`. `JoinerDeps` gains `onDemoted?(): void`. New behavior:
  - Whenever my status is `member` and I have not confirmed this `(groupId, term)`: if `linked()` has the group's host → send `{t:"confirm", groupId, term}` once; otherwise dial the host (own `AbortController`, `timeoutMs`) and confirm on success. A newer `(groupId, term)` aborts an older confirm dial. Re-checked on every `onRoom` and `onLinksChanged`.
  - When my previous status was `host` and a snapshot shows me `joining` or `unattached` → call `onDemoted()` before starting the join flow.

- [ ] **Step 1: Failing tests:** `member confirms when linked to its host`; `member dials a new host after succession and confirms`: member of g1 under h1 term 1 confirmed → snapshot with h2 host term 2 (not linked) → dial h2 → on success `confirm g1 term 2`; `confirm is sent once per term`; `a newer term aborts the older confirm dial`; `demotion calls onDemoted` (host → joining); `views carry the term`.
- [ ] **Step 2: Run** `cd web && npm test -- joiner` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Confirm membership and detect demotion in joiner`

---

### Task 4: Term on chat frames

**Files:**
- Modify: `web/src/chat/wire.ts`, `web/src/chat/hostHub.ts`, `web/src/chat/memberChat.ts`, `web/src/chat/session.ts`
- Test: the matching files in `web/test/chat/`

**Interfaces:**
- `ToMember` frames (`msg`, `history`, `roster`) gain `term: number` (positive safe integer; missing/invalid → frame rejected). `historyFrame(msgs, term)`.
- `HostHubDeps` gains `term: number`; every frame it sends carries it.
- `MemberChatDeps` gains `term: number`; frames with another term are dropped.
- `ChatSession` reads `term` from the host/member view; a member role is keyed by `(hostId, term)`; a host role whose term changes is replaced (history kept).

- [ ] **Step 1: Failing tests:** wire round-trips with `term`, rejects missing term; hub stamps its term on msg/history/roster; `frames from an old term are dropped` (MemberChat term 2 ignores a term-1 `msg`); session `a new term for the same host replaces the member role`.
- [ ] **Step 2: Run** `npm test -- chat` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Stamp and check the host term on chat frames`

---

### Task 5: Wiring, heartbeat and the 3 s measurement

**Files:**
- Modify: `web/src/main.ts`

- Heartbeat: `setInterval(HEARTBEAT_MS)` sends `{t:"heartbeat"}` while `joiner.view.kind === "host"` and the socket is open.
- `onDemoted` → `links.close(links.ids())`.
- Nothing else changes: confirm runs inside the joiner; pruning (`linksToClose`) already closes the old host's link once the snapshot names the new one.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Run** `npm test && npm run build` in `web/` → PASS.
- [ ] **Step 3: Local three-tab succession check** (`server: npm run dev`, pages `?signal=ws://localhost:8787/ws&room=s1`): A host, B and C members, a message exchanged. Close A and measure, in the script, the time from `A.close()` until a message sent by B appears on C. Expected: B or C becomes host (`호스트` tag moves), the conversation continues, history kept on B and C, measured time ≤ 3 s. Repeat 3 times and record each.
- [ ] **Step 4: Stalled-host check:** freeze A's heartbeat (dev-only `?noheartbeat=1`, guarded by `import.meta.env.DEV`, absent from the production bundle) → within ~2 s B or C becomes host; A shows the connecting/failed flow and then joins the new group as a member; no message A sends while stalled appears on B or C.
- [ ] **Step 5: Commit** `Send host heartbeats and close links on demotion`

---

### Task 6: Deploy and device check (manual, with the user)

**Files:**
- Modify: `docs/designs/wifi-chat.md` (results section)

- [ ] **Step 1:** `cd server && npm run deploy`, then `cd web && npm run build && npx wrangler pages deploy dist --project-name wifi-chat --branch main`.
- [ ] **Step 2:** Headless two-tab regression and three-tab succession timing on `https://wifi-chat.pages.dev`.
- [ ] **Step 3:** With the user: laptop host + phone member chatting; close the laptop tab → phone becomes host; reopen laptop → it joins the phone's group. Phone as host with screen off 3 s → laptop takes over; phone back on → demoted and rejoins.
- [ ] **Step 4:** Record results (including the measured times) under "Host Succession Results (Next Steps 5)"; commit `Record host succession check`.
