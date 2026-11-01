import "./style.css";
import { detectDevice, signalUrl } from "./config";
import { createHost } from "./host";
import { Joiner, type View } from "./joiner";
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
let lastPath = "";
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

  if (lastPath) app.append(el("p", `경로: ${lastPath}`, "status"));
}

function onConnected(_peerId: string, c: Connection): void {
  lastPath = VERDICT_LABEL[c.path.verdict];
  render(joiner.view);
}

const page = new URL(location.href);
const device = detectDevice(navigator.userAgent, matchMedia("(pointer: fine)").matches);
const sig = new Signaling(signalUrl(page, device));
const dialer = createDialer(sig, onConnected);
const host = createHost(sig, onConnected);
const joiner = new Joiner({ send: (m) => sig.send(m), dial: dialer.dial });

sig.onMessage((m) => {
  switch (m.t) {
    case "welcome":
      joiner.onWelcome(m.peerId, m.room);
      break;
    case "room":
      joiner.onRoom(m.room);
      break;
    case "signal":
      if (m.sdp.type === "answer") dialer.onAnswer(m.from, m.sdp);
      else if (joiner.view.kind === "host") void host.onOffer(m.from, m.sdp);
      break;
    case "error":
      console.warn("signaling error", m.code, m.message);
      break;
  }
});
sig.onClose(() => {
  socketClosed = true;
  render(joiner.view);
});
joiner.onChange((v) => {
  if (v.kind !== "host") host.closeAll();
  render(v);
});
render(joiner.view);
