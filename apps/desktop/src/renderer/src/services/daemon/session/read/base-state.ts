// The window's session read: the daemon's `session.read`, then, for a read that places the window,
// one `transcript.read` window of the log, and the stream opened after the window's newest row. A
// window opens where the resume rule says, `acknowledged ?? latest`; a snapshot opens it at
// `latest`. A repair keeps the window and reads only the record, the stream reopened where the
// opening says. The record's live runs become the run entities, since a window opened below a
// run's events never reads the events that set its state, and its standing events become the
// store's, for the facts they carry. Every position is relayed as the daemon issued it and never
// read for a sequence: the window's rows carry their own.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionReadResponse } from "@ai-sidekicks/contracts/session/methods";

import { callDaemon, unwrapDaemonReply } from "../../reply.js";
import {
  readTranscriptPage,
  transcriptPageReadThroughDaemon,
  type TranscriptPage,
} from "../../transcript/page.js";
import { readSessionId } from "../../wire/identifiers.js";
import { projectSessionEvent } from "../event/payload.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { RefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { projectLiveRun } from "#renderer/store/session/events/run/lifecycle-projector.js";
import {
  heldRowCursor,
  type RepairReopening,
  type SessionBaseState,
} from "#renderer/store/session/state.js";
import {
  type SessionBaseStateReader,
  type SessionWindowOpening,
} from "#renderer/store/session/open/entry.js";

/** The subsystem a refusal from this read names as its author. */
const SESSION_READ_ORIGIN = "session-read";

/**
 * The read that gives a session store its base state, through one bridge: the record, then the
 * window at the position `opening` names, or for a repair the record alone, the stream then opened
 * where the base state says. A refusal of either call, or a read whose stream could open only at
 * a position the stream refused, is raised so the store's refresh scheduler marks the session
 * degraded instead of reading nothing.
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
    if (opening.opensAt === "repair") {
      return repairBaseStateOf(record, opening.reopening, opening.refusedCursors);
    }
    const page = readTranscriptPage(
      unwrapDaemonReply(
        await transcriptPageReadThroughDaemon(bridge)({
          sessionId: wireSessionId,
          beforeCursor: openingCursorOf(record.transcriptCursors, opening),
          limit: opening.pageLimit,
        }),
      ),
    );
    return windowBaseStateOf(record, page, opening.refusedCursors);
  };
}

/**
 * The position the window ends at: the acknowledged one when a window opens and one was
 * acknowledged, else the log's newest. A refused acknowledged position is passed over for the
 * newest.
 */
function openingCursorOf(
  cursors: SessionReadResponse["transcriptCursors"],
  opening: Extract<SessionWindowOpening, { readonly opensAt: "resume" | "latest" }>,
): EventCursor {
  const { acknowledged } = cursors;
  return opening.opensAt === "resume" &&
    acknowledged !== undefined &&
    !opening.refusedCursors.has(acknowledged)
    ? acknowledged
    : cursors.latest;
}

/**
 * The base state one record and its window establish. The stream opens after the window's newest
 * row; a window with no rows holds nothing at or before its position, so the stream opens after
 * `earliest`, the position before the oldest surviving event.
 */
function windowBaseStateOf(
  record: SessionReadResponse,
  page: TranscriptPage,
  refusedCursors: ReadonlySet<EventCursor>,
): SessionBaseState {
  const newest = page.events.at(-1);
  const streamAfterCursor = openableCursor(
    newest === undefined ? record.transcriptCursors.earliest : heldRowCursor(newest),
    refusedCursors,
  );
  return {
    ...(newest === undefined ? {} : { cursor: newest.sequence }),
    entities: record.liveRuns.map(projectLiveRun),
    transcript: page.events,
    standingEvents: standingEventsOf(record),
    streamAfterCursor,
    transcriptHead: page.edge,
  };
}

/**
 * The base state a repair takes: the record's live runs and standing events, and the stream
 * reopened after the row the repair names, or before the window's head, `earliest` standing for a
 * window that opened at the log's floor.
 */
function repairBaseStateOf(
  record: SessionReadResponse,
  reopening: RepairReopening,
  refusedCursors: ReadonlySet<EventCursor>,
): SessionBaseState {
  const position =
    reopening.from === "row"
      ? reopening.rowCursor
      : (reopening.headCursor ?? record.transcriptCursors.earliest);
  return {
    entities: record.liveRuns.map(projectLiveRun),
    standingEvents: standingEventsOf(record),
    streamAfterCursor: openableCursor(position, refusedCursors),
  };
}

/**
 * The record's standing events as app events. One whose category disagrees with its type is left
 * out, as the stream leaves it out of a frame.
 */
function standingEventsOf(record: SessionReadResponse): ProjectedSessionEvent[] {
  return record.standingEvents.flatMap((standing) => {
    const event = projectSessionEvent(standing.event, standing.cursor, undefined);
    return event === undefined ? [] : [event];
  });
}

/** `cursor`, unless the stream refused it, so no read opens the stream there again. */
function openableCursor(
  cursor: EventCursor,
  refusedCursors: ReadonlySet<EventCursor>,
): EventCursor {
  if (refusedCursors.has(cursor)) {
    throw new RefusalError(
      refuse(SESSION_READ_ORIGIN, "session-unreadable", "Could not load this session."),
    );
  }
  return cursor;
}
