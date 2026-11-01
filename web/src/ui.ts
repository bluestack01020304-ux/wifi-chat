import type { History } from "./chat/history";
import type { ChatSession } from "./chat/session";
import { MAX_TEXT } from "./chat/wire";

export const CHAT_COPY = {
  placeholder: "메시지 입력",
  send: "보내기",
  myNick: "내 닉네임",
  away: "잠시 자리 비움",
  hostTag: "호스트",
  me: "나",
  cannotSend: "연결되면 메시지를 보낼 수 있어요",
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export interface ChatViewDeps {
  myNick: string;
  history: History;
  session: ChatSession;
  myId(): string;
}

/**
 * The chat area. Built once and kept, so re-rendering never drops what the
 * user is typing; only the roster, the list and the form state are refreshed.
 * Every user-supplied string goes through textContent.
 */
export function createChatView(root: HTMLElement, deps: ChatViewDeps): { render(show: boolean): void } {
  const box = el("section", undefined, "chat");
  const nickLine = el("p", `${CHAT_COPY.myNick}: ${deps.myNick}`, "my-nick");
  const roster = el("p", undefined, "roster");
  const list = el("ol", undefined, "messages");
  const form = el("form", undefined, "composer");
  const input = el("input");
  input.placeholder = CHAT_COPY.placeholder;
  input.maxLength = MAX_TEXT;
  input.autocomplete = "off";
  const button = el("button", CHAT_COPY.send);
  button.type = "submit";
  const notice = el("p", CHAT_COPY.cannotSend, "notice");
  form.append(input, button);
  box.append(nickLine, roster, list, form, notice);
  root.append(box);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (deps.session.say(input.value)) input.value = "";
    input.focus();
  });

  function renderRoster(): void {
    const me = deps.myId();
    // The host may have numbered my nickname ("졸린 거북이 2"); show what others see.
    const shown = deps.session.roster().find((p) => p.peerId === me)?.nick ?? deps.myNick;
    nickLine.textContent = `${CHAT_COPY.myNick}: ${shown}`;
    roster.replaceChildren(
      ...deps.session.roster().map((p) => {
        const item = el("span", undefined, p.away ? "person away" : "person");
        item.append(el("span", p.nick, "nick"));
        if (p.peerId === me) item.append(el("span", ` (${CHAT_COPY.me})`));
        if (p.host) item.append(el("span", CHAT_COPY.hostTag, "tag"));
        if (p.away) item.append(el("span", ` (${CHAT_COPY.away})`));
        return item;
      }),
    );
  }

  function renderList(): void {
    const me = deps.myId();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(
      ...deps.history.list().map((m) => {
        const li = el("li", undefined, m.from === me ? "mine" : undefined);
        li.append(el("span", m.nick, "nick"), el("span", m.text, "text"));
        return li;
      }),
    );
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  return {
    render(show: boolean) {
      box.hidden = !show;
      if (!show) return;
      renderRoster();
      renderList();
      const can = deps.session.canSend();
      input.disabled = !can;
      button.disabled = !can;
      notice.hidden = can;
    },
  };
}
