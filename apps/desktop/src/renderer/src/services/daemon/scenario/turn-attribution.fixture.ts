// Which turn of its run each event of a scenario's log belongs to, stamped by the daemon's rules
// (`@ai-sidekicks/contracts/transcript/turn-attribution`), so the fixture's stream changes and
// `transcript.read` rows carry the attribution the live daemon sends. As the daemon's fold, it is
// fed one ascending stretch of the log, a read's window or a stream's deliveries, and seeds a run
// on first sight from the delivered log: where the run stands just before that event, and a cut
// for every rollback of it the log holds by then, so a row is marked by a rollback after it.
//
// The daemon also frees a run's fold at its terminal event and seeds it again from the log on the
// next event. Seeding from the same log gives that event the stamp the held fold gives it, so this
// fold keeps every run's fold for the playback.

import type { EventCategory } from "@ai-sidekicks/contracts/event/envelope";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
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

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** One event of a run, attributed: the run it belongs to and the stamp the daemon gives it. */
export interface ScenarioRunAttribution {
  readonly runId: string;
  readonly stamp: TranscriptRunStamp;
}

/** The turns of every run in one scenario log, folded event by event in sequence order. */
export class ScenarioTurnAttribution {
  readonly #readLog: () => readonly ProjectedSessionEvent[];
  readonly #foldByRunId = new Map<string, RunTurnFold>();

  /** Seeds each run from `readLog`, the delivered log as it stands when the run is first met. */
  public constructor(readLog: () => readonly ProjectedSessionEvent[]) {
    this.#readLog = readLog;
  }

  /** The attribution of the next event of the stretch, or `undefined` for one naming no run. */
  public attribute(event: ProjectedSessionEvent): ScenarioRunAttribution | undefined {
    const rollback = rollbackOf(event);
    if (rollback !== undefined) {
      return this.#attributeRollback(rollback, event.sequence);
    }
    const runId = transcriptRunIdOf(event.payload);
    if (runId === undefined) {
      return undefined;
    }
    const fold = this.#foldFor(runId, event.sequence);
    const payload = event.payload ?? {};
    if (event.kind === TURN_STARTED_EVENT_TYPE) {
      fold.standing = standingAfterTurnStarted(fold.standing, payload);
      return { runId, stamp: transcriptRunStampAt(fold.turns, fold.standing) };
    }
    const toolCallId = transcriptToolCallIdOf(categoryOf(event), payload);
    if (toolCallId !== undefined && event.kind === TOOL_CALL_OPENING_EVENT_TYPE) {
      const opening = stampedSourceOf(payload) ?? fold.standing;
      fold.openedToolCalls.set(toolCallId, opening);
      return { runId, stamp: transcriptRunStampAt(fold.turns, opening) };
    }
    const source = this.#sourceOf(event, runId, fold, toolCallId);
    return { runId, stamp: transcriptRunStampAt(fold.turns, source) };
  }

  #attributeRollback(rollback: ScenarioRollback, sequence: number): ScenarioRunAttribution {
    const fold = this.#foldFor(rollback.runId, sequence);
    const rewoundEpoch = fold.standing.epoch;
    // A rollback the seed already counted holds its cut.
    if (rewoundEpoch === fold.turns.cuts.length) {
      fold.turns = addSupersedingCut(fold.turns, rollback.targetPosition);
    }
    const boundary: EpochPosition = { epoch: rewoundEpoch, position: rollback.targetPosition };
    fold.standing = standingAfterRollback(fold.standing, rollback.targetPosition);
    return { runId: rollback.runId, stamp: transcriptRunStampAt(fold.turns, boundary) };
  }

  // The turn a row of the run belongs to. A row of a tool call ends its held opening, and a later
  // row of that call reads the opening from the log, as the daemon's does.
  #sourceOf(
    event: ProjectedSessionEvent,
    runId: string,
    fold: RunTurnFold,
    toolCallId: string | undefined,
  ): EpochPosition {
    const stampedSource = stampedSourceOf(event.payload ?? {});
    if (toolCallId === undefined) {
      return stampedSource ?? fold.standing;
    }
    const held = fold.openedToolCalls.get(toolCallId);
    fold.openedToolCalls.delete(toolCallId);
    return (
      stampedSource ??
      held ??
      toolCallOpeningBefore(this.#readLog(), runId, toolCallId, event.sequence) ??
      fold.standing
    );
  }

  #foldFor(runId: string, sequence: number): RunTurnFold {
    const held = this.#foldByRunId.get(runId);
    if (held !== undefined) {
      return held;
    }
    const log = this.#readLog();
    const seeded: RunTurnFold = {
      standing: standingBefore(log, runId, sequence),
      turns: supersededTurnsOf(log, runId),
      openedToolCalls: new Map(),
    };
    this.#foldByRunId.set(runId, seeded);
    return seeded;
  }
}

