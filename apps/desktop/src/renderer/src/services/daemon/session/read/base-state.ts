// The window's session read, answered by the daemon's `session.read`. The request names only the
// session, so where a window opens is chosen from the cursor block the reply carries, and a
// repair reopens after the held row, or at the head, the held window already names. The position
// is relayed as the daemon issued it and never read for a sequence: the store learns that from
// the first event the stream delivers after it.

import type { EventCursor } from "@ai-sidekicks/contracts/session/id";
import type { SessionReadResponse } from "@ai-sidekicks/contracts/session/methods";

import { callDaemon, unwrapDaemonReply } from "../../reply.js";
import { heldIdAsWireId, readSessionId } from "../../wire/identifiers.js";
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
 * position `opening` names, which the stream is then opened after.
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
 * The empty base state at the position `opening` picks, passing over the refused ones. A repair
 * reopens after the held row the window names, since the store holds the window's state there
 * and the read carries none; else at the held window's head, rows still sitting before it, or at
 * the floor for a window that opened there. A window opening takes the resume rule, an
 * acknowledged position heading the window since rows sit before it. Past a refused position the
 * floor stands in, and past a refused floor the log's start, where the stream opens with no
 * position.
 */
function baseStateOpenedAt(
  cursors: SessionReadResponse["transcriptCursors"],
  opening: SessionWindowOpening,
): SessionBaseState {
  const { refusedCursors } = opening;
  if (opening.opensAt === "repair") {
    const { resumeAfterRowCursor, headCursor } = opening;
    const afterRowCursor =
      resumeAfterRowCursor === undefined
        ? undefined
        : heldIdAsWireId<EventCursor>(resumeAfterRowCursor);
    if (afterRowCursor !== undefined && !refusedCursors.has(afterRowCursor)) {
      return baseStateAfter(afterRowCursor);
    }
    return headCursor !== undefined && !refusedCursors.has(headCursor)
      ? { ...baseStateAfter(headCursor), readFromCursor: headCursor }
      : baseStateAtFloor(cursors, refusedCursors);
  }
  const decision = resolveTranscriptResume(cursors);
  if (refusedCursors.has(decision.fromCursor)) {
    return baseStateAtFloor(cursors, refusedCursors);
  }
  return decision.outcome === "resume-acknowledged"
    ? { ...baseStateAfter(decision.fromCursor), readFromCursor: decision.fromCursor }
    : baseStateAfter(decision.fromCursor);
}

/** The empty base state at the floor, or at the log's start when the floor was refused. */
function baseStateAtFloor(
  cursors: SessionReadResponse["transcriptCursors"],
  refusedCursors: ReadonlySet<EventCursor>,
): SessionBaseState {
  return refusedCursors.has(cursors.earliest) ? { entities: [] } : baseStateAfter(cursors.earliest);
}

/** An empty base state at one daemon-issued position, the stream opening after it. */
function baseStateAfter(cursor: EventCursor): SessionBaseState {
  return { entities: [], streamAfterCursor: cursor };
}
