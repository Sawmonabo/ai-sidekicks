// The window's session read, answered by the daemon's `session.read`. The request names only the
// session, so where the window opens is chosen from the cursor block the reply carries. The
// position is relayed as the daemon issued it and never read for a sequence: the store learns
// that from the first event the stream delivers after it.

import type { EventCursor } from "@ai-sidekicks/contracts/session/id";
import type { SessionReadResponse } from "@ai-sidekicks/contracts/session/methods";

import { callDaemon, unwrapDaemonReply } from "../../reply.js";
import { readSessionId } from "../../wire/identifiers.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { RefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import { type SessionBaseState } from "#renderer/store/session/state.js";
import {
  type SessionBaseStateReader,
  type SessionWindowOpening,
} from "#renderer/store/session/open/entry.js";
import { resolveTranscriptResume } from "./transcript-resume.js";

/** The subsystem a refusal from this read names as its author. */
const SESSION_READ_ORIGIN = "session-read";

/**
 * The read that gives a session store its base state, through one bridge: the base state at the
 * position the resume rule picks from the reply's cursor block, which the stream is then opened
 * after.
 * A refusal is raised so the store's refresh scheduler marks the session degraded instead of
 * reading nothing.
 */
export function sessionReadThroughDaemon(bridge: PlatformBridge): SessionBaseStateReader {
  return async (sessionId, _reasons, opening): Promise<SessionBaseState> => {
    const wireSessionId = readSessionId(sessionId);
    if (wireSessionId === undefined) {
      throw new RefusalError(
        refuse(SESSION_READ_ORIGIN, "session-unreadable", "Could not load this session."),
      );
    }
    const { transcriptCursors } = unwrapDaemonReply(
      await callDaemon(bridge, "session.read", { sessionId: wireSessionId }),
    );
    return baseStateOpenedAt(transcriptCursors, opening);
  };
}

/**
 * The empty base state at the position the resume rule picks. An acknowledged position heads the
 * window, since rows sit before it; the position `opening` says was refused is passed over for
 * the floor, and a refused floor for the log's start, where the stream opens with no position.
 */
function baseStateOpenedAt(
  cursors: SessionReadResponse["transcriptCursors"],
  opening: SessionWindowOpening,
): SessionBaseState {
  const decision = resolveTranscriptResume(cursors);
  if (decision.fromCursor !== opening.refusedCursor) {
    return decision.outcome === "resume-acknowledged"
      ? { ...baseStateAfter(decision.fromCursor), readFromCursor: decision.fromCursor }
      : baseStateAfter(decision.fromCursor);
  }
  if (cursors.earliest !== opening.refusedCursor) {
    return baseStateAfter(cursors.earliest);
  }
  return { entities: [] };
}

/** An empty base state at one daemon-issued position, the stream opening after it. */
function baseStateAfter(cursor: EventCursor): SessionBaseState {
  return { entities: [], streamAfterCursor: cursor };
}
