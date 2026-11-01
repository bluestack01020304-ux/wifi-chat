import "./style.css";
import type { RoomSnapshot } from "../../server/src/protocol";
import { History } from "./chat/history";
import { makeNickname } from "./chat/nickname";
import { knownRoster, type Note, rosterNotes } from "./chat/notes";
import { ChatSession } from "./chat/session";
import type { RosterEntry } from "./chat/wire";
import { detectDevice, signalUrl } from "./config";
import { debug } from "./debug";
import { createHost } from "./host";
import { Joiner, type View } from "./joiner";
import { Links } from "./links";
import { linksToClose } from "./merge";
import { type Connection, createDialer } from "./peer";
import { type RoomInfo, readRoom } from "./roomLink";
import { Signaling } from "./signaling";
import { createApp, showBadUrl } from "./ui";

const VERDICT_LABEL = { host: "host↔host", "prflx-lan": "host↔사설 prflx", "prflx-hidden": "host↔prflx(주소 가림)" } as const;

/**
 * Spec: a host tells the server it is alive every second; 2 s of silence hands the group on.
 * Alone in the room there is nobody to hand over to, so the server never times me out and
 * I send nothing: an idle single tab must not wake the server every second.
 */
const HEARTBEAT_MS = 1000;

const app = document.getElementById("app")!;
const page = new URL(location.href);
// `?debug=1`: show connection diagnostics on this screen (never sent anywhere).
debug.enabled = page.searchParams.get("debug") === "1";
const room = readRoom(page);
// A room the server would refuse: say so instead of opening a socket that is rejected.
if ("error" in room) showBadUrl(app, page.origin + page.pathname);
else boot(room);

function boot(room: RoomInfo): void {
  const device = detectDevice(navigator.userAgent, matchMedia("(pointer: fine)").matches);
  const sig = new Signaling(signalUrl(page, device));
  let myId = "";
  let socketClosed = false;
  let othersInRoom: number | null = null;
  const links = new Links<Connection>(() => myId);
  const dialer = createDialer(sig, links, () => {});
  const host = createHost(sig, links, () => {});
  const joiner = new Joiner({
    send: (m) => sig.send(m),
    dial: dialer.dial,
    device,
    linked: () => links.ids(),
    // Spec 강등: a demoted host stops relaying and closes every DataChannel at once.
    onDemoted: () => links.close(links.ids()),
  });

  // Dev-only test hook: `window.__muteHeartbeat = true` stalls this host to exercise demotion. Stripped from production builds.
  const muted = () => import.meta.env.DEV && (globalThis as { __muteHeartbeat?: boolean }).__muteHeartbeat === true;
  setInterval(() => {
    const view = joiner.view;
    if (!socketClosed && !muted() && view.kind === "host" && !view.aloneInRoom) sig.send({ t: "heartbeat" });
  }, HEARTBEAT_MS);

  // Chat: nickname and history live in memory only (closing every tab ends the conversation).
  let myNick = makeNickname(Math.random);
  const history = new History();
  const session = new ChatSession({
    myNick,
    anonymous: room.anon,
    history,
    channel: (peerId) => links.get(peerId)?.dc,
    myId: () => myId,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  });

  // System lines: derived on this device from roster changes once the chat is shown.
  let entered = false;
  const notes: Note[] = [];
  let lastRoster: RosterEntry[] | null = null;
  let lostAt: number | null = null;
  function onRoster(): void {
    const roster = session.roster();
    if (!entered) return;
    if (roster.length === 0) {
      // My channel to my host is gone: start timing the handover.
      if (lastRoster && lostAt === null) lostAt = Date.now();
      return;
    }
    const now = Date.now();
    notes.push(...rosterNotes(lastRoster, roster, myId, now, lostAt === null ? null : now - lostAt));
    lastRoster = knownRoster(lastRoster, roster);
    lostAt = null;
  }

  const ui = createApp(app, {
    room,
    page,
    history,
    session,
    myId: () => myId,
    onEnter: () => {
      entered = true;
      const roster = session.roster();
      lastRoster = roster.length > 0 ? roster : null;
      render();
    },
    onReroll: () => {
      myNick = makeNickname(Math.random);
      session.setNick(myNick);
      render();
    },
    onStartAlone: () => joiner.startAlone(),
  });

  /** The path of my link to my host (member), or of my latest member link (host). */
  function currentPath(view: View): string {
    const ids = view.kind === "member" ? [view.hostId] : view.kind === "host" ? [...view.members].reverse() : [];
    for (const id of ids) {
      const link = links.get(id);
      if (link) return VERDICT_LABEL[link.path.verdict];
    }
    return "";
  }

  function render(): void {
    const view = joiner.view;
    ui.render({ view, socketClosed, entered, othersInRoom, myNick, path: currentPath(view), notes });
  }

  function refresh(): void {
    session.update(joiner.view);
    render();
  }

  function pruneLinks(snapshot: RoomSnapshot): void {
    links.close(linksToClose(myId, snapshot, links.ids()));
    othersInRoom = snapshot.peers.filter((p) => p.peerId !== myId).length;
  }

  if (debug.enabled) {
    const pre = document.createElement("pre");
    pre.className = "debug-log";
    document.body.append(pre);
    debug.listeners.push(() => (pre.textContent = debug.lines.join("\n")));
    debug.log(`${navigator.userAgent.replace(/^Mozilla\/5\.0 /, "")}`);
  }
  history.onChange(() => render());
  session.onChange(() => {
    onRoster();
    render();
  });

  sig.onMessage((m) => {
    switch (m.t) {
      case "welcome":
        myId = m.peerId;
        // Dev-only test hook: force a second group (`?alone=1`). Stripped from production builds.
        if (import.meta.env.DEV && page.searchParams.get("alone") === "1") sig.send({ t: "start-alone" });
        joiner.onWelcome(m.peerId, m.room);
        pruneLinks(m.room);
        render();
        break;
      case "room":
        joiner.onRoom(m.room);
        pruneLinks(m.room);
        render();
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
    render();
  });
  links.onChange(() => {
    joiner.onLinksChanged();
    refresh();
  });
  joiner.onChange(() => refresh());
  refresh();
}
