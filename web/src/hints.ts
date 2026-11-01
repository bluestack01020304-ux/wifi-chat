import type { View } from "./joiner";

/**
 * Android 17 blocks local network traffic for apps that target its SDK unless
 * the user grants the app the "근처 기기" (nearby devices / local network)
 * permission. Chrome is such an app; in-app WebViews (", wv)") are not
 * affected. A web page cannot request this OS permission, so we explain it.
 */
const isRestrictedAndroidBrowser = (ua: string) => /Android/.test(ua) && !/; wv\)/.test(ua);

/**
 * Whether to show the nearby-devices hint: "self" on an Android browser that
 * cannot reach anyone although others are in the room, "peer" on any other
 * device in that situation (the other side may be the blocked one).
 */
export function permissionHint(ua: string, view: View, othersInRoom: number | null): "self" | "peer" | null {
  const stuck = view.kind === "failed" || (view.kind === "host" && view.members.length === 0 && (othersInRoom ?? 0) > 0);
  if (!stuck) return null;
  return isRestrictedAndroidBrowser(ua) ? "self" : "peer";
}
