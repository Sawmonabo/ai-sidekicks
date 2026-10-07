// The window's session list: one feed however many views read it, the list it delivers folded with
// each change after it, the chat count each delivery carries, and a list read again on request. The feed is a scripted function the
// test hands the store, so the store's own logic is measured.

import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { SessionDirectoryFeeds } from "./feeds.js";
import type {
  SessionDirectoryFeed,
  SessionDirectoryFrame,
  SessionDirectoryState,
} from "./state.js";
import { sessionListEntry } from "./state.test-support.js";

/** A feed the test drives: how often it opened and closed, and a way to deliver a frame. */
interface ScriptedFeed {
  readonly feed: SessionDirectoryFeed;
  readonly openCount: () => number;
  readonly closeCount: () => number;
  /** Deliver to the open feed; throws where none is open. */
  readonly deliver: (frame: SessionDirectoryFrame) => void;
}

function scriptedFeed(): ScriptedFeed {
  let openCount = 0;
  let closeCount = 0;
  let onFrame: ((frame: SessionDirectoryFrame) => void) | undefined;
  return {
    feed: (deliver) => {
      openCount += 1;
      onFrame = deliver;
      return () => {
        closeCount += 1;
        onFrame = undefined;
      };
    },
    openCount: () => openCount,
    closeCount: () => closeCount,
    deliver: (frame) => {
      if (onFrame === undefined) {
        throw new Error("the feed is not open, so nothing reads this frame");
      }
      onFrame(frame);
    },
  };
}

function listOf(...names: readonly string[]): SessionDirectoryFrame {
  return {
    kind: "list",
    sessions: names.map((name) => sessionListEntry({ sessionId: `session-${name}`, name })),
    chatCount: 0,
  };
}

/** The chat count a served list holds, or the status it holds instead. */
function chatCountIn(state: SessionDirectoryState): number | string {
  return state.status === "served" ? state.chatCount : state.status;
}

/** The names a served list holds, in order, or the status it holds instead. */
function namesIn(state: SessionDirectoryState): readonly (string | undefined)[] | string {
  return state.status === "served" ? state.sessions.map((session) => session.name) : state.status;
}

describe("the window's session list", () => {
  it("reads until the list arrives, then moves one entry and the chat count per change", () => {
    const feeds = new SessionDirectoryFeeds();
    const scripted = scriptedFeed();
    feeds.watch(scripted.feed, () => undefined);
    expect(namesIn(feeds.stateOf(scripted.feed))).toBe("reading");

    // Negative control: a change before the list moves nothing, since the list restates it.
    scripted.deliver({
      kind: "change",
      change: {
        kind: "upsert",
        entry: sessionListEntry({ sessionId: "session-early" }),
        chatCount: 0,
      },
    });
    expect(namesIn(feeds.stateOf(scripted.feed))).toBe("reading");

    scripted.deliver(listOf("web", "api"));
    expect(namesIn(feeds.stateOf(scripted.feed))).toStrictEqual(["web", "api"]);

    scripted.deliver({
      kind: "change",
      change: {
        kind: "upsert",
        entry: sessionListEntry({ sessionId: "session-web", name: "site" }),
        chatCount: 0,
      },
    });
    scripted.deliver({
      kind: "change",
      change: {
        kind: "upsert",
        entry: sessionListEntry({ sessionId: "session-docs", name: "docs", shape: "chat" }),
        chatCount: 1,
      },
    });
    expect(chatCountIn(feeds.stateOf(scripted.feed))).toBe(1);
    scripted.deliver({
      kind: "change",
      change: { kind: "remove", sessionId: "session-api" as SessionId, chatCount: 1 },
    });
    expect(namesIn(feeds.stateOf(scripted.feed))).toStrictEqual(["site", "docs"]);

    scripted.deliver({ kind: "lost" });
    expect(namesIn(feeds.stateOf(scripted.feed))).toBe("failed");
  });

  it("opens one feed for every reader, and closes it with the last", () => {
    const feeds = new SessionDirectoryFeeds();
    const scripted = scriptedFeed();
    const woken: string[] = [];
    const releaseFirst = feeds.watch(scripted.feed, () => woken.push("first"));
    const releaseSecond = feeds.watch(scripted.feed, () => woken.push("second"));
    expect(scripted.openCount()).toBe(1);

    scripted.deliver(listOf("web"));
    expect(woken).toStrictEqual(["first", "second"]);

    releaseFirst();
    expect(scripted.closeCount()).toBe(0);
    releaseSecond();
    expect(scripted.closeCount()).toBe(1);
    // A later reader reads afresh, never the list from before.
    expect(namesIn(feeds.stateOf(scripted.feed))).toBe("reading");
  });

  it("reads the list again on request, keeping the old one until the new one lands", () => {
    const feeds = new SessionDirectoryFeeds();
    const scripted = scriptedFeed();
    feeds.watch(scripted.feed, () => undefined);
    scripted.deliver(listOf("web"));

    feeds.reread(scripted.feed);
    expect(scripted.closeCount()).toBe(1);
    expect(scripted.openCount()).toBe(2);
    expect(namesIn(feeds.stateOf(scripted.feed))).toStrictEqual(["web"]);

    scripted.deliver(listOf("web", "api"));
    expect(namesIn(feeds.stateOf(scripted.feed))).toStrictEqual(["web", "api"]);
  });
});
