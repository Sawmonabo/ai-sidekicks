// Which turn of its run each event belongs to. Folding a run's events in log order, a turn boundary
// moves the run to its next position, and an accepted rollback ends the epoch it rewound and opens
// the next at its point. Any other event takes the turn of its own execution: the source stamped on
// a row appended after a cut, else the turn its tool call opened in, else the turn the run stands
// at. A run first met partway through the log, or met again after its fold ended at a terminal
// event, is seeded from its log before that event.

import type { Database, Statement } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { RunRolledBackEvent } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  type TranscriptRunStamp,
} from "@ai-sidekicks/contracts/transcript/row";
import { transcriptRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";
import {
  RUN_START_POSITION,
  TOOL_CALL_OPENING_EVENT_TYPE,
  TURN_STARTED_EVENT_TYPE,
  addSupersedingCut,
  stampedSourceOf,
  standingAfterRollback,
  standingAfterTurnStarted,
  transcriptRunStampAt,
  transcriptToolCallIdOf,
  type EpochPosition,
  type SupersededTurns,
} from "@ai-sidekicks/contracts/transcript/turn-attribution";

import { RUN_TERMINAL_EVENT_TYPES } from "../session/run/transitions.js";
import { parseStoredRollback, prepareSupersededTurns } from "../session/run/superseded.js";

// One event of a run, attributed: the run, the stamp its row carries and, on a `run.rolled_back`,
// the rollback read into its contract.
interface RunEventAttribution {
  readonly runId: RunId;
  readonly stamp: TranscriptRunStamp;
  readonly rollback?: RunRolledBackEvent;
}

// One run's place in the fold.
interface RunFold {
  standing: EpochPosition;
  turns: SupersededTurns;
  // The turn each tool call opened in, held until a later row of the call reads it or the run
  // ends; a row after that reads the opening from the log, so the map holds only calls still open.
  readonly openedToolCalls: Map<string, EpochPosition>;
}

interface RunEventParameters {
  readonly sessionId: SessionId;
  readonly type: string;
  readonly runId: RunId;
  readonly beforeSequence: number;
}

interface SequencedPayloadRow {
  readonly sequence: number;
  readonly payload: string;
}

// Each read seeks the run's rows of one type through the event log's run-and-type index, bounded
// strictly before the event being seeded.
const SELECT_ROLLBACKS_BEFORE_SQL = `SELECT sequence, payload FROM session_events
  WHERE session_id = @sessionId AND type = @type AND sequence < @beforeSequence
    AND run_id = @runId
  ORDER BY sequence`;

const SELECT_TURNS_BETWEEN_SQL = `SELECT payload FROM session_events
  WHERE session_id = @sessionId AND type = @type
    AND sequence > @afterSequence AND sequence < @beforeSequence
    AND run_id = @runId
  ORDER BY sequence`;

// The latest opening wins: a provider may reuse a call's key after a cut.
const SELECT_TOOL_CALL_OPENING_SQL = `SELECT sequence, payload FROM session_events
  WHERE session_id = @sessionId AND type = @type AND sequence < @beforeSequence
    AND run_id = @runId
    AND json_extract(payload, '$.toolCallId') = @toolCallId
  ORDER BY sequence DESC
  LIMIT 1`;

/**
 * The log reads that seed a run's fold, prepared once on the daemon's read-only connection. Each
 * throws when a stored rollback does not match its contract.
 */
export class RunTurnReads {
  /** Reads a run's superseded turns from every rollback of it in the log. */
  readonly readSupersededTurns: (sessionId: SessionId, runId: RunId) => SupersededTurns;
  readonly #selectRollbacksBefore: Statement<RunEventParameters, SequencedPayloadRow>;
  readonly #selectTurnsBetween: Statement<
    RunEventParameters & { readonly afterSequence: number },
    { readonly payload: string }
  >;
  readonly #selectToolCallOpening: Statement<
    RunEventParameters & { readonly toolCallId: string },
    SequencedPayloadRow
  >;

  constructor(reader: Database) {
    this.readSupersededTurns = prepareSupersededTurns(reader);
    this.#selectRollbacksBefore = reader.prepare(SELECT_ROLLBACKS_BEFORE_SQL);
    this.#selectTurnsBetween = reader.prepare(SELECT_TURNS_BETWEEN_SQL);
    this.#selectToolCallOpening = reader.prepare(SELECT_TOOL_CALL_OPENING_SQL);
  }

  /** Reads the epoch and turn the run stands at just before `beforeSequence`. */
  readStandingBefore(sessionId: SessionId, runId: RunId, beforeSequence: number): EpochPosition {
    let standing = RUN_START_POSITION;
    let lastRollbackSequence = START_OF_LOG_POSITION;
    const rollbackRows = this.#selectRollbacksBefore.iterate({
      sessionId,
      type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
      runId,
      beforeSequence,
    });
    for (const row of rollbackRows) {
      const rollback = parseStoredRollback(JSON.parse(row.payload), sessionId, row.sequence);
      standing = standingAfterRollback(standing, rollback.targetPosition);
      lastRollbackSequence = row.sequence;
    }
    // Turns before the last rollback do not move the run: the rollback set its position.
    const turnRows = this.#selectTurnsBetween.iterate({
      sessionId,
      type: TURN_STARTED_EVENT_TYPE,
      runId,
      afterSequence: lastRollbackSequence,
      beforeSequence,
    });
    for (const row of turnRows) {
      standing = standingAfterTurnStarted(standing, JSON.parse(row.payload));
    }
    return standing;
  }

  /**
   * Reads the epoch and turn the run's latest call `toolCallId` opened in before `beforeSequence`,
   * or `undefined` when no such call opened.
   */
  readToolCallOpeningBefore(
    sessionId: SessionId,
    runId: RunId,
    toolCallId: string,
    beforeSequence: number,
  ): EpochPosition | undefined {
    const opening = this.#selectToolCallOpening.get({
      sessionId,
      type: TOOL_CALL_OPENING_EVENT_TYPE,
      runId,
      toolCallId,
      beforeSequence,
    });
    if (opening === undefined) {
      return undefined;
    }
    return (
      stampedSourceOf(JSON.parse(opening.payload)) ??
      this.readStandingBefore(sessionId, runId, opening.sequence)
    );
  }
}

