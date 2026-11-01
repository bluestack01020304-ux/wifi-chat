import "./style.css";
import { detectDevice, signalUrl } from "./config";
import { createHost } from "./host";
import { Joiner, type View } from "./joiner";
import type { RoomSnapshot } from "../../server/src/protocol";
import { Links } from "./links";
import { linksToClose } from "./merge";
import { createDialer, type Connection } from "./peer";
import { Signaling } from "./signaling";

const COPY = {
  entry: "메시지는 이 Wi-Fi 밖으로 나가지 않아요",
  connecting: "연결 중…",
  waiting: "아직 이 Wi-Fi에 다른 사람이 없어요. 기다리는 중",
  aloneBanner: "아직 나와 연결된 사람이 없어요",
  failed: "이 Wi-Fi의 다른 사람과 연결할 수 없어요. 같은 Wi-Fi가 아니거나, 이 네트워크가 기기 간 연결을 막고 있어요",
  startAlone: "따로 시작하기",
  closed: "중개 서버와 연결이 끊겼어요. 새로고침해 주세요",
};

const VERDICT_LABEL = { host: "host↔host", "prflx-lan": "host↔사설 prflx", "prflx-hidden": "host↔prflx(주소 가림)" } as const;

const app = document.getElementById("app")!;
let socketClosed = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function render(view: View): void {
  app.replaceChildren();
  app.append(el("p", COPY.entry, "entry"));

  const section = el("section", undefined, `view view-${socketClosed ? "closed" : view.kind}`);
  if (socketClosed) {
    section.append(el("p", COPY.closed, "bad"));
  } else if (view.kind === "connecting") {
    section.append(el("p", COPY.connecting));
  } else if (view.kind === "host") {
    if (view.members.length === 0) section.append(el("p", COPY.aloneBanner, "banner"));
    section.append(el("p", view.aloneInRoom ? COPY.waiting : `호스트 · 연결된 사람 ${view.members.length}명`));
  } else if (view.kind === "member") {
    section.append(el("p", `그룹에 연결됨 · 호스트 ${view.hostId.slice(0, 4)}`, "ok"));
  } else {
    section.append(el("p", COPY.failed, "bad"));
    const button = el("button", COPY.startAlone);
    button.addEventListener("click", () => joiner.startAlone());
    section.append(button);
  }
  app.append(section);

  const path = currentPath(view);
  if (path) app.append(el("p", `경로: ${path}`, "status"));
}

/** The path of my link to my host (member), or of my latest member link (host). */
function currentPath(view: View): string {
  const ids = view.kind === "member" ? [view.hostId] : view.kind === "host" ? [...view.members].reverse() : [];
  for (const id of ids) {
    const link = links.get(id);
    if (link) return VERDICT_LABEL[link.path.verdict];
  }
  return "";
}

function onRoom(room: RoomSnapshot): void {
  links.close(linksToClose(myId, room, links.ids()));
}

const page = new URL(location.href);
const device = detectDevice(navigator.userAgent, matchMedia("(pointer: fine)").matches);
const sig = new Signaling(signalUrl(page, device));
let myId = "";
const links = new Links<Connection>(() => myId);
const dialer = createDialer(sig, links, () => {});
const host = createHost(sig, links, () => {});
const joiner = new Joiner({ send: (m) => sig.send(m), dial: dialer.dial, device, linked: () => links.ids() });

sig.onMessage((m) => {
  switch (m.t) {
    case "welcome":
      myId = m.peerId;
      // Dev-only test hook: force a second group (`?alone=1`). Stripped from production builds.
      if (import.meta.env.DEV && page.searchParams.get("alone") === "1") sig.send({ t: "start-alone" });
      joiner.onWelcome(m.peerId, m.room);
      onRoom(m.room);
      break;
    case "room":
      joiner.onRoom(m.room);
      onRoom(m.room);
      break;
    case "signal":
      if (m.sdp.type === "answer") dialer.onAnswer(m.from, m.sdp);
      else void host.onOffer(m.from, m.sdp);
      break;
    case "merge-request":
      joiner.onMergeRequest(m.bridgeId);
      break;
    case "error":
      console.warn("signaling error", m.code, m.message);
      joiner.onError(m.code);
      break;
  }
});
sig.onClose(() => {
  socketClosed = true;
  render(joiner.view);
});
links.onChange(() => {
  joiner.onLinksChanged();
  render(joiner.view);
});
joiner.onChange((v) => render(v));
render(joiner.view);
