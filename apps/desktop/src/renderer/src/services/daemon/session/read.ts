// The window's session read, answered by the daemon's `session.read`. The request names only the
// session, so where the window opens is chosen from the cursor block the reply carries, and this
// is the one place such a position is decoded into the sequence the store counts from.

import {
  decodeEventCursor,
  START_OF_LOG_POSITION,
  type EventCursor,
} from "@ai-sidekicks/contracts/session/id";
import type { SessionReadResponse } from "@ai-sidekicks/contracts/session/methods";

import { callDaemon } from "../reply.js";
import { readSessionId } from "../wire/identifiers.js";
import { type PlatformBridge } from "../../platform/bridge.js";
import { RefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import { unwrapDaemonReply } from "../reply.js";
import { type SessionBaseState } from "#renderer/store/session/state.js";
import {
  type SessionBaseStateReader,
  type SessionWindowOpening,
} from "#renderer/store/session/open/entry.js";
import { resolveTranscriptResume } from "#renderer/store/session/transcript-resume.js";

/** The subsystem a refusal from this read names as its author. */
const SESSION_READ_ORIGIN = "session-read";

/**
 * The read that gives a session store its base state, through one bridge: the base state at the
 * position `opening` names in the reply's cursor block, which the stream is then opened after.
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
 * The empty base state at the position `opening` picks. An acknowledged position heads the
 * window, since rows sit before it; a refused position is passed over for the floor, and a
 * refused floor for the log's start, where the stream opens with no position.
 */
function baseStateOpenedAt(
  cursors: SessionReadResponse["transcriptCursors"],
  opening: SessionWindowOpening,
): SessionBaseState {
  if (opening.opensAt === "latest") {
    return baseStateAfter(cursors.latest);
  }
  const decision = resolveTranscriptResume(cursors);
  if (decision.fromCursor !== opening.refusedCursor) {
    return decision.outcome === "resume-acknowledged"
      ? { ...baseStateAfter(decision.fromCursor), readFromCursor: decision.fromCursor }
      : baseStateAfter(decision.fromCursor);
  }
  if (cursors.earliest !== opening.refusedCursor) {
    return baseStateAfter(cursors.earliest);
  }
  return { cursor: START_OF_LOG_POSITION, entities: [] };
}

/** An empty base state at one daemon-issued position, the stream opening after it. */
function baseStateAfter(cursor: EventCursor): SessionBaseState {
  return { cursor: decodeEventCursor(cursor), entities: [], streamAfterCursor: cursor };
}