/** One run's place in the fold: where it stands, its cuts, and the turn each open call began in. */
interface RunTurnFold {
  standing: EpochPosition;
  turns: SupersededTurns;
  readonly openedToolCalls: Map<string, EpochPosition>;
}

/** The members of a `run.rolled_back` the fold reads. */
interface ScenarioRollback {
  readonly runId: string;
  readonly targetPosition: number;
}

function rollbackOf(event: ProjectedSessionEvent): ScenarioRollback | undefined {
  if (event.kind !== TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE) {
    return undefined;
  }
  const runId = event.payload?.["runId"];
  const targetPosition = event.payload?.["targetPosition"];
  return typeof runId === "string" && typeof targetPosition === "number"
    ? { runId, targetPosition }
    : undefined;
}

function categoryOf(event: ProjectedSessionEvent): EventCategory | undefined {
  return SESSION_EVENT_CATEGORY_BY_TYPE.get(event.kind as SessionEventType);
}

/** Where the run stands just before `beforeSequence`: its rollbacks and turns before it. */
function standingBefore(
  log: readonly ProjectedSessionEvent[],
  runId: string,
  beforeSequence: number,
): EpochPosition {
  let standing = RUN_START_POSITION;
  for (const event of log) {
    if (event.sequence >= beforeSequence) {
      continue;
    }
    const rollback = rollbackOf(event);
    if (rollback?.runId === runId) {
      standing = standingAfterRollback(standing, rollback.targetPosition);
    } else if (
      event.kind === TURN_STARTED_EVENT_TYPE &&
      transcriptRunIdOf(event.payload) === runId
    ) {
      standing = standingAfterTurnStarted(standing, event.payload ?? {});
    }
  }
  return standing;
}

/** The run's cuts from every rollback of it the log holds. */
function supersededTurnsOf(log: readonly ProjectedSessionEvent[], runId: string): SupersededTurns {
  // A scenario's run ids are the ids its beats carry, which the daemon would have minted.
  let turns: SupersededTurns = { runId: runId as RunId, cuts: [] };
  for (const event of log) {
    const rollback = rollbackOf(event);
    if (rollback?.runId === runId) {
      turns = addSupersedingCut(turns, rollback.targetPosition);
    }
  }
  return turns;
}

/**
 * Where the run's latest call `toolCallId` opened before `beforeSequence`, or `undefined` when no
 * such call opened: the source stamped on its opening, else the turn the run stood at then.
 */
function toolCallOpeningBefore(
  log: readonly ProjectedSessionEvent[],
  runId: string,
  toolCallId: string,
  beforeSequence: number,
): EpochPosition | undefined {
  const opening = log.findLast(
    (event) =>
      event.sequence < beforeSequence &&
      event.kind === TOOL_CALL_OPENING_EVENT_TYPE &&
      transcriptRunIdOf(event.payload) === runId &&
      transcriptToolCallIdOf(categoryOf(event), event.payload ?? {}) === toolCallId,
  );
  if (opening === undefined) {
    return undefined;
  }
  return stampedSourceOf(opening.payload ?? {}) ?? standingBefore(log, runId, opening.sequence);
}
