// The window's session read, answered by the daemon's `session.read`.

import { callDaemon } from "./daemon-reply.js";
import { readSessionId } from "./wire-identifiers.js";
import { type PlatformBridge } from "../platform/platform-bridge.js";
import { RefusalError, refuse } from "@renderer/lib/refusal.js";
import { unwrapDaemonReply } from "@renderer/console/seats/index.js";
import { BASE_STATE_CURSOR, type SessionSnapshot } from "@renderer/store/session/session-state.js";
import { type SessionSnapshotReader } from "@renderer/store/session/open-session-entry.js";

/** The subsystem a refusal from this read names as its author. */
const SESSION_READ_ORIGIN = "session-read";

/**
 * The read that gives a session store its base state, through one bridge.
 *
 * The wire request names only the session, so the store's resume position has nowhere
 * to travel and every read opens the store at the base cursor. A refusal is raised so
 * the store's refresh scheduler marks the session degraded instead of reading nothing.
 */
export function sessionReadThroughDaemon(bridge: PlatformBridge): SessionSnapshotReader {
  return async (sessionId): Promise<SessionSnapshot> => {
    const wireSessionId = readSessionId(sessionId);
    if (wireSessionId === undefined) {
      throw new RefusalError(
        refuse(
          SESSION_READ_ORIGIN,
          "session-unreadable",
          "This session's identifier is not one the background service registers, so it was not read.",
        ),
      );
    }
    const { timelineCursors } = unwrapDaemonReply(
      await callDaemon(bridge, "session.read", { sessionId: wireSessionId }),
    );
    return { cursor: BASE_STATE_CURSOR, entities: [], timelineCursors };
  };
}
