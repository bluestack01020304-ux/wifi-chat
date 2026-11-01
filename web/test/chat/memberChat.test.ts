import { describe, expect, it, vi } from "vitest";
import { History } from "../../src/chat/history";
import { HELLO_RETRY_MS, MemberChat } from "../../src/chat/memberChat";

const j = (v: unknown) => JSON.stringify(v);
const msg = (id: string, at: number) => ({ id, from: "h", nick: "n", text: id, at });

function setup(term = 1, mode: "family" | "meeting" = "family") {
  const history = new History();
  const sent: unknown[] = [];
  let n = 0;
  const chat = new MemberChat({ myNick: "졸린 펭귄", history, term, mode, send: (f) => sent.push(JSON.parse(f)), newId: () => "id" + ++n });
  return { chat, history, sent };
}

describe("MemberChat", () => {
  it("open sends hello with my nick", () => {
    const { chat, sent } = setup();
    chat.open();
    expect(sent).toEqual([{ t: "hello", nick: "졸린 펭귄" }]);
  });

  it("say sends a cleaned say with a fresh id", () => {
    const { chat, sent, history } = setup();
    expect(chat.say("  hi  ")).toBe(true);
    expect(chat.say(" \n ")).toBe(false);
    expect(sent).toEqual([{ t: "say", id: "id1", text: "hi" }]);
    expect(history.list()).toEqual([]);
  });

  it("msg and history land in history", () => {
    const { chat, history } = setup();
    chat.onFrame(j({ t: "history", msgs: [msg("a", 1), msg("b", 2)], term: 1 }));
    chat.onFrame(j({ t: "msg", msg: msg("c", 3), term: 1 }));
    chat.onFrame(j({ t: "msg", msg: msg("a", 1), term: 1 }));
    expect(history.list().map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("roster is stored and announced", () => {
    const { chat } = setup();
    const cb = vi.fn();
    chat.onRoster(cb);
    const people = [{ peerId: "h", nick: "n", host: true, away: false }];
    chat.onFrame(j({ t: "roster", people, term: 1 }));
    expect(chat.roster()).toEqual(people);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("hello is retried until history arrives, and close stops it", () => {
    vi.useFakeTimers();
    try {
      const { chat, sent } = setup();
      chat.open();
      vi.advanceTimersByTime(HELLO_RETRY_MS * 2);
      expect(sent).toHaveLength(3);
      chat.onFrame(j({ t: "history", msgs: [], term: 1 }));
      vi.advanceTimersByTime(HELLO_RETRY_MS * 2);
      expect(sent).toHaveLength(3);

      const other = setup();
      other.chat.open();
      other.chat.close();
      vi.advanceTimersByTime(HELLO_RETRY_MS * 2);
      expect(other.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("malformed frames are ignored", () => {
    const { chat, history } = setup();
    for (const raw of ["nope", j({ t: "say", id: "x", text: "y" }), j({ t: "msg" }), 5]) chat.onFrame(raw);
    expect(history.list()).toEqual([]);
    expect(chat.roster()).toEqual([]);
  });
});

describe("MemberChat term", () => {
  it("frames from an old term are dropped", () => {
    const { chat, history } = setup(2);
    chat.onFrame(j({ t: "msg", msg: msg("old", 1), term: 1 }));
    chat.onFrame(j({ t: "roster", people: [{ peerId: "h", nick: "n", host: true, away: false }], term: 1 }));
    chat.onFrame(j({ t: "msg", msg: msg("new", 2), term: 2 }));
    expect(history.list().map((m) => m.id)).toEqual(["new"]);
    expect(chat.roster()).toEqual([]);
  });
});

describe("MemberChat naming", () => {
  it("meeting hello carries no nickname", () => {
    const { chat, sent } = setup(1, "meeting");
    chat.open();
    chat.close();
    expect(sent).toEqual([{ t: "hello", nick: "익명" }]);
    expect(JSON.stringify(sent)).not.toContain("졸린 펭귄");
  });

  it("re-roll re-sends hello with the new nick", () => {
    const { chat, sent } = setup();
    chat.open();
    chat.close();
    chat.setNick("배고픈 수달");
    expect(sent).toEqual([{ t: "hello", nick: "졸린 펭귄" }, { t: "hello", nick: "배고픈 수달" }]);
  });

  it("re-roll sends nothing in meeting mode", () => {
    const { chat, sent } = setup(1, "meeting");
    chat.setNick("배고픈 수달");
    expect(sent).toEqual([]);
  });
});
