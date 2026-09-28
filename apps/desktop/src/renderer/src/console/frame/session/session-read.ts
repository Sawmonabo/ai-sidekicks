// The window's session read, answered by the daemon's `session.read`.

import { callDaemon, readSessionId, type ConsoleBridge } from "../../bridge/index.js";
import { ConsoleRefusalError, refuse } from "../../core/index.js";
import { servedValueOrRaise } from "../../seats/index.js";
import {
  BASE_STATE_CURSOR,
  type SessionSnapshot,
  type SessionSnapshotReader,
} from "../../store/index.js";

/** The subsystem a refusal from this read names as its author. */
const SESSION_READ_ORIGIN = "session-read";

/**
 * The read that gives a session store its base state, through one bridge.
 *
 * The wire request names only the session, so the store's resume position has nowhere
 * to travel and every read opens the store at the base cursor. A refusal is raised so
 * the store's refresh scheduler marks the session degraded instead of reading nothing.
 */
export function sessionReadThroughDaemon(bridge: ConsoleBridge): SessionSnapshotReader {
  return async (sessionId): Promise<SessionSnapshot> => {
    const wireSessionId = readSessionId(sessionId);
    if (wireSessionId === undefined) {
      throw new ConsoleRefusalError(
        refuse(
          SESSION_READ_ORIGIN,
          "session-unreadable",
          "This session's identifier is not one the daemon registers, so it was not read.",
        ),
      );
    }
    const { timelineCursors } = servedValueOrRaise(
      await callDaemon(bridge, "session.read", { sessionId: wireSessionId }),
    );
    return { cursor: BASE_STATE_CURSOR, entities: [], timelineCursors };
  };
}
