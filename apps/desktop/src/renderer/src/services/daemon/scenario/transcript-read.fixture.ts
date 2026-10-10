// The fixture daemon's `transcript.read`: a window of the log this playback has delivered, read by
// the daemon's rules, so a store opens on rows the stream fixture then follows without a gap. A
// cursor is a log position: `afterCursor` reads the rows after it forward, `beforeCursor` the rows
// at or below it backward, nearest the cursor first chosen, and both the rows between them, read
// forward. Rows run oldest to newest either way and carry the turn stamps
// `turn-attribution.fixture.ts` folds and the body each beat stores, a large one as its size, as
// the daemon reads `content_payload` beside the event. A page stops at the limit or the page byte budget, whichever
// trips first; a cursor past the newest delivered row is refused, as the daemon refuses it.
//
// A scenario scripts its `session.read` record once, for the whole script, while the playback has
// delivered a prefix of it, so the record's log positions and standing events are read from the
// delivered log too: the daemon's record and log agree. The answer is a candidate the response
// schema judges, as a scripted reply is.

import {
  EVENT_CURSOR_UNRESOLVABLE_CODE,
  EventCursorUnresolvableError,
  START_OF_LOG_POSITION,
  decodeEventCursor,
  encodeEventCursor,
  type EventCursor,
} from "@ai-sidekicks/contracts/session/event-cursor";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { countEntriesFittingOneFrame } from "@ai-sidekicks/contracts/jsonrpc/page";
import {
  storedBodyContentOf,
  transcriptRowContentOf,
} from "@ai-sidekicks/contracts/transcript/content";
import { TRANSCRIPT_READ_LIMIT_MAX } from "@ai-sidekicks/contracts/transcript/limits";
import { TranscriptReadRequestSchema } from "@ai-sidekicks/contracts/transcript/operations";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
} from "@ai-sidekicks/contracts/transcript/row";

import { isWireRecord } from "#renderer/lib/wire/record.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { mergeStandingEvents } from "#renderer/store/session/standing-events.js";
import type { ScenarioEngine } from "../engine.fixture.js";
import { composeScenarioEventEnvelope } from "../event/envelope.fixture.js";
import type { ScenarioRefusalEnvelope } from "./reply.fixture.js";
import {
  ScenarioTurnAttribution,
  type ScenarioRunAttribution,
} from "./turn-attribution.fixture.js";

/**
 * Answer one `transcript.read` from the delivered log. Throws the wire's refusal for a cursor that
 * names no position or one past the newest delivered row.
 */
export function readScenarioTranscript(engine: ScenarioEngine, request: unknown): unknown {
  const { afterCursor, beforeCursor, limit } = TranscriptReadRequestSchema.parse(request);
  const log = engine.deliveredEvents();
  const storedBodies = storedBodiesOf(engine);
  const head = log.at(-1)?.sequence ?? START_OF_LOG_POSITION;
  const afterPosition =
    afterCursor === undefined ? START_OF_LOG_POSITION : positionWithin(afterCursor, head);
  const beforePosition =
    beforeCursor === undefined ? undefined : positionWithin(beforeCursor, head);
  const pageLimit = limit ?? TRANSCRIPT_READ_LIMIT_MAX;
  if (beforePosition !== undefined && afterCursor === undefined) {
    return readBackward(log, storedBodies, beforePosition, pageLimit);
  }
  return readForward(log, storedBodies, afterPosition, beforePosition, pageLimit);
}

/**
 * A scripted `session.read` record with its log positions and standing events read from the
 * delivered log, as the daemon's are: `latest` the newest delivered row, `acknowledged` kept once
 * it is delivered, and the newest delivered event of each kind and subject a standing fact reads.
 * Any other reply is answered as scripted.
 */
export function withDeliveredLog(engine: ScenarioEngine, record: unknown): unknown {
  if (!isWireRecord(record) || !isWireRecord(record["transcriptCursors"])) {
    return record;
  }
  const cursors = record["transcriptCursors"];
  const log = engine.deliveredEvents();
  const acknowledged = cursors["acknowledged"];
  const isAcknowledgedDelivered = log.some((event) => event.cursor === acknowledged);
  return {
    ...record,
    transcriptCursors: {
      earliest: cursors["earliest"],
      latest: log.at(-1)?.cursor ?? encodeEventCursor(START_OF_LOG_POSITION),
      ...(isAcknowledgedDelivered ? { acknowledged } : {}),
    },
    standingEvents: mergeStandingEvents([], log).map((event) => ({
      cursor: event.cursor,
      event: composeScenarioEventEnvelope(event),
    })),
  };
}

