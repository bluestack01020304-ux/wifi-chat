/**
 * Removes every `a=candidate:` line whose type is not `host`, so a remote
 * peer can never steer us onto a server-reflexive or relayed path.
 */
export function keepHostCandidatesOnly(sdp: string): { sdp: string; dropped: number } {
  let dropped = 0;
  const kept = sdp.split("\r\n").filter((line) => {
    if (!line.startsWith("a=candidate:")) return true;
    const tokens = line.split(" ");
    const typ = tokens.indexOf("typ");
    if (typ !== -1 && tokens[typ + 1] === "host") return true;
    dropped++;
    return false;
  });
  return { sdp: kept.join("\r\n"), dropped };
}
