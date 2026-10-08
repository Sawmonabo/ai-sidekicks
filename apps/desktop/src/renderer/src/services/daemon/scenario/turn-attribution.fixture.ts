// Which turn of its run each event of a scenario's log belongs to, stamped as the daemon stamps it,
// so the fixture's stream changes and `transcript.read` rows carry the attribution the live daemon
// sends. A fold over the delivered log in order, on the daemon's rules: a turn boundary moves the
// run to its next position, an accepted rollback ends the epoch it rewound and opens the next at
// its point, and any other event takes the turn of its own execution (the source stamped on its
// payload, else the turn its tool call opened in, else the turn the run stands at). A turn above
// an epoch's cut is superseded; a later cut below an earlier epoch's point lowers that point too.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import {
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
} from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  type TranscriptRunStamp,
} from "@ai-sidekicks/contracts/transcript/row";
import { transcriptRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** One event of a run, attributed: the run it belongs to and the stamp the daemon gives it. */
export interface ScenarioRunAttribution {
  readonly runId: string;
  readonly stamp: TranscriptRunStamp;
}

/**
 * The turns of every run in one scenario log, folded event by event in sequence order. A stream
 * folds from the log's start, so a rollback marks only the turns it follows; a read seeds the cut
 * of every rollback the log holds first (`seededWithRollbacksOf`), as the daemon's read does.
 */
export class ScenarioTurnAttribution {
  readonly #foldByRunId = new Map<string, RunTurnFold>();
  readonly #seededCutsByRunId: ReadonlyMap<string, readonly number[]>;

  public constructor(seededCutsByRunId: ReadonlyMap<string, readonly number[]> = new Map()) {
    this.#seededCutsByRunId = seededCutsByRunId;
  }

  /** An attribution marked against every rollback `log` holds, for a read of that log. */
  public static seededWithRollbacksOf(
    log: readonly ProjectedSessionEvent[],
  ): ScenarioTurnAttribution {
    const cutsByRunId = new Map<string, number[]>();
    for (const event of log) {
      const rollback = rollbackOf(event);
      if (rollback !== undefined) {
        const cuts = cutsByRunId.get(rollback.runId) ?? [];
        cutsByRunId.set(rollback.runId, withSupersedingCut(cuts, rollback.targetPosition));
      }
    }
    return new ScenarioTurnAttribution(cutsByRunId);
  }

  /** The attribution of the next event of the log, or `undefined` for one naming no run. */
  public attribute(event: ProjectedSessionEvent): ScenarioRunAttribution | undefined {
    const rollback = rollbackOf(event);
    if (rollback !== undefined) {
      return this.#attributeRollback(rollback);
    }
    const runId = transcriptRunIdOf(event.payload);
    if (runId === undefined) {
      return undefined;
    }
    const fold = this.#foldFor(runId);
    const payload = event.payload ?? {};
    if (event.kind === TURN_STARTED_TYPE) {
      fold.standing = standingAfterTurnStarted(fold.standing, payload);
      return { runId, stamp: stampAt(fold.cuts, fold.standing) };
    }
    const toolCallId = toolCallIdOf(event);
    const stampedSource = stampedSourceOf(payload);
    if (toolCallId !== undefined && event.kind === TOOL_CALL_OPENING_TYPE) {
      const opening = stampedSource ?? fold.standing;
      fold.openedToolCalls.set(toolCallId, opening);
      return { runId, stamp: stampAt(fold.cuts, opening) };
    }
    const opening = toolCallId === undefined ? undefined : fold.openedToolCalls.get(toolCallId);
    return { runId, stamp: stampAt(fold.cuts, stampedSource ?? opening ?? fold.standing) };
  }

  #attributeRollback(rollback: ScenarioRollback): ScenarioRunAttribution {
    const fold = this.#foldFor(rollback.runId);
    const rewoundEpoch = fold.standing.epoch;
    // A rollback the seed already counted holds its cut.
    if (rewoundEpoch === fold.cuts.length) {
      fold.cuts = withSupersedingCut(fold.cuts, rollback.targetPosition);
    }
    const boundary: TurnPosition = { epoch: rewoundEpoch, position: rollback.targetPosition };
    fold.standing = { epoch: rewoundEpoch + 1, position: rollback.targetPosition };
    return { runId: rollback.runId, stamp: stampAt(fold.cuts, boundary) };
  }

  #foldFor(runId: string): RunTurnFold {
    let fold = this.#foldByRunId.get(runId);
    if (fold === undefined) {
      fold = {
        standing: RUN_START,
        cuts: this.#seededCutsByRunId.get(runId) ?? [],
        openedToolCalls: new Map(),
      };
      this.#foldByRunId.set(runId, fold);
    }
    return fold;
  }
}

const TURN_STARTED_TYPE = "run.turn_started";
const TOOL_CALL_OPENING_TYPE = "tool.invoked";
const TOOL_ACTIVITY_CATEGORY = "tool_activity";

/** An epoch and the turn within it. */
interface TurnPosition {
  readonly epoch: number;
  readonly position: number;
}

const RUN_START: TurnPosition = { epoch: 0, position: 0 };

/**
 * One run's place in the fold: where it stands, each rewound epoch's cut point (index = epoch),
 * and the turn each tool call opened in; the latest opening of a call wins, as the daemon reads it.
 */
interface RunTurnFold {
  standing: TurnPosition;
  cuts: readonly number[];
  readonly openedToolCalls: Map<string, TurnPosition>;
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

/** The cuts with the run's next rollback added; an earlier epoch's point drops to it when lower. */
function withSupersedingCut(cuts: readonly number[], point: number): number[] {
  return [...cuts.map((earlier) => Math.min(earlier, point)), point];
}

function standingAfterTurnStarted(
  standing: TurnPosition,
  payload: Readonly<Record<string, unknown>>,
): TurnPosition {
  const supplied = payload["position"];
  const position =
    typeof supplied === "number" && Number.isInteger(supplied) && supplied >= 0
      ? supplied
      : standing.position + 1;
  return { epoch: standing.epoch, position };
}

function stampedSourceOf(payload: Readonly<Record<string, unknown>>): TurnPosition | undefined {
  const epoch = payload[SOURCE_EPOCH_PAYLOAD_KEY];
  const position = payload[SOURCE_POSITION_PAYLOAD_KEY];
  return typeof epoch === "number" && typeof position === "number"
    ? { epoch, position }
    : undefined;
}

function toolCallIdOf(event: ProjectedSessionEvent): string | undefined {
  const toolCallId = event.payload?.["toolCallId"];
  const category = SESSION_EVENT_CATEGORY_BY_TYPE.get(event.kind as SessionEventType);
  return category === TOOL_ACTIVITY_CATEGORY && typeof toolCallId === "string"
    ? toolCallId
    : undefined;
}

function stampAt(cuts: readonly number[], source: TurnPosition): TranscriptRunStamp {
  const cut = cuts[source.epoch];
  return cut !== undefined && source.position > cut
    ? { position: source.position, epoch: source.epoch, superseded: { targetPosition: cut } }
    : { position: source.position, epoch: source.epoch };
}
