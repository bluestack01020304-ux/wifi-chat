import QRCode from "qrcode";
import type { Mode } from "../../server/src/roomKey";
import type { History } from "./chat/history";
import type { Note } from "./chat/notes";
import type { ChatSession } from "./chat/session";
import { MAX_TEXT, type RosterEntry } from "./chat/wire";
import type { View } from "./joiner";
import { MAX_ROOM, meetingKey, type RoomInfo, roomLink } from "./roomLink";

export const COPY = {
  finding: "같은 Wi-Fi에서 방을 찾는 중…",
  others: (n: number) => (n === 0 ? "아직 아무도 없어요" : `우리 네트워크에 ${n}명이 있어요`),
  youAre: "당신은",
  reroll: "다시",
  anonymous: "익명으로 참여해요",
  enter: "들어가기",
  footer1: "메시지는 이 Wi-Fi 밖으로 나가지 않아요.",
  footer2: "방에 아무도 없으면 대화도 사라져요.",
  people: (n: number) => `이 네트워크 안에서만 · ${n}명 접속 중`,
  chip: { family: "외부 전송 없음", meeting: "익명 · 끝나면 삭제" } satisfies Record<Mode, string>,
  modeChip: { family: "익명 OFF", meeting: "익명 ON" } satisfies Record<Mode, string>,
  meetingNotices: [
    "이 링크를 가진, 같은 네트워크의 사람만 들어올 수 있어요",
    "호스트는 보낸 사람을 알 수 있어요",
    "호스트는 메시지를 빠뜨리거나 고칠 수 있어요",
  ],
  connecting: "연결 중…",
  waiting: "아직 이 Wi-Fi에 다른 사람이 없어요. 기다리는 중",
  aloneBanner: "아직 나와 연결된 사람이 없어요",
  failed: "이 Wi-Fi의 다른 사람과 연결할 수 없어요. 같은 Wi-Fi가 아니거나, 이 네트워크가 기기 간 연결을 막고 있어요",
  startAlone: "따로 시작하기",
  closed: "중개 서버와 연결이 끊겼어요. 새로고침해 주세요",
  hostTag: "호스트",
  away: "잠시 자리 비움",
  me: "나",
  placeholder: "메시지 입력",
  send: "보내기",
  cannotSend: "연결되면 메시지를 보낼 수 있어요",
  makeRoom: "다른 방 만들기",
  roomName: "방 이름",
  family: "가족",
  meeting: "회의",
  makeLink: "링크 만들기",
  copyLink: "링크 복사",
  copied: "복사했어요",
  goRoom: "이 방으로 가기",
  roomTooLong: `방 이름은 ${MAX_ROOM}자까지예요`,
  roomEmpty: "방 이름을 입력해 주세요",
  badUrl: "이 방 주소가 올바르지 않아요",
  toDefault: "기본 방으로 가기",
  path: "경로",
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** The page asked for a room the server would refuse. */
export function showBadUrl(root: HTMLElement, home: string): void {
  const box = el("section", undefined, "screen bad-url");
  const link = el("a", COPY.toDefault);
  link.href = home;
  box.append(el("p", COPY.badUrl, "bad"), link);
  root.replaceChildren(box);
}

export interface UiState {
  view: View;
  socketClosed: boolean;
  entered: boolean;
  /** Other peers in the room snapshot; null until the server's welcome. */
  othersInRoom: number | null;
  myNick: string;
  path: string;
  notes: Note[];
}

export interface AppDeps {
  room: RoomInfo;
  page: URL;
  history: History;
  session: ChatSession;
  myId(): string;
  onEnter(): void;
  onReroll(): void;
  onStartAlone(): void;
}

/** Initial of a name for its avatar circle: the number for "익명 N", else the first letter of the last word. */
const initial = (nick: string) => /^익명 (\d+)$/.exec(nick)?.[1] ?? Array.from(nick.split(" ").at(-1) ?? nick)[0] ?? "?";

/**
 * Builds the entry and room screens once and refreshes them in place, so
 * typed text and focus survive every render. All user text uses textContent.
 */
export function createApp(root: HTMLElement, deps: AppDeps): { render(s: UiState): void } {
  const meeting = deps.room.mode === "meeting";
  const notices = () => {
    const box = el("div", undefined, "notices");
    for (const line of COPY.meetingNotices) box.append(el("p", line));
    return box;
  };

  // Entry screen.
  const entry = el("section", undefined, "screen entry");
  const finding = el("p", COPY.finding, "muted");
  const entryAvatar = el("div", undefined, "avatar big");
  const who = el("p", undefined, "who");
  const reroll = el("button", COPY.reroll, "link-button");
  reroll.type = "button";
  reroll.addEventListener("click", () => deps.onReroll());
  const enter = el("button", COPY.enter, "primary");
  enter.type = "button";
  enter.addEventListener("click", () => deps.onEnter());
  entry.append(finding, entryAvatar, who, enter, el("p", COPY.footer1, "muted small"), el("p", COPY.footer2, "muted small"));
  if (meeting) entry.append(notices());

  // Room screen.
  const roomScreen = el("section", undefined, "screen room");
  const header = el("header", undefined, "room-header");
  const peopleLine = el("p", undefined, "muted small");
  header.append(el("h1", deps.room.room), peopleLine, el("span", COPY.chip[deps.room.mode], "chip"));
  if (meeting) header.append(notices());
  const status = el("div", undefined, "status");
  const avatars = el("ul", undefined, "avatars");
  const list = el("ol", undefined, "messages");
  const form = el("form", undefined, "composer");
  const input = el("input");
  input.placeholder = COPY.placeholder;
  input.maxLength = MAX_TEXT;
  input.autocomplete = "off";
  const send = el("button", "↑", "send");
  send.type = "submit";
  send.setAttribute("aria-label", COPY.send);
  form.append(el("span", COPY.modeChip[deps.room.mode], "chip"), input, send);
  const cannot = el("p", COPY.cannotSend, "muted small cannot");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (deps.session.say(input.value)) input.value = "";
    input.focus();
  });
  roomScreen.append(header, status, avatars, list, form, cannot, roomPanel(deps.page));

  root.replaceChildren(entry, roomScreen);

  function renderStatus(s: UiState): void {
    const parts: HTMLElement[] = [];
    const v = s.view;
    if (s.socketClosed) parts.push(el("p", COPY.closed, "bad"));
    else if (v.kind === "connecting") parts.push(el("p", COPY.connecting, "muted"));
    else if (v.kind === "failed") {
      const button = el("button", COPY.startAlone);
      button.type = "button";
      button.addEventListener("click", () => deps.onStartAlone());
      parts.push(el("p", COPY.failed, "bad"), button);
    } else if (v.kind === "host" && v.members.length === 0) {
      parts.push(el("p", COPY.aloneBanner, "banner"));
      if (v.aloneInRoom) parts.push(el("p", COPY.waiting, "muted"));
    }
    if (s.path) parts.push(el("p", `${COPY.path}: ${s.path}`, "muted tiny"));
    status.replaceChildren(...parts);
  }

  function renderAvatars(people: RosterEntry[]): void {
    const me = deps.myId();
    avatars.replaceChildren(
      ...people.map((p) => {
        const li = el("li", undefined, p.away ? "person away" : "person");
        li.append(el("span", initial(p.nick), "avatar"), el("span", p.nick + (p.peerId === me ? ` (${COPY.me})` : ""), "name"));
        if (p.host) li.append(el("span", COPY.hostTag, "tag"));
        if (p.away) li.append(el("span", COPY.away, "tiny muted"));
        return li;
      }),
    );
  }

  function renderList(notes: Note[]): void {
    const me = deps.myId();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    type Row = { at: number; node: HTMLElement };
    const rows: Row[] = deps.history.list().map((m) => {
      const li = el("li", undefined, m.from === me ? "bubble mine" : "bubble");
      li.append(el("span", m.nick, "nick"), el("span", m.text, "text"));
      return { at: m.at, node: li };
    });
    for (const n of notes) rows.push({ at: n.at, node: el("li", n.text, "system") });
    rows.sort((a, b) => a.at - b.at);
    list.replaceChildren(...rows.map((r) => r.node));
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  return {
    render(s: UiState) {
      entry.hidden = s.entered;
      roomScreen.hidden = !s.entered;
      if (!s.entered) {
        finding.textContent = s.othersInRoom === null ? COPY.finding : COPY.others(s.othersInRoom);
        entryAvatar.textContent = meeting ? "?" : initial(s.myNick);
        who.replaceChildren();
        if (meeting) who.append(COPY.anonymous);
        else who.append(`${COPY.youAre} `, el("strong", s.myNick), " ", reroll);
        return;
      }
      const people = deps.session.roster();
      peopleLine.textContent = COPY.people(people.length);
      renderStatus(s);
      renderAvatars(people);
      renderList(s.notes);
      const can = !s.socketClosed && deps.session.canSend();
      input.disabled = !can;
      send.disabled = !can;
      cannot.hidden = can;
    },
  };
}

