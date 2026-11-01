# Chat Relay (Next Steps 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People in one group actually talk: each device gets an automatic nickname, messages go member → host → everyone over the existing DataChannels, every device keeps the last 100 messages in memory only, and the room shows who is here (with 30 s "잠시 자리 비움").

**Architecture:** All chat logic is pure and unit-tested in `web/src/chat/`: the wire format and its validation (`wire.ts`), a capped, de-duplicating message list (`history.ts`), the host's relay and roster (`hostHub.ts`) and the member side (`memberChat.ts`). A small `session.ts` switches between the two roles as my view changes and attaches them to the `control` DataChannel of each link. `main.ts`/`ui.ts` render the chat screen. The signaling server is untouched.

**Tech Stack:** TypeScript, vitest, Vite, Cloudflare Pages.

**Spec:** `docs/designs/wifi-chat.md` (메시지와 기록, 접속자 표시, 신뢰 모델, Success Criteria). Previous plans: `2026-11-01-browser-connection.md` (3a), `2026-11-01-bridge-merge.md` (3b); their Global Constraints still hold.

## Scope

In: auto nickname, star relay through the host, history (≤ 100, memory only) including the host's history sent to a member when it says hello, roster with host tag and 30 s away state, input/validation limits, chat screen, deploy, device check.

Out: term numbers on messages, succession, demotion (Next Steps 5); meeting-mode anonymity ("익명 3"), the "호스트는 보낸 사람을 알 수 있어요" notice, QR, wireframe polish (6). Messages are not signed (spec: 신뢰 모델).

## Global Constraints

- Message content, nicknames and rosters travel **only** over WebRTC DataChannels. Nothing new is ever sent to the signaling server.
- Nothing is written to `localStorage`, `sessionStorage`, IndexedDB or cookies. Closing every tab loses the conversation (spec Success Criteria).
- `MAX_HISTORY = 100`, `MAX_TEXT = 500` code points, `MAX_NICK = 20` code points, `MAX_FRAME = 64 * 1024` bytes (frames longer are dropped before `JSON.parse`).
- `AWAY_MS = 30_000` (spec: 30초 동안 "잠시 자리 비움").
- Host rate limit per sender: `SAY_LIMIT = 20` messages per `SAY_WINDOW_MS = 10_000`; extra messages are dropped silently.
- All user-supplied text (messages, nicknames) is rendered with `textContent`, never `innerHTML`.
- Copy (Korean): input placeholder `메시지 입력`, button `보내기`, own-nickname line `내 닉네임: <nick>`, away suffix `잠시 자리 비움`, host tag `호스트`, disabled-input notice when I have no group link `연결되면 메시지를 보낼 수 있어요`.

## Rulings baked into this plan

- **Nickname lives in memory only** (new nickname on every page load): the spec forbids browser storage for history and is silent on nicknames; memory-only keeps "모든 탭을 닫으면 아무것도 남지 않는다" simple. Cost: family members see a different nickname after each reload.
- **History on join:** the host sends its current history in reply to a member's `hello`; the member unions it with what it already has (de-duplicated by message id). No history exchange from members to a new bridge host on merge: after a merge each device keeps its own past and new messages flow to everyone.
- **Message ids are made by the sender** (`crypto.randomUUID()`), so a message relayed twice (e.g. via a merge) is shown once. Order = host receive time `at`, ties by id.
- **The host is the only judge of who said what:** a member's `say` carries no sender fields; the host stamps `from`/`nick` from the link it arrived on and the nickname that link announced in `hello`.
- **Only links to my own members are attached to the hub.** Links to joining/unattached peers (kept open by 3b for merges) never relay chat.

## Review Focus

