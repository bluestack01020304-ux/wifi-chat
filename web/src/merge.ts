import type { GroupView, RoomSnapshot } from "../../server/src/protocol";
import type { Device } from "../../server/src/roomKey";

/** Spec: every member of a merged group confirms the bridge within 5 s. */
export const MERGE_TIMEOUT_MS = 5000;

export type Plan =
  | { kind: "none" }
  | { kind: "join"; groupId: string }
  | { kind: "merge"; groups: string[]; unattached: string[] };

const peersOf = (g: GroupView) => [g.hostId, ...g.members];

/** Targets I should dial: every group host and every other unattached peer, snapshot order. */
export function dialTargets(myId: string, room: RoomSnapshot): string[] {
  return room.peers.filter((p) => p.peerId !== myId && (p.status === "host" || p.status === "unattached")).map((p) => p.peerId);
}

/** What to do once the dial phase settled. `reached` = peers whose dial succeeded. */
export function planAfterDial(myId: string, myDevice: Device, room: RoomSnapshot, reached: ReadonlySet<string>): Plan {
  const hosts = room.groups.filter((g) => reached.has(g.hostId));
  const unattached = room.peers.filter((p) => p.peerId !== myId && p.status === "unattached" && reached.has(p.peerId));
  if (hosts.length === 0 && unattached.length === 0) return { kind: "none" };

  if (myDevice === "mobile") {
    const desktop = hosts.find((g) => room.peers.find((p) => p.peerId === g.hostId)?.device === "desktop");
    if (desktop) return { kind: "join", groupId: desktop.groupId };
  }
  if (hosts.length >= 2 || unattached.length >= 1) {
    return { kind: "merge", groups: hosts.map((g) => g.groupId), unattached: unattached.map((p) => p.peerId) };
  }
  return { kind: "join", groupId: hosts[0].groupId };
}

/** Every peer of every listed group (still in the room) is linked. */
export function mergeComplete(room: RoomSnapshot, groups: string[], linked: ReadonlySet<string>): boolean {
  return room.groups.filter((g) => groups.includes(g.groupId)).every((g) => peersOf(g).every((id) => linked.has(id)));
}

/** The commit to send, or null when the merge validity rule (≥ 2 whole groups, or ≥ 1 unattached) fails. */
export function commitPlan(
  myId: string,
  room: RoomSnapshot,
  groups: string[],
  linked: ReadonlySet<string>,
): { groups: string[]; peers: string[] } | null {
  const whole = room.groups.filter((g) => groups.includes(g.groupId) && peersOf(g).every((id) => linked.has(id)));
  const unattached = room.peers.filter((p) => p.peerId !== myId && p.status === "unattached" && linked.has(p.peerId));
  if (whole.length < 2 && unattached.length === 0) return null;

  const included = new Set([...whole.flatMap(peersOf), ...unattached.map((p) => p.peerId)]);
  return {
    groups: whole.map((g) => g.groupId),
    peers: room.peers.filter((p) => included.has(p.peerId)).map((p) => p.peerId),
  };
}

/** Linked peers whose connection no longer belongs to me. */
export function linksToClose(myId: string, room: RoomSnapshot, linked: ReadonlySet<string>): string[] {
  const me = room.peers.find((p) => p.peerId === myId);
  const keep = new Set<string>();
  if (me?.status === "host") {
    for (const id of room.groups.find((g) => g.hostId === myId)?.members ?? []) keep.add(id);
  } else if (me?.status === "member") {
    const host = room.groups.find((g) => g.groupId === me.groupId)?.hostId;
    if (host) keep.add(host);
  }
  const waiting = !me || me.status === "joining" || me.status === "unattached";

  return [...linked].filter((id) => {
    const peer = room.peers.find((p) => p.peerId === id);
    if (!peer) return true;
    if (peer.status === "joining" || peer.status === "unattached") return false;
    return !waiting && !keep.has(id);
  });
}
