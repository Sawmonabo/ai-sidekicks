// The service's session list, one feed per window however many views read it. Each list it
// delivers replaces what is held once its last page lands, so no view reads part of a list as all
// of it, and each change after it moves one entry. Nothing polls: a settled act that implies the
// list moved asks for it again with `reread`, which opens the feed afresh.

import type {
  SessionListChange,
  SessionListEntry,
} from "@ai-sidekicks/contracts/session/directory";

import { SharedFeeds, type FeedFold } from "../../shared-feed.js";
import type { SessionDirectoryFrame, SessionDirectoryState } from "./state.js";

/**
 * Every session-list feed being read, each folded into one state its readers share. Keyed by the
 * feed, which the composition holds stable per window.
 */
export class SessionDirectoryFeeds extends SharedFeeds<
  SessionDirectoryFrame,
  SessionDirectoryState
> {
  public constructor() {
    super(SESSION_DIRECTORY_FOLD);
  }
}

/** A list arriving in pages: the entries so far and the chat count the latest page carried. */
interface IncomingSessionList {
  readonly sessions: SessionListEntry[];
  chatCount: number;
}

/**
 * The fold for one open of the feed. Until a list's last page lands, the state stays what it was:
 * reading, or on a reread the list it replaces. A closed feed finishes no list it was delivering,
 * since the next open folds afresh.
 */
function openSessionDirectoryFold(): (
  state: SessionDirectoryState,
  frame: SessionDirectoryFrame,
) => SessionDirectoryState {
  // The list being delivered, page by page, until its last page makes it the state.
  let incoming: IncomingSessionList | undefined;
  const receive = (
    state: SessionDirectoryState,
    list: IncomingSessionList,
    isComplete: boolean,
  ): SessionDirectoryState => {
    if (!isComplete) {
      incoming = list;
      return state;
    }
    incoming = undefined;
    return { status: "served", sessions: list.sessions, chatCount: list.chatCount };
  };
  return (state, frame) => {
    switch (frame.kind) {
      case "list":
        return receive(
          state,
          { sessions: [...frame.sessions], chatCount: frame.chatCount },
          frame.isComplete,
        );
      case "lost":
        incoming = undefined;
        return { status: "failed" };
      case "change": {
        const { change } = frame;
        if (change.kind !== "page") {
          return changedState(state, change);
        }
        // A page with no list before it, like a change, moves nothing: the next list restates it.
        if (incoming === undefined) {
          return state;
        }
        incoming.sessions.push(...change.sessions);
        incoming.chatCount = change.chatCount;
        return receive(state, incoming, change.isComplete);
      }
    }
  };
}

/** Reading until the list's last page lands, then the list as each change leaves it. */
const SESSION_DIRECTORY_FOLD: FeedFold<SessionDirectoryFrame, SessionDirectoryState> = {
  initial: { status: "reading" },
  open: openSessionDirectoryFold,
};

/** The app's session lists, one per window's feed. */
export const sessionDirectoryFeeds: SessionDirectoryFeeds = new SessionDirectoryFeeds();

/**
 * The state after one entry's change. A change before the list arrives moves nothing: the list it
 * follows restates every session, that one included.
 */
function changedState(
  state: SessionDirectoryState,
  change: Exclude<SessionListChange, { kind: "page" }>,
): SessionDirectoryState {
  if (state.status !== "served") {
    return state;
  }
  return {
    status: "served",
    sessions:
      change.kind === "upsert"
        ? upsertInPlace(state.sessions, change.entry)
        : state.sessions.filter((session) => session.sessionId !== change.sessionId),
    chatCount: change.chatCount,
  };
}

/** The list with `entry` where its session stood, or at the end for a session new to it. */
function upsertInPlace(
  sessions: readonly SessionListEntry[],
  entry: SessionListEntry,
): readonly SessionListEntry[] {
  const at = sessions.findIndex((session) => session.sessionId === entry.sessionId);
  return at < 0 ? [...sessions, entry] : sessions.with(at, entry);
}
