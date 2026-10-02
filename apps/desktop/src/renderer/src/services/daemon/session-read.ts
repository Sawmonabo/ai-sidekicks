// The window's session read, answered by the daemon's `session.read`.

import { callDaemon } from "./daemon-reply.js";
import { readSessionId } from "./wire-identifiers.js";
import { type PlatformBridge } from "../platform/platform-bridge.js";
import { RefusalError, refuse } from "@renderer/lib/refusal.js";
import { unwrapDaemonReply } from "./unwrap-daemon-reply.js";
import { BASE_STATE_CURSOR, type SessionBaseState } from "@renderer/store/session/session-state.js";
import { type SessionBaseStateReader } from "@renderer/store/session/open-session-entry.js";

/** The subsystem a refusal from this read names as its author. */
const SESSION_READ_ORIGIN = "session-read";

/**
 * The read that gives a session store its base state, through one bridge.
 *
 * The wire request names only the session, so the store's resume position has nowhere
 * to travel and every read opens the store at the base cursor. A refusal is raised so
 * the store's refresh scheduler marks the session degraded instead of reading nothing.
 */
export function sessionReadThroughDaemon(bridge: PlatformBridge): SessionBaseStateReader {
  return async (sessionId): Promise<SessionBaseState> => {
    const wireSessionId = readSessionId(sessionId);
    if (wireSessionId === undefined) {
      throw new RefusalError(
        refuse(SESSION_READ_ORIGIN, "session-unreadable", "Could not load this session."),
      );
    }
    const { timelineCursors } = unwrapDaemonReply(
      await callDaemon(bridge, "session.read", { sessionId: wireSessionId }),
    );
    return { cursor: BASE_STATE_CURSOR, entities: [], timelineCursors };
  };
}