/**
 * Attributes one session's events to the turns of their runs. Feed it one ascending stretch of the
 * log in sequence order, a window read or a stream's deliveries; each run is seeded from the log on
 * first sight and after its terminal event, and marked against every rollback of it the log holds
 * by then.
 */
export class SessionTurnAttribution {
  readonly #reads: RunTurnReads;
  readonly #sessionId: SessionId;
  readonly #foldByRunId = new Map<RunId, RunFold>();

  constructor(reads: RunTurnReads, sessionId: SessionId) {
    this.#reads = reads;
    this.#sessionId = sessionId;
  }

  /**
   * The attribution of an event of a run, or `undefined` for an event naming none. Throws on a
   * `run.rolled_back` whose payload does not match its contract.
   */
  attribute(event: EventEnvelope): RunEventAttribution | undefined {
    if (event.type === TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE) {
      return this.#attributeRollback(event);
    }
    const payloadRunId = transcriptRunIdOf(event.payload);
    if (payloadRunId === undefined) {
      return undefined;
    }
    // The log is the daemon's own and every run id in it was minted by the daemon.
    const runId = payloadRunId as RunId;
    const fold = this.#foldFor(runId, event.sequence);
    // A terminal event is stamped from the fold and frees it; a later event, after a resume,
    // reseeds the run from the log.
    if (RUN_TERMINAL_EVENT_TYPES.has(event.type)) {
      this.#foldByRunId.delete(runId);
    }
    if (event.type === TURN_STARTED_EVENT_TYPE) {
      fold.standing = standingAfterTurnStarted(fold.standing, event.payload);
      return { runId, stamp: transcriptRunStampAt(fold.turns, fold.standing) };
    }
    const toolCallId = transcriptToolCallIdOf(event.category, event.payload);
    if (toolCallId !== undefined && event.type === TOOL_CALL_OPENING_EVENT_TYPE) {
      const opening = stampedSourceOf(event.payload) ?? fold.standing;
      fold.openedToolCalls.set(toolCallId, opening);
      return { runId, stamp: transcriptRunStampAt(fold.turns, opening) };
    }
    const source = this.#sourceOf(event, runId, fold, toolCallId);
    return { runId, stamp: transcriptRunStampAt(fold.turns, source) };
  }

  #attributeRollback(event: EventEnvelope): RunEventAttribution {
    const rollback = parseStoredRollback(event.payload, this.#sessionId, event.sequence);
    const fold = this.#foldFor(rollback.runId, event.sequence);
    const rewoundEpoch = fold.standing.epoch;
    // A rollback the seeding read already counted holds its cut.
    if (rewoundEpoch === fold.turns.cuts.length) {
      fold.turns = addSupersedingCut(fold.turns, rollback.targetPosition);
    }
    const boundary: EpochPosition = { epoch: rewoundEpoch, position: rollback.targetPosition };
    fold.standing = standingAfterRollback(fold.standing, rollback.targetPosition);
    return { runId: rollback.runId, stamp: transcriptRunStampAt(fold.turns, boundary), rollback };
  }

  // The turn a row of the run belongs to. A row of a tool call ends its held opening, since a
  // call closes with its one result or error; a later row of that call reads the opening from the
  // log.
  #sourceOf(
    event: EventEnvelope,
    runId: RunId,
    fold: RunFold,
    toolCallId: string | undefined,
  ): EpochPosition {
    const stampedSource = stampedSourceOf(event.payload);
    if (toolCallId === undefined) {
      return stampedSource ?? fold.standing;
    }
    const held = fold.openedToolCalls.get(toolCallId);
    fold.openedToolCalls.delete(toolCallId);
    return (
      stampedSource ??
      held ??
      this.#reads.readToolCallOpeningBefore(this.#sessionId, runId, toolCallId, event.sequence) ??
      fold.standing
    );
  }

  #foldFor(runId: RunId, sequence: number): RunFold {
    const held = this.#foldByRunId.get(runId);
    if (held !== undefined) {
      return held;
    }
    const seeded: RunFold = {
      standing: this.#reads.readStandingBefore(this.#sessionId, runId, sequence),
      turns: this.#reads.readSupersededTurns(this.#sessionId, runId),
      openedToolCalls: new Map(),
    };
    this.#foldByRunId.set(runId, seeded);
    return seeded;
  }
}
