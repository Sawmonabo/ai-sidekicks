// The fixture daemon's `transcript.read`: a window of the log this playback has delivered, read by
// the daemon's rules, so a store opens on rows the stream fixture then follows without a gap. A
// cursor is a log position: `afterCursor` reads the rows after it forward, `beforeCursor` the rows
// at or below it backward, newest first chosen, and both the rows between them, read forward. Rows
// run oldest to newest either way and carry the turn stamps `turn-attribution.fixture.ts` folds.
//
// A scenario's record names the whole script's newest position while the playback has delivered a
// prefix of it, so a `beforeCursor` past what has been delivered reads up to the newest delivered
// row, where the daemon, whose record and log agree, would refuse it. An `afterCursor` past it is
// refused as the daemon refuses it. The answer is a candidate the response schema judges, as a
// scripted reply is.

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/session/event-cursor";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { START_OF_LOG_POSITION, decodeEventCursor, encodeEventCursor, type EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import {
  TRANSCRIPT_READ_LIMIT_MAX,
  TranscriptReadRequestSchema,
} from "@ai-sidekicks/contracts/transcript/operations";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
} from "@ai-sidekicks/contracts/transcript/row";

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import type { ScenarioEngine } from "../engine.fixture.js";
import type { ScenarioRefusalEnvelope } from "./reply.fixture.js";
import {
  ScenarioTurnAttribution,
  type ScenarioRunAttribution,
} from "./turn-attribution.fixture.js";

/**
 * Answer one `transcript.read` from the delivered log. Throws the wire's refusal for an
 * `afterCursor` the log does not reach, as the stream fixture refuses a cursor it never delivered.
 */
export function readScenarioTranscript(engine: ScenarioEngine, request: unknown): unknown {
  const { afterCursor, beforeCursor, limit } = TranscriptReadRequestSchema.parse(request);
  const log = engine.deliveredEvents();
  const head = log.at(-1)?.sequence ?? START_OF_LOG_POSITION;
  const afterPosition =
    afterCursor === undefined ? START_OF_LOG_POSITION : positionWithin(afterCursor, head);
  const beforePosition =
    beforeCursor === undefined ? undefined : Math.min(decodeEventCursor(beforeCursor), head);
  const pageLimit = limit ?? TRANSCRIPT_READ_LIMIT_MAX;
  if (beforePosition !== undefined && afterCursor === undefined) {
    const candidates = log.filter((event) => event.sequence <= beforePosition);
    const stretch = candidates.slice(-pageLimit);
    const oldest = stretch[0];
    const entries = rowsOf(log, stretch);
    return candidates.length > stretch.length && oldest !== undefined
      ? { entries, hasMore: true, nextCursor: encodeEventCursor(oldest.sequence - 1) }
      : { entries, hasMore: false };
  }
  const candidates = log.filter(
    (event) =>
      event.sequence > afterPosition &&
      (beforePosition === undefined || event.sequence <= beforePosition),
  );
  const stretch = candidates.slice(0, pageLimit);
  const nextCursor = encodeEventCursor(stretch.at(-1)?.sequence ?? afterPosition);
  return {
    entries: rowsOf(log, stretch),
    hasMore: candidates.length > stretch.length,
    nextCursor,
  };
}

/** A cursor's position, or the daemon's refusal when it names one past the log's newest row. */
function positionWithin(cursor: EventCursor, head: number): number {
  const position = decodeEventCursor(cursor);
  if (position > head) {
    const refusal: ScenarioRefusalEnvelope = {
      code: EVENT_CURSOR_UNRESOLVABLE_CODE,
      message: "That cursor is not in this session's log.",
    };
    throw refusal;
  }
  return position;
}

/**
 * The rows of `stretch`, attributed by a fold over `log` from its start, which is how the daemon
 * seeds a run first met partway through the log.
 */
function rowsOf(
  log: readonly ProjectedSessionEvent[],
  stretch: readonly ProjectedSessionEvent[],
): readonly unknown[] {
  const newestSequence = stretch.at(-1)?.sequence;
  if (newestSequence === undefined) {
    return [];
  }
  const oldestSequence = stretch[0]!.sequence;
  const attribution = ScenarioTurnAttribution.seededWithRollbacksOf(log);
  const rows: unknown[] = [];
  for (const event of log) {
    if (event.sequence > newestSequence) {
      break;
    }
    const attributed = attribution.attribute(event);
    if (event.sequence >= oldestSequence) {
      rows.push(rowOf(event, attributed));
    }
  }
  return rows;
}

/** One delivered event as the daemon projects it into a row: general, run or rollback boundary. */
function rowOf(
  event: ProjectedSessionEvent,
  attributed: ScenarioRunAttribution | undefined,
): Readonly<Record<string, unknown>> {
  const category = SESSION_EVENT_CATEGORY_BY_TYPE.get(event.kind as SessionEventType);
  const common = {
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    cursor: event.cursor,
    ...(category === undefined ? {} : { category }),
    type: event.kind,
    // The event type restated: no registered payload carries a summary.
    summary: event.kind,
    timestamp: event.occurredAt,
    ...(event.actorId === undefined ? {} : { actor: event.actorId }),
    payload: event.payload ?? {},
  };
  if (attributed === undefined) {
    return { ...common, kind: "general" };
  }
  if (event.kind === TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE) {
    return {
      ...common,
      kind: "rollback_boundary",
      category: TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
      runId: attributed.runId,
      ...attributed.stamp,
    };
  }
  return { ...common, kind: "run", runId: attributed.runId, ...attributed.stamp };
}