1. **Markup or control characters in a nickname or message** — shown literally, never interpreted; nickname trimmed and stripped of control characters. Task 1 test `nickname is cleaned`; Task 4 manual check sends `<b>x</b>`.
2. **A `say` from a link that is not one of my members** (a joining bridge, an unattached peer) or from a member before `hello` — dropped. Task 2 tests `frames from unknown links are ignored`, `say before hello is ignored`.
3. **My role changes mid-conversation** (host merged into a bridge's group, member promoted) — the old role stops, history stays on screen. Task 4 test `role change keeps history and swaps roles`.
4. **Flood** (a modified client sends hundreds of messages) — rate limit drops the excess and history never exceeds 100. Task 2 test `rate limit drops excess per sender`; Task 1 test `history keeps the newest 100`.
5. **Oversized or malformed frames** — dropped without throwing. Task 1 tests `rejects oversized frames` and `rejects malformed frames`.

---

### Task 1: Wire format, nickname, history

**Files:**
- Create: `web/src/chat/wire.ts`, `web/src/chat/nickname.ts`, `web/src/chat/history.ts`
- Test: `web/test/chat/wire.test.ts`, `web/test/chat/nickname.test.ts`, `web/test/chat/history.test.ts`

**Interfaces:**
- Produces:

```ts
// wire.ts
export const MAX_TEXT = 500, MAX_NICK = 20, MAX_FRAME = 64 * 1024, MAX_HISTORY = 100;
export interface ChatMessage { id: string; from: string; nick: string; text: string; at: number }
export interface RosterEntry { peerId: string; nick: string; host: boolean; away: boolean }
export type ToHost = { t: "hello"; nick: string } | { t: "say"; id: string; text: string };
export type ToMember =
  | { t: "msg"; msg: ChatMessage }
  | { t: "history"; msgs: ChatMessage[] }
  | { t: "roster"; people: RosterEntry[] };
export function parseToHost(raw: unknown): ToHost | null;
export function parseToMember(raw: unknown): ToMember | null;
export function cleanText(s: string, max: number): string; // strips C0/C1 controls except "\n", trims, cuts to `max` code points

// nickname.ts
export function makeNickname(random: () => number): string; // "<형용사> <동물>", e.g. "졸린 고양이"

// history.ts
export class History {
  add(msg: ChatMessage): boolean;          // false if the id is already present
  merge(msgs: ChatMessage[]): void;
  list(): ChatMessage[];                   // ordered by at, then id; at most MAX_HISTORY (newest kept)
  onChange(cb: () => void): void;
}
```

- `parseToHost`/`parseToMember` take the raw `MessageEvent.data`: non-string or longer than `MAX_FRAME` → null; bad JSON → null; rebuild objects from known fields only; empty text after `cleanText` → null; `history.msgs` longer than `MAX_HISTORY` → null.
- Nickname word lists: at least 16 adjectives and 16 animals, all short Korean words; result ≤ `MAX_NICK`.

- [ ] **Step 1: Failing tests.**
  - `wire`: valid `hello`/`say`/`msg`/`history`/`roster` round-trip with extra fields dropped; `rejects oversized frames` (`"x".repeat(MAX_FRAME + 1)`), `rejects malformed frames` (non-string, `"nope"`, `[]`, unknown `t`, `say` without id, `text: 5`, roster entry missing `away`); `say` text of 600 chars is cut to 500; whitespace-only text → null.
  - `nickname`: `makeNickname(() => 0)` and `makeNickname(() => 0.999)` are different, both match `/^\S+ \S+$/`, length ≤ 20; `nickname is cleaned`: `parseToHost('{"t":"hello","nick":"  a\\u0007b  "}')` → nick `"ab"`; 25-char nick cut to 20; empty nick → null.
  - `history`: add + list order by `at` then id; duplicate id → `add` false and no change; `history keeps the newest 100` (add 150 → 100 left, first is #51); `merge` unions and fires `onChange` once.
- [ ] **Step 2: Run** `cd web && npm test -- chat` → FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Add chat wire format, nicknames and history`

---

### Task 2: Host relay and roster

**Files:**
- Create: `web/src/chat/hostHub.ts`
- Test: `web/test/chat/hostHub.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:

```ts
export const AWAY_MS = 30_000, SAY_LIMIT = 20, SAY_WINDOW_MS = 10_000;
export class HostHub {
  constructor(deps: { myId: string; myNick: string; history: History; send(peerId: string, frame: string): void; now(): number });
  attach(peerId: string): void;            // a member link opened
  detach(peerId: string): void;            // its link closed → away for AWAY_MS, then gone
  onFrame(peerId: string, raw: unknown): void;
  say(text: string): void;                 // the host's own message
  roster(): RosterEntry[];                 // me first (host: true), then members in attach order
  onRoster(cb: () => void): void;
  close(): void;                           // stop: clear timers, forget members (history untouched)
}
```

Rules: frames from a peer that is not attached are ignored. `hello` sets that member's nick, replies `history` (full `history.list()`) to it, then broadcasts `roster` to every attached member. `say` before `hello` is ignored; otherwise rate-limit, build `ChatMessage { id, from: peerId, nick, text, at: now() }`, `history.add` (duplicate id → stop), send `msg` to every attached member that said hello (including the sender, so it sees the host's `at`). `say()` by the host does the same with `from: myId`. `detach` marks away and broadcasts roster; after `AWAY_MS` the entry disappears and roster is broadcast again; re-`attach` of the same peerId before that clears away. Roster lists only members that said hello.

- [ ] **Step 1: Failing tests** (fake `send` recording `[peerId, parsed frame]`, `now` from vitest fake timers):
  - `hello gets history and everyone gets the roster`.
  - `say is stamped by the host and relayed to all`: member "a" sends `{t:"say", id:"m1", text:"hi", from:"evil"}` → every hello'd member gets `msg` with `from:"a"`, a's nick, `at` = now; history has it.
  - `host say reaches every member`.
  - `frames from unknown links are ignored`; `say before hello is ignored`; `duplicate message id is relayed once`.
  - `rate limit drops excess per sender`: 25 says in one window → 20 relayed; after `SAY_WINDOW_MS` more are accepted; another member is unaffected.
  - `detach marks away then removes after 30 s`; `reattach before 30 s clears away`.
  - `close stops timers and keeps history`.
- [ ] **Step 2: Run** `npm test -- hostHub` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Add host chat relay and roster`

---

### Task 3: Member side

**Files:**
- Create: `web/src/chat/memberChat.ts`
- Test: `web/test/chat/memberChat.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:

```ts
export class MemberChat {
  constructor(deps: { myNick: string; history: History; send(frame: string): void; newId(): string });
  open(): void;                            // host link is open: send hello
  onFrame(raw: unknown): void;             // msg → history.add, history → history.merge, roster → store
  say(text: string): boolean;              // false if the cleaned text is empty
  roster(): RosterEntry[];
  onRoster(cb: () => void): void;
}
```

The member does not add its own message to history on `say`; it appears when the host relays it back (single source of order and `at`).

- [ ] **Step 1: Failing tests:** `open sends hello with my nick`; `say sends a cleaned say with a fresh id` (text `"  hi  "` → `"hi"`; whitespace-only → returns false, nothing sent); `msg and history land in history`; `roster is stored and announced`; `malformed frames are ignored`.
- [ ] **Step 2: Run** `npm test -- memberChat` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Add member chat side`

---

### Task 4: Session wiring and chat screen

**Files:**
- Create: `web/src/chat/session.ts`, `web/src/ui.ts`
- Modify: `web/src/main.ts`, `web/src/style.css`
- Test: `web/test/chat/session.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `View` (joiner), `Links`/`Connection` (3b).
- Produces:

```ts
/** What session.ts needs from a link: its control channel. */
export interface ChannelLike { send(data: string): void; addEventListener(type: "message" | "close", cb: (e: { data?: unknown }) => void): void; readyState: string }
export class ChatSession {
  constructor(deps: { myNick: string; history: History; channel(peerId: string): ChannelLike | undefined; myId(): string; now(): number; newId(): string });
  update(view: View): void;                // call on every view change and every links change
  say(text: string): boolean;              // routes to hub (host) or member chat; false when I cannot send
  canSend(): boolean;                      // host, or member with an open channel to my host
  roster(): RosterEntry[];
  onChange(cb: () => void): void;          // roster or history changed
}
```

Rules for `update`: view `host` → ensure a `HostHub`; attach every member in `view.members` whose channel exists and is not attached yet (hooking its `message` → `hub.onFrame`, `close` → `hub.detach`); detach members no longer in `view.members`. View `member` → ensure a `MemberChat` for `view.hostId` once its channel exists (hook `message`, call `open()`); a different hostId replaces it. Any role change closes the previous role object. History is never cleared.

UI (`ui.ts`, called from `main.ts` render): under the existing status section, when view is `host` or `member`: `내 닉네임: <nick>` line; roster line (`<nick>` for each, `호스트` tag on the host, `(잠시 자리 비움)` when away, `(나)` on me); message list (newest at the bottom, `<nick>: <text>`, own messages styled `.mine`); a form with `<input placeholder="메시지 입력" maxlength="500">` and `보내기` button, disabled with `연결되면 메시지를 보낼 수 있어요` when `!canSend()`. Enter submits; the input clears after a successful send. Re-render must not drop what the user is typing (keep the form element, re-render only the list and roster).

- [ ] **Step 1: Failing tests** (`session.test.ts`, fake channels with `emit(type, data)`):
  - `host attaches member channels and relays`: view host with members ["a"] → a's fake channel gets nothing until it sends hello, then gets `history` and `roster`.
  - `member opens hello to its host`.
  - `role change keeps history and swaps roles`: host with a message in history → `update` to member of "n" → hub closed (a's channel no longer relayed), `MemberChat` sends hello to n, history still has the message.
  - `canSend`: false while connecting/failed or member without channel; true as host.
- [ ] **Step 2: Run** `npm test -- session` → FAIL.
- [ ] **Step 3: Implement** `session.ts`, then `ui.ts`, `main.ts` wiring (`makeNickname(Math.random)` once per load; `session.update` on joiner view change and `links.onChange`), styles.
- [ ] **Step 4: Run** `npm test && npm run build` → PASS.
- [ ] **Step 5: Three-tab check** against a local server (`server: npm run dev`, pages `?signal=ws://localhost:8787/ws&room=c1`): tabs A, B, C in one group; B sends `안녕`, A sends `<b>x</b>` → all three show both lines, the second literally; roster on each shows three nicknames with `호스트` on A; close C → A and B show C `(잠시 자리 비움)`, gone after ~30 s; open D → D shows the earlier messages (history on hello).
- [ ] **Step 6: Commit** `Add chat screen and session wiring`

---

### Task 5: Deploy and device check (manual, with the user)

**Files:**
- Modify: `docs/designs/wifi-chat.md` (results section)

- [ ] **Step 1:** `cd web && npm run build && npx wrangler pages deploy dist --project-name wifi-chat --branch main` (server unchanged).
- [ ] **Step 2:** Headless two-tab check on `https://wifi-chat.pages.dev`: a message from each tab appears in both.
- [ ] **Step 3:** With the user: laptop + phone in one group exchange messages both ways; reload both → conversation gone.
- [ ] **Step 4:** Record results under "Chat Relay Results (Next Steps 4)"; commit `Record chat relay check`.
