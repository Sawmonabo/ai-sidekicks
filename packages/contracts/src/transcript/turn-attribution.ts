// Which turn of its run an event belongs to: the rules the daemon stamps every event of a run by,
// so a reader stamping a log follows the daemon's rules. A turn boundary moves the run to its next
// position, an accepted rollback ends the epoch it rewound and opens the next at its point, and a
// row stamped late or belonging to a tool call takes the turn it was made in. Each accepted
// rollback cuts the epoch it rewound; a turn above its epoch's cut is superseded, and a later cut
// below an earlier epoch's point supersedes that epoch's turns down to it too, because the earlier
// epoch's surviving prefix is part of the history the later cut rewound.

import {
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
  type EventCategory,
  type SourceEpoch,
  type SourcePosition,
} from "../event/envelope.js";
import type { RunId } from "../run/id.js";
import type { SupersededMarker, TranscriptRunStamp } from "./row.js";

/** The event type of a turn boundary, which moves its run to its next turn. */
export const TURN_STARTED_EVENT_TYPE = "run.turn_started";

/** The event type that opens a tool call; the call's later rows take the turn it opened in. */
export const TOOL_CALL_OPENING_EVENT_TYPE = "tool.invoked";

// The category whose rows belong to a tool call by their `toolCallId`.
const TOOL_ACTIVITY_CATEGORY: EventCategory = "tool_activity";

/** An execution epoch and a turn position within it. */
export interface EpochPosition {
  readonly epoch: SourceEpoch;
  readonly position: SourcePosition;
}

/** Where every run starts: the first epoch, before its first turn. */
export const RUN_START_POSITION: EpochPosition = { epoch: 0, position: 0 };

/**
 * A run's superseded turns: one cut per epoch an accepted rollback rewound, oldest first, each
 * with the point its epoch's turns above are superseded from. The k-th rollback rewound epoch k,
 * so `cuts[epoch]` is that epoch's cut.
 */
export interface SupersededTurns {
  readonly runId: RunId;
  readonly cuts: readonly { readonly sourceEpoch: SourceEpoch; readonly point: SourcePosition }[];
}

/**
 * Adds the run's next accepted rollback, which rewound epoch `turns.cuts.length` to `point`. An
 * earlier epoch's point drops to it when it lies lower.
 */
export function addSupersedingCut(turns: SupersededTurns, point: SourcePosition): SupersededTurns {
  return {
    runId: turns.runId,
    cuts: [
      ...turns.cuts.map((cut) => ({
        sourceEpoch: cut.sourceEpoch,
        point: Math.min(cut.point, point),
      })),
      { sourceEpoch: turns.cuts.length, point },
    ],
  };
}

// The marker of the run's turn at `epoch` and `position`, or `undefined` while it is current.
function supersededMarkerOf(
  turns: SupersededTurns,
  epoch: SourceEpoch,
  position: SourcePosition,
): SupersededMarker | undefined {
  const cut = turns.cuts[epoch];
  return cut !== undefined && position > cut.point ? { targetPosition: cut.point } : undefined;
}

/** The stamp a row of the run made at `source` carries, superseded when a cut lies below it. */
export function transcriptRunStampAt(
  turns: SupersededTurns,
  source: EpochPosition,
): TranscriptRunStamp {
  const superseded = supersededMarkerOf(turns, source.epoch, source.position);
  return superseded === undefined
    ? { position: source.position, epoch: source.epoch }
    : { position: source.position, epoch: source.epoch, superseded };
}

/** Where a turn boundary moves its run: to the position the provider supplied, else the next. */
export function standingAfterTurnStarted(
  standing: EpochPosition,
  payload: Readonly<Record<string, unknown>>,
): EpochPosition {
  const supplied = payload["position"];
  const position =
    typeof supplied === "number" && Number.isInteger(supplied) && supplied >= 0
      ? supplied
      : standing.position + 1;
  return { epoch: standing.epoch, position };
}

/** Where an accepted rollback to `targetPosition` moves its run: the next epoch, at that turn. */
export function standingAfterRollback(
  standing: EpochPosition,
  targetPosition: SourcePosition,
): EpochPosition {
  return { epoch: standing.epoch + 1, position: targetPosition };
}

/**
 * The epoch and turn a row appended after a cut is stamped with, or `undefined` for a row
 * delivered in time, which carries neither.
 */
export function stampedSourceOf(
  payload: Readonly<Record<string, unknown>>,
): EpochPosition | undefined {
  const epoch = payload[SOURCE_EPOCH_PAYLOAD_KEY];
  const position = payload[SOURCE_POSITION_PAYLOAD_KEY];
  return typeof epoch === "number" && typeof position === "number"
    ? { epoch, position }
    : undefined;
}

/** The tool call a row of `category` belongs to, or `undefined` for a row of no tool call. */
export function transcriptToolCallIdOf(
  category: EventCategory | undefined,
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const toolCallId = payload["toolCallId"];
  return category === TOOL_ACTIVITY_CATEGORY && typeof toolCallId === "string"
    ? toolCallId
    : undefined;
}
