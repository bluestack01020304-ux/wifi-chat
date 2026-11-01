# Rooms, Meeting Mode and UI (Next Steps 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app looks and behaves like the approved wireframe: an entry screen (people count, auto nickname with "다시", 들어가기), a room header with the room name, people count and mode chip, avatars with a dashed host tag, chat bubbles, system lines for arrivals and host handovers (with the gap time), and a composer with the 익명 ON/OFF chip. Anyone can make a room link from the page; a meeting room gets an unguessable token and a QR code, shows everyone as "익명 N", and states its trust limits.

**Architecture:** Three new pure, tested modules: `roomLink.ts` (read room/mode/key from the page URL with the server's rules, make a meeting key, build a room link), `chat/notes.ts` (system lines from roster changes) and naming changes inside `HostHub`/`MemberChat`/`ChatSession` (meeting-mode anonymous numbers, names carried across a host handover, nickname re-roll). `ui.ts` is rebuilt around the wireframe; `main.ts` wires it. The signaling server is unchanged (it already validates `room`, `mode`, `key`).

**Tech Stack:** TypeScript, vitest, Vite, `qrcode` (MIT, bundled by Vite; no CDN), Cloudflare Pages.

**Spec:** `docs/designs/wifi-chat.md` (방 키, 신뢰 모델, 와이어프레임 and its "스케치 이후 바뀐 점", Premise 3). Wireframe: `C:\Users\admin\AppData\Local\Temp\gstack-sketch.szTHoV\sketch.png`. Earlier plans' Global Constraints still hold.

## Scope

In: URL room/mode/key reading and validation, room-link panel (family link, meeting link + QR), meeting key generation, entry screen, header, avatars, bubbles, system lines (arrival, host handover with gap), mode chip, meeting anonymity ("익명 N"), meeting notices, nickname re-roll, names kept across succession, deploy, device check including scanning the QR with the phone.

Out: GitHub Actions auto-deploy, IPv6 room split (Open Questions), anything server-side.

## Global Constraints

- Room rules mirror the server (`server/src/roomKey.ts`): room = NFC-normalized, trimmed, default `기본`, at most 40 code points; mode `family` (default) or `meeting`; meeting needs `key` matching `^[A-Za-z0-9_-]{22}$`.
- Meeting key: 16 bytes from `crypto.getRandomValues` (never `Math.random`), base64url without padding = 22 characters.
- The QR is drawn on a `<canvas>` by the bundled `qrcode` package (`QRCode.toCanvas`). No HTML from a library or user text is ever inserted with `innerHTML`.
- Meeting mode: nobody's nickname is shown or sent. A member's `hello` carries `익명` as its nick; the host names every person `익명 N` (N from 1, the host's own number first, in arrival order, never reused while the group lives). Family mode keeps nicknames (with the existing ` 2`, ` 3` numbering).
- Names survive a host handover: a new host seeds its names from the last roster it received as a member.
- Copy (Korean, verbatim):
  - Entry: `같은 Wi-Fi에서 방을 찾는 중…`, `우리 네트워크에 N명이 있어요` (N = other peers in the room snapshot; `아직 아무도 없어요` when 0), `당신은 <nick>` + `다시` button (family) / `익명으로 참여해요` (meeting), button `들어가기`, footer `메시지는 이 Wi-Fi 밖으로 나가지 않아요.` and `방에 아무도 없으면 대화도 사라져요.`
  - Header: `<room>`, `이 네트워크 안에서만 · N명 접속 중` (N = roster length), chip `외부 전송 없음` (family) / `익명 · 끝나면 삭제` (meeting).
  - Meeting notices (entry and header): `이 링크를 가진, 같은 네트워크의 사람만 들어올 수 있어요`, `호스트는 보낸 사람을 알 수 있어요`, `호스트는 메시지를 빠뜨리거나 고칠 수 있어요`.
  - System lines: `<name>님이 Wi-Fi에 들어왔어요`; `호스트가 나갔어요 · <name>님이 이어받았어요` with ` (끊김 0.8초)` when a gap was measured.
  - Composer chip: `익명 OFF` (family) / `익명 ON` (meeting); send button `↑` with `aria-label="보내기"`.
  - Room-link panel: toggle `다른 방 만들기`, input placeholder `방 이름`, radio `가족` / `회의`, button `링크 만들기`, `링크 복사`, `이 방으로 가기`; error `방 이름은 40자까지예요`.
  - Bad URL: `이 방 주소가 올바르지 않아요` + link `기본 방으로 가기`.

## Rulings baked into this plan

- **The device joins its group as soon as the page opens; 들어가기 only reveals the chat.** If chat waited for the button, a host tab nobody clicked would silence its whole group.
- **Re-rolling the nickname is allowed any time in family mode** (the entry screen shows the button; the header nickname stays tappable is out of scope). A re-roll re-sends `hello`; the host renames and broadcasts the roster.
- **System lines are local** (each device derives them from roster changes, never relayed), so they never carry anyone's text and need no new wire frame. The first roster after entering produces no arrival lines.
- **The gap in a handover line** is measured on this device: from losing the channel to my host until the first roster from the new host.
- **People count in the header = my group's roster;** the entry count = other peers in the room snapshot (some may not be reachable yet). This matches each screen's wording.

## Review Focus

1. **Nickname leak in meeting mode** — no frame from a member and no roster/msg from the host may contain a real nickname. Task 2 tests `meeting hello carries no nickname`, `meeting roster and messages show only 익명 N`.
2. **Hostile or odd room names** (emoji, 41+ characters, `&`, `#`, `<script>`) — encoded correctly in links, refused over 40, shown literally. Task 1 tests; Task 4 manual check.
3. **Weak or wrong meeting key** — always 22 base64url chars from `getRandomValues`, and a page with a bad `mode`/`key` shows the bad-URL screen instead of a dead socket. Task 1 tests `meeting key shape`, `bad mode or key is an error`.
4. **Names changing on handover** — "익명 3" stays "익명 3" after the host leaves. Task 2 test `a new host keeps the names it last saw`.
5. **Re-roll or re-render losing typed text or focus** — the composer element survives every render. Task 4 manual check.

---

### Task 1: Room links

**Files:**
- Create: `web/src/roomLink.ts`
- Test: `web/test/roomLink.test.ts`

**Interfaces:**
- Consumes: `Mode` type from `server/src/roomKey.ts` (type-only).
- Produces:

```ts
export const MAX_ROOM = 40;
export interface RoomInfo { room: string; mode: Mode; key: string | null }
export function readRoom(page: URL): RoomInfo | { error: string };    // server's parseRoomParams rules, without device
export function meetingKey(fill: (bytes: Uint8Array) => Uint8Array): string; // 22-char base64url
export function roomLink(base: URL, room: string, mode: Mode, key?: string): string | { error: string }; // keeps base origin+path, drops other params; error when room > 40
```

- [ ] **Step 1: Failing tests:** `readRoom` defaults (`기본`, family, null key); trims and NFC-normalizes; `bad mode or key is an error` (`mode=xyz`, meeting without key, key of 21 chars or with `+`); 41-char room → error. `meeting key shape`: fill with zeros → `"AAAAAAAAAAAAAAAAAAAAAA"`, fill with 0xff → 22 chars matching `^[A-Za-z0-9_-]{22}$` (no `+`, `/`, `=`). `roomLink`: `"3층 회의실&x#y"` round-trips through `readRoom(new URL(link))`; meeting link carries `mode=meeting&key=…`; family link has no `mode`/`key`; drops `signal` and other params of the base; 41 chars → error.
- [ ] **Step 2: Run** `cd web && npm test -- roomLink` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Add room links and meeting keys`

---

### Task 2: Meeting names, carried names, re-roll

**Files:**
- Modify: `web/src/chat/hostHub.ts`, `web/src/chat/memberChat.ts`, `web/src/chat/session.ts`
- Test: `web/test/chat/hostHub.test.ts`, `web/test/chat/memberChat.test.ts`, `web/test/chat/session.test.ts`

**Interfaces:**
- `HostHubDeps` gains `mode: Mode` and `seed?: RosterEntry[]`; new `setMyNick(nick: string): void` (family only; meeting ignores).
  - Meeting: host is `익명 1` unless seeded; each member that says hello gets the next unused number; nick in `hello` is ignored.
  - Seed: entries whose peerId is attached later keep the seeded name (in both modes); seeded numbers are never handed to anyone else; the host's own seeded entry (it was a member) becomes its name.
- `MemberChatDeps` gains `mode: Mode`; meeting `hello` sends nick `익명`. New `setNick(nick: string)`: stores it and re-sends hello (family only).
- `ChatSessionDeps` gains `mode: Mode`; new `setNick(nick)`; when the role switches member → host, the hub is seeded with the member role's last roster.

- [ ] **Step 1: Failing tests:** `meeting hello carries no nickname` (MemberChat meeting → hello nick `익명`); `meeting roster and messages show only 익명 N` (hub meeting: host `익명 1`, members `익명 2`, `익명 3` in hello order; a `say` relays with nick `익명 2`; no frame contains the hello nicks); `numbers are not reused` (detach + 30 s, a new member gets `익명 4`); `a new host keeps the names it last saw` (seed `[{h, 익명 1, host}, {me, 익명 2}, {x, 익명 3}]`, myId me → roster me `익명 2` host, x attaches and says hello → `익명 3`, a newcomer → `익명 4`; same in family mode with `졸린 거북이 2`); `re-roll renames me` (hub `setMyNick` broadcasts roster; MemberChat `setNick` re-sends hello); session `member to host seeds the hub` (fake channels, as in existing session tests).
- [ ] **Step 2: Run** `npm test -- chat` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Add meeting anonymity, carried names and nickname re-roll`

---

### Task 3: System lines

**Files:**
- Create: `web/src/chat/notes.ts`
- Test: `web/test/chat/notes.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Note { at: number; text: string }
/** Lines for the change from the last non-empty roster to the next one. `gapMs` is null when no gap was measured. */
export function rosterNotes(prev: RosterEntry[] | null, next: RosterEntry[], myId: string, now: number, gapMs: number | null): Note[];
```

Rules: `prev === null` (first roster after entering) → `[]`. Host changed (different host peerId) → `호스트가 나갔어요 · <new host name>님이 이어받았어요` + ` (끊김 X.X초)` when `gapMs !== null` (one decimal). Each peerId in `next` not in `prev`, other than me and other than a new host already announced → `<name>님이 Wi-Fi에 들어왔어요`. Departures produce nothing (the roster's away state covers them).

- [ ] **Step 1: Failing tests:** first roster → nothing; arrival line; my own arrival → nothing; handover with gap 834 → `… (끊김 0.8초)`; handover without gap; arrival plus handover in one change → handover first.
- [ ] **Step 2: Run** `npm test -- notes` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Add system lines for arrivals and host handovers`

---

### Task 4: Screens

**Files:**
- Modify: `web/src/ui.ts` (rebuild), `web/src/main.ts`, `web/src/style.css`, `web/package.json` (`qrcode`, `@types/qrcode`)

Layout (one column, max 32rem, 16 px side gutter, light and dark):
- **Bad URL screen** when `readRoom` errors: copy + link to the default room; no socket is opened.
- **Entry screen** (until 들어가기): status line (`같은 Wi-Fi에서 방을 찾는 중…` until welcome, then the count line), a circle avatar, `당신은 <nick>` + `다시` (family) or `익명으로 참여해요` (meeting), `들어가기`, the two footer lines, meeting notices in meeting mode.
- **Room screen**: header (room name, people line, mode chip; meeting notices under it); connection status line only when not `host`/`member` (connecting/failed/closed copy from earlier steps, including `따로 시작하기`); avatar row (circle + name, dashed `호스트` tag, away names dimmed with `잠시 자리 비움`); message list (bubbles; mine right-aligned with a dashed border; system lines centered and muted, merged by time); composer (mode chip, input, `↑`), disabled with the existing notice when `!canSend()`; `다른 방 만들기` panel at the bottom (details/summary): room name input, 가족/회의 radios, `링크 만들기` → shows the link, `링크 복사` (Clipboard API with a selectable-text fallback), `이 방으로 가기`, and for meeting a QR canvas.
- Path status (`경로: …`) stays, small and muted, under the header.
- `main.ts`: `readRoom` first; `ChatSession` gets `mode`; system lines via `rosterNotes` on every roster change, tracking the gap from the member channel loss; `setNick` from the 다시 button.

- [ ] **Step 1:** `npm i qrcode && npm i -D @types/qrcode`; implement.
- [ ] **Step 2: Run** `npm test && npm run build` → PASS; production bundle has no `__muteHeartbeat`/`alone` hooks.
- [ ] **Step 3: Headless checks** (local server; screenshots saved to the scratchpad and looked at): family room with three tabs (entry → 들어가기, avatars with host tag, bubbles, arrival lines, host close → handover line with gap on the others); meeting room via a generated link (everyone `익명 N`, notices shown, no nickname anywhere in the DOM of other tabs); `?mode=xyz` → bad URL screen; a 41-char room in the panel → error; room name `<script>x</script>` shown literally; typing in the composer survives an arrival re-render; phone-width (390 px) screenshot has no horizontal scroll.
- [ ] **Step 4: Commit** `Rebuild screens to the wireframe with room links and QR`

---

### Task 5: Deploy and device check (manual, with the user)

**Files:**
- Modify: `docs/designs/wifi-chat.md` (results section)

- [ ] **Step 1:** `cd web && npm run build && npx wrangler pages deploy dist --project-name wifi-chat --branch main` (server unchanged).
- [ ] **Step 2:** Headless family and meeting checks on `https://wifi-chat.pages.dev`.
- [ ] **Step 3:** With the user: laptop makes a meeting room link and QR; the phone scans the QR and lands in the same meeting room as `익명 N`; a phone on mobile data or without the key cannot join that room.
- [ ] **Step 4:** Record results under "Rooms and UI Results (Next Steps 6)"; commit `Record rooms and UI check`.

---

## Addendum (2026-11-01, user decision after Task 4)

"가족/회의" were only examples; the app is for any place. The single `mode` (family = open + nicknames, meeting = link-only + anonymous) becomes two independent choices:

- **Who can join** — `key` present → only people with the link/QR (22-char base64url, as before); absent → anyone on the same Wi-Fi.
- **How names show** — `anon=1` → everyone is `익명 N`; absent → nicknames.

The server reads `room`, `key`, `anon` (and `device`); `mode` is no longer read. Room key = [network, room, key, anon], so the same link always means the same room. UI copy drops 가족/회의: the panel asks `들어올 수 있는 사람` (`같은 Wi-Fi 누구나` / `링크·QR 받은 사람만`) and `이름 표시` (`닉네임` / `익명`); header chips are `외부 전송 없음`, plus `링크로만` and/or `익명`; the link-only notice and the anonymity notices show independently.

Review fixes folded in: `익명 N` numbers never reuse a number seen in history or the hub's own roster; the entry who-line and the composer keep focus across renders; the entry screen shows a closed socket.