/** "다른 방 만들기": a family or meeting link for this site, with a QR code. */
function roomPanel(page: URL): HTMLElement {
  const panel = el("details", undefined, "room-panel");
  panel.append(el("summary", COPY.makeRoom));
  const form = el("form");
  const name = el("input");
  name.placeholder = COPY.roomName;
  name.maxLength = MAX_ROOM * 2; // emoji count double in UTF-16; the real check is below
  const radios = el("div", undefined, "radios");
  const radio = (value: Mode, label: string) => {
    const wrap = el("label");
    const r = el("input");
    r.type = "radio";
    r.name = "mode";
    r.value = value;
    r.checked = value === "family";
    wrap.append(r, ` ${label}`);
    return wrap;
  };
  radios.append(radio("family", COPY.family), radio("meeting", COPY.meeting));
  const make = el("button", COPY.makeLink);
  make.type = "submit";
  const error = el("p", undefined, "bad small");
  const out = el("div", undefined, "link-out");
  out.hidden = true;
  const linkText = el("input");
  linkText.readOnly = true;
  const copy = el("button", COPY.copyLink);
  copy.type = "button";
  const go = el("a", COPY.goRoom);
  const canvas = el("canvas", undefined, "qr");
  out.append(linkText, copy, go, canvas);
  form.append(name, radios, make, error);
  panel.append(form, out);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const mode = (form.querySelector<HTMLInputElement>("input[name=mode]:checked")?.value ?? "family") as Mode;
    const key = mode === "meeting" ? meetingKey((b) => crypto.getRandomValues(b)) : undefined;
    const link = roomLink(page, name.value, mode, key);
    if (typeof link !== "string") {
      error.textContent = Array.from(name.value.trim()).length > MAX_ROOM ? COPY.roomTooLong : COPY.roomEmpty;
      out.hidden = true;
      return;
    }
    error.textContent = "";
    linkText.value = link;
    go.href = link;
    out.hidden = false;
    void QRCode.toCanvas(canvas, link, { margin: 1, width: 220 });
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(linkText.value);
      copy.textContent = COPY.copied;
      setTimeout(() => (copy.textContent = COPY.copyLink), 1500);
    } catch {
      linkText.select();
    }
  });
  return panel;
}
