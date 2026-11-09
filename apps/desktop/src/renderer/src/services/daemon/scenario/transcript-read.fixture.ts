// The fixture daemon's `transcript.read` and `transcript.body.read`. A read is a window of the log
// this playback has delivered, read by the daemon's rules, so a store opens on rows the stream
// fixture then follows without a gap. A cursor is a log position: `afterCursor` reads the rows
// after it forward, `beforeCursor` the rows at or below it backward, nearest the cursor first
// chosen, and both the rows between them, read forward. `aroundCursor` reads the window around the
// row standing at that cursor, up to half the limit before it and the rest after it, refused with
// `transcript.row.notFound` when the delivered log holds no row there. Rows run oldest to newest
// either way and
// carry the turn stamps `turn-attribution.fixture.ts` folds and the body each beat stores, a large
// one as its size, as the daemon reads `content_payload` beside the event. A page stops at the
// limit or the page byte budget, whichever trips first, the budget shared with the facts of the
// runs the page names, folded over the whole delivered log as the daemon folds them; a cursor past
// the newest delivered row is refused, as the daemon refuses it. Every page names the newest
// delivered event as the position its rows joined their pieces through. A body read answers the
// page of a delivered row's stored body that starts at the request's offset, `absent` for a row
// that stores none, and refuses an id the delivered log does not hold or an offset that is no
// place to resume from.
//
// A scenario scripts its `session.read` record once, for the whole script, while the playback has
// delivered a prefix of it, so the record's log positions and standing events are read from the
// delivered log too: the daemon's record and log agree. The answer is a candidate the response
// schema judges, as a scripted reply is.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/category-by-type";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { jsonUtf8ByteLength } from "@ai-sidekicks/contracts/jsonrpc/byte-length";
import { PAGE_MAX_BYTES } from "@ai-sidekicks/contracts/jsonrpc/page";
import { countEntriesFittingOneFrame } from "@ai-sidekicks/contracts/jsonrpc/page-fitting";
import type { RefusalCode } from "@ai-sidekicks/contracts/jsonrpc/refusal";
import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";
import {
  EventCursorUnresolvableError,
  decodeEventCursor,
  encodeEventCursor,
} from "@ai-sidekicks/contracts/session/event-cursor";
import {
  SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE,
  START_OF_LOG_POSITION,
  type EventCursor,
} from "@ai-sidekicks/contracts/session/id";
import {
  BodyReadOffsetRefusedError,
  storedBodyContentOf,
  transcriptRowContentOf,
} from "@ai-sidekicks/contracts/transcript/content";
import { TRANSCRIPT_READ_LIMIT_MAX } from "@ai-sidekicks/contracts/transcript/limits";
import {
  validateTranscriptBodyReadRequest,
  validateTranscriptReadRequest,
  type TranscriptRunFacts,
} from "@ai-sidekicks/contracts/transcript/operations";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
} from "@ai-sidekicks/contracts/transcript/row";
import { transcriptOwnRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";
import {
  UNFOLDED_TRANSCRIPT_RUN_FACTS,
  foldTranscriptRunFacts,
  type TranscriptRunBeat,
} from "@ai-sidekicks/contracts/transcript/run-facts";

import { measureUtf8ByteLength } from "#renderer/lib/text/utf8-byte-length.js";
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
 * names no position or one past the newest delivered row, and for an anchor no row stands at.
 */
export function readScenarioTranscript(engine: ScenarioEngine, request: unknown): unknown {
  const { afterCursor, beforeCursor, aroundCursor, limit } = checkedRequest(
    validateTranscriptReadRequest,
    request,
  );
  const log = engine.deliveredEvents();
  const storedBodies = storedBodiesOf(engine);
  const pageLimit = limit ?? TRANSCRIPT_READ_LIMIT_MAX;
  if (aroundCursor !== undefined) {
    return readAround(log, storedBodies, aroundCursor, pageLimit);
  }
  const head = log.at(-1)?.sequence ?? START_OF_LOG_POSITION;
  const afterPosition =
    afterCursor === undefined ? START_OF_LOG_POSITION : positionWithin(afterCursor, head);
  const beforePosition =
    beforeCursor === undefined ? undefined : positionWithin(beforeCursor, head);
  if (beforePosition !== undefined && afterCursor === undefined) {
    return readBackward(log, storedBodies, beforePosition, pageLimit);
  }
  return readForward(log, storedBodies, afterPosition, beforePosition, pageLimit);
}

/**
 * The facts of each run `runIds` names, in that order, folded over `log`, a whole log oldest first,
 * through its newest event, as the daemon serves them with a window. A run is folded from the
 * events whose payload names it as its own.
 */
export function servedRunFactsOf(
  log: readonly TranscriptRunBeat[],
  runIds: Iterable<string>,
): TranscriptRunFacts[] {
  const foldedThroughSequence = log.at(-1)?.sequence ?? START_OF_LOG_POSITION;
  return Array.from(runIds, (runId) => {
    const folded = log
      .filter((beat) => transcriptOwnRunIdOf(beat.payload) === runId)
      .reduce(foldTranscriptRunFacts, UNFOLDED_TRANSCRIPT_RUN_FACTS);
    // The scripted ids are the daemon's own, minted as it mints them.
    return { runId: runId as TranscriptRunFacts["runId"], ...folded, foldedThroughSequence };
  });
}

/** A delivered log as the run facts fold reads it. */
export function runBeatsOf(log: readonly ProjectedSessionEvent[]): TranscriptRunBeat[] {
  return log.map((event) => ({
    type: event.kind,
    sequence: event.sequence,
    actor: event.actorId,
    payload: event.payload,
  }));
}

/**
 * Answer one `transcript.body.read` page from the delivered log. Throws the wire's refusal for a
 * row id the delivered log does not hold, or for an offset inside a character or past the end.
 */
export function readScenarioTranscriptBody(engine: ScenarioEngine, request: unknown): unknown {
  const { rowId, offset } = checkedRequest(validateTranscriptBodyReadRequest, request);
  const event = engine.deliveredEvents().find((delivered) => delivered.id === rowId);
  if (event === undefined) {
    const refusal: ScenarioRefusalEnvelope = {
      code: TRANSCRIPT_ROW_NOT_FOUND_CODE,
      message: "The session holds no row with this id.",
    };
    throw refusal;
  }
  try {
    return storedBodyContentOf(event.payload, storedBodiesOf(engine).get(rowId), offset);
  } catch (error: unknown) {
    if (!(error instanceof BodyReadOffsetRefusedError)) {
      throw error;
    }
    const refusal: ScenarioRefusalEnvelope = { code: error.code, message: error.message };
    throw refusal;
  }
}

/**
 * A scripted `session.read` record with its log positions and standing events read from the
 * delivered log, as the daemon's are: `latest` the newest delivered row, and the newest delivered
 * event of each kind and subject a standing fact reads. Any other reply is answered as scripted.
 */
export function withDeliveredLog(engine: ScenarioEngine, record: unknown): unknown {
  if (!isWireRecord(record) || !isWireRecord(record["transcriptCursors"])) {
    return record;
  }
  const log = engine.deliveredEvents();
  return {
    ...record,
    transcriptCursors: {
      earliest: record["transcriptCursors"]["earliest"],
      latest: log.at(-1)?.cursor ?? encodeEventCursor(START_OF_LOG_POSITION),
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

/** The refusal for a row the session's log does not hold. */
const TRANSCRIPT_ROW_NOT_FOUND_CODE = "transcript.row.notFound" satisfies RefusalCode;

/** `request` as its generated check reads it; a request off the contract is a fixture fault. */
function checkedRequest<Request>(check: SchemaCheck<Request>, request: unknown): Request {
  if (!check(request)) {
    throw new TypeError("The fixture daemon was sent a request off its method's contract.");
  }
  return request;
}

/** The position every page's rows joined their pieces through: the newest delivered event's. */
function joinedThroughOf(log: readonly ProjectedSessionEvent[]): string | undefined {
  return log.at(-1)?.cursor;
}

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
  const stretchRuns = servedRunFactsOf(runBeatsOf(log), runIdsNamedBy(rows));
  // Counted from the oldest end, so a budget cut keeps the rows nearest `afterCursor`.
  const pageCount = countEntriesFittingOneFrame(rows, limit, rowBudgetBeside(stretchRuns));
  const newestKept = stretch[pageCount - 1];
  const entries = rows.slice(0, pageCount);
  const joinedThrough = joinedThroughOf(log);
  return {
    entries,
    runs: runsNamedBy(entries, stretchRuns),
    hasMore: pageCount < candidates.length,
    // An empty page leaves the reader where it asked to read after.
    nextCursor: encodeEventCursor(newestKept === undefined ? afterPosition : newestKept.sequence),
    ...(joinedThrough === undefined ? {} : { joinedThrough }),
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
  const stretchRuns = servedRunFactsOf(runBeatsOf(log), runIdsNamedBy(rows));
  // Counted from the newest end, so a budget cut drops the rows farthest from the cursor.
  const pageCount = countEntriesFittingOneFrame(
    [...rows].reverse(),
    limit,
    rowBudgetBeside(stretchRuns),
  );
  const entries = rows.slice(rows.length - pageCount);
  const runs = runsNamedBy(entries, stretchRuns);
  const oldestKept = stretch[stretch.length - pageCount];
  const joinedThrough = joinedThroughOf(log);
  // Every candidate made the page: it reached the start of the log, so no earlier window remains.
  if (pageCount === candidates.length || oldestKept === undefined) {
    return {
      entries,
      runs,
      hasMore: false,
      ...(joinedThrough === undefined ? {} : { joinedThrough }),
    };
  }
  return {
    entries,
    runs,
    hasMore: true,
    nextCursor: encodeEventCursor(oldestKept.sequence - 1),
    ...(joinedThrough === undefined ? {} : { joinedThrough }),
  };
}

/**
 * The window around the row at `aroundCursor`: up to half the limit of the rows before it and the
 * rest after it, oldest first, a budget cut dropping the rows farthest from it on each side and
 * never the row itself. The page continues toward the start as a backward page does.
 */
function readAround(
  log: readonly ProjectedSessionEvent[],
  storedBodies: StoredBodies,
  aroundCursor: EventCursor,
  limit: number,
): unknown {
  const anchorIndex = log.findIndex((event) => event.cursor === aroundCursor);
  if (anchorIndex === -1) {
    const refusal: ScenarioRefusalEnvelope = {
      code: TRANSCRIPT_ROW_NOT_FOUND_CODE,
      message: "No row of this session stands at that cursor.",
    };
    throw refusal;
  }
  const earlierLimit = Math.floor((limit - 1) / 2);
  const laterLimit = limit - 1 - earlierLimit;
  const earlierStart = Math.max(0, anchorIndex - earlierLimit);
  const stretch = log.slice(earlierStart, anchorIndex + 1 + laterLimit);
  const rows = rowsOf(log, storedBodies, stretch);
  const stretchRuns = servedRunFactsOf(runBeatsOf(log), runIdsNamedBy(rows));
  const anchorAt = anchorIndex - earlierStart;
  // Nearest first: the anchor, then one row after and one before in turn.
  const nearestFirst = [anchorAt];
  for (let distance = 1; distance < rows.length; distance += 1) {
    for (const index of [anchorAt + distance, anchorAt - distance]) {
      if (index >= 0 && index < rows.length) {
        nearestFirst.push(index);
      }
    }
  }
  const pageCount = countEntriesFittingOneFrame(
    nearestFirst.map((index) => rows[index]),
    limit,
    rowBudgetBeside(stretchRuns),
  );
  const kept = nearestFirst.slice(0, Math.max(pageCount, 1));
  const oldestKept = Math.min(...kept);
  const newestKept = Math.max(...kept);
  const entries = rows.slice(oldestKept, newestKept + 1);
  const runs = runsNamedBy(entries, stretchRuns);
  const joinedThrough = joinedThroughOf(log);
  const oldestRow = stretch[oldestKept];
  // Rows remain before the page when the budget cut earlier rows or the log holds one more.
  if (oldestRow === undefined || (oldestKept === 0 && earlierStart === 0)) {
    return {
      entries,
      runs,
      hasMore: false,
      ...(joinedThrough === undefined ? {} : { joinedThrough }),
    };
  }
  return {
    entries,
    runs,
    hasMore: true,
    nextCursor: encodeEventCursor(oldestRow.sequence - 1),
    ...(joinedThrough === undefined ? {} : { joinedThrough }),
  };
}

/** The runs `rows` name, each once, in the order each is first named. */
function runIdsNamedBy(rows: readonly Readonly<Record<string, unknown>>[]): Set<string> {
  return new Set(rows.flatMap((row) => (typeof row["runId"] === "string" ? [row["runId"]] : [])));
}

/** The bytes a page's rows may take beside the facts of every run its stretch names. */
function rowBudgetBeside(stretchRuns: readonly TranscriptRunFacts[]): number {
  return PAGE_MAX_BYTES - jsonUtf8ByteLength(stretchRuns);
}

/** The facts of the runs `entries` name, from those of the stretch they were cut from. */
function runsNamedBy(
  entries: readonly Readonly<Record<string, unknown>>[],
  stretchRuns: readonly TranscriptRunFacts[],
): TranscriptRunFacts[] {
  const namedRunIds = runIdsNamedBy(entries);
  return stretchRuns.filter((facts) => namedRunIds.has(facts.runId));
}

/** A cursor's position, or the daemon's refusal when it names none or one past `head`. */
function positionWithin(cursor: EventCursor, head: number): number {
  const position = decodedPosition(cursor);
  if (position === undefined || position > head) {
    const refusal: ScenarioRefusalEnvelope = {
      code: SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE,
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
): readonly Readonly<Record<string, unknown>>[] {
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
    timestamp: event.occurredAt,
    ...(event.actorId === undefined ? {} : { actor: event.actorId }),
    payload: event.payload ?? {},
    content: transcriptRowContentOf(
      event.payload,
      storedBody === undefined
        ? undefined
        : { byteLength: measureUtf8ByteLength(storedBody), body: storedBody },
    ),
  };
  if (attributed === undefined) {
    return { ...common, kind: "general" };
  }
  if (event.kind === TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE) {
    return {
      ...common,
      kind: "rollbackBoundary",
      category: TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
      runId: attributed.runId,
      ...attributed.stamp,
    };
  }
  return { ...common, kind: "run", runId: attributed.runId, ...attributed.stamp };
}
