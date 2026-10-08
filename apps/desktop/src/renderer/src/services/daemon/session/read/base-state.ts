// The window's session read: the daemon's `session.read`, then one `transcript.read` window of the
// log, and the stream opened after the window's newest row. A window opens where the resume rule
// says, `acknowledged ?? latest`; a repair opens it at `latest`. The record's live runs become the
// run entities, since a window opened below a run's events never reads the events that set its
// state. Every position is relayed as the daemon issued it and never read for a sequence: the
// window's rows carry their own.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionReadResponse } from "@ai-sidekicks/contracts/session/methods";

import { callDaemon, unwrapDaemonReply } from "../../reply.js";
import { readTranscriptPage, type TranscriptPage } from "../../transcript-page.js";
import { readSessionId } from "../../wire/identifiers.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { RefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import { projectLiveRun } from "#renderer/store/session/events/run/lifecycle-projector.js";
import { heldRowCursor, type SessionBaseState } from "#renderer/store/session/state.js";
import {
  type SessionBaseStateReader,
  type SessionWindowOpening,
} from "#renderer/store/session/open/entry.js";

/** The subsystem a refusal from this read names as its author. */
const SESSION_READ_ORIGIN = "session-read";

/**
 * The read that gives a session store its base state, through one bridge: the record, then the
 * window at the position `opening` names, which the stream is then opened after. A refusal of
 * either call is raised so the store's refresh scheduler marks the session degraded instead of
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
    const record = unwrapDaemonReply(
      await callDaemon(bridge, "session.read", { sessionId: wireSessionId }),
    );
    const page = readTranscriptPage(
      unwrapDaemonReply(
        await callDaemon(bridge, "transcript.read", {
          sessionId: wireSessionId,
          beforeCursor: openingCursorOf(record.transcriptCursors, opening),
          limit: opening.pageLimit,
        }),
      ),
    );
    return baseStateOf(record, page, opening.refusedCursor);
  };
}

/**
 * The position the window ends at: the acknowledged one when a window opens and one was
 * acknowledged, else the log's newest. A refused position is passed over for the newest.
 */
function openingCursorOf(
  cursors: SessionReadResponse["transcriptCursors"],
  opening: SessionWindowOpening,
): EventCursor {
  const { acknowledged } = cursors;
  return opening.opensAt === "resume" &&
    acknowledged !== undefined &&
    acknowledged !== opening.refusedCursor
    ? acknowledged
    : cursors.latest;
}

/**
 * The base state one record and its window establish. The stream opens after the window's newest
 * row; a window with no rows holds nothing at or before its position, so the stream opens after
 * `earliest`, the position before the oldest surviving event. Past a refused position the stream
 * opens at the log's start, with no position.
 */
function baseStateOf(
  record: SessionReadResponse,
  page: TranscriptPage,
  refusedCursor: EventCursor | undefined,
): SessionBaseState {
  const newest = page.events.at(-1);
  const streamAfterCursor =
    newest === undefined ? record.transcriptCursors.earliest : heldRowCursor(newest);
  return {
    ...(newest === undefined ? {} : { cursor: newest.sequence }),
    entities: record.liveRuns.map(projectLiveRun),
    transcript: page.events,
    ...(streamAfterCursor === refusedCursor ? {} : { streamAfterCursor }),
    transcriptHead: page.edge,
  };
}