/** The body each scripted event stores, by event id. */
function storedBodiesOf(engine: ScenarioEngine): StoredBodies {
  const storedBodies = new Map<string, string>();
  for (const beat of engine.scenario.beats) {
    if (beat.storedBody !== undefined) {
      storedBodies.set(beat.event.id, beat.storedBody);
    }
  }
  return storedBodies;
}

type StoredBodies = ReadonlyMap<string, string>;

/** The oldest rows after `afterPosition`, up to `beforePosition` when one bounds the window. */
function readForward(
  log: readonly ProjectedSessionEvent[],
  storedBodies: StoredBodies,
  afterPosition: number,
  beforePosition: number | undefined,
  limit: number,
): unknown {
  const candidates = log
    .filter((event) => event.sequence > afterPosition)
    .slice(0, limit + 1)
    .filter((event) => beforePosition === undefined || event.sequence <= beforePosition);
  const stretch = candidates.slice(0, limit);
  const rows = rowsOf(log, storedBodies, stretch);
  // Counted from the oldest end, so a budget cut keeps the rows nearest `afterCursor`.
  const pageCount = countEntriesFittingOneFrame(rows, limit);
  const newestKept = stretch[pageCount - 1];
  return {
    entries: rows.slice(0, pageCount),
    hasMore: pageCount < candidates.length,
    // An empty page leaves the reader where it asked to read after.
    nextCursor: encodeEventCursor(newestKept === undefined ? afterPosition : newestKept.sequence),
  };
}

/** The newest rows at or below `beforePosition`, returned oldest first. */
function readBackward(
  log: readonly ProjectedSessionEvent[],
  storedBodies: StoredBodies,
  beforePosition: number,
  limit: number,
): unknown {
  const candidates = log.filter((event) => event.sequence <= beforePosition).slice(-(limit + 1));
  const stretch = candidates.slice(-limit);
  const rows = rowsOf(log, storedBodies, stretch);
  // Counted from the newest end, so a budget cut drops the rows farthest from the cursor.
  const pageCount = countEntriesFittingOneFrame([...rows].reverse(), limit);
  const entries = rows.slice(rows.length - pageCount);
  const oldestKept = stretch[stretch.length - pageCount];
  // Every candidate made the page: it reached the start of the log, so no earlier window remains.
  if (pageCount === candidates.length || oldestKept === undefined) {
    return { entries, hasMore: false };
  }
  return { entries, hasMore: true, nextCursor: encodeEventCursor(oldestKept.sequence - 1) };
}

/** A cursor's position, or the daemon's refusal when it names none or one past `head`. */
function positionWithin(cursor: EventCursor, head: number): number {
  const position = decodedPosition(cursor);
  if (position === undefined || position > head) {
    const refusal: ScenarioRefusalEnvelope = {
      code: EVENT_CURSOR_UNRESOLVABLE_CODE,
      message: "That cursor is not in this session's log.",
    };
    throw refusal;
  }
  return position;
}

/** The position `cursor` names, or `undefined` for one that names none. */
function decodedPosition(cursor: EventCursor): number | undefined {
  try {
    return decodeEventCursor(cursor);
  } catch (error) {
    if (error instanceof EventCursorUnresolvableError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The rows of `stretch`, stamped by one fold over the stretch alone that seeds each run from the
 * delivered log, as the daemon's read projects its window.
 */
function rowsOf(
  log: readonly ProjectedSessionEvent[],
  storedBodies: StoredBodies,
  stretch: readonly ProjectedSessionEvent[],
): readonly unknown[] {
  const attribution = new ScenarioTurnAttribution(() => log);
  return stretch.map((event) =>
    rowOf(event, attribution.attribute(event), storedBodies.get(event.id)),
  );
}

/** One delivered event as the daemon projects it into a row: general, run or rollback boundary. */
function rowOf(
  event: ProjectedSessionEvent,
  attributed: ScenarioRunAttribution | undefined,
  storedBody: string | undefined,
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
    content: transcriptRowContentOf(storedBodyContentOf(event.payload, storedBody)),
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
