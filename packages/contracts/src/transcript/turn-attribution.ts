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
} from "../generated/event/envelope.js";
import type { RunId } from "../generated/run/id.js";
import type { TranscriptRunStamp } from "../generated/transcript/row.js";

/** An execution epoch and a turn position within it. */
export interface EpochPosition {
  readonly epoch: SourceEpoch;
  readonly position: SourcePosition;
}

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

/** The stamp a row of the run made at `source` carries, superseded above its epoch's cut. */
export function transcriptRunStampAt(
  turns: SupersededTurns,
  source: EpochPosition,
): TranscriptRunStamp {
  const cut = turns.cuts[source.epoch];
  return cut !== undefined && source.position > cut.point
    ? { position: source.position, epoch: source.epoch, superseded: { targetPosition: cut.point } }
    : { position: source.position, epoch: source.epoch };
}

/** Where a turn boundary moves its run: to the position the provider supplied, else the next. */
export function standingAfterTurnStarted(
  standing: EpochPosition,
  payload: Readonly<Record<string, unknown>>,
): EpochPosition {
  return {
    epoch: standing.epoch,
    position: wholeNumberOf(payload["position"]) ?? standing.position + 1,
  };
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
  const epoch = wholeNumberOf(payload[SOURCE_EPOCH_PAYLOAD_KEY]);
  const position = wholeNumberOf(payload[SOURCE_POSITION_PAYLOAD_KEY]);
  return epoch === undefined || position === undefined ? undefined : { epoch, position };
}

/** The tool call a row of `category` belongs to, or `undefined` for a row of no tool call. */
export function transcriptToolCallIdOf(
  category: EventCategory | undefined,
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const toolCallId = payload["toolCallId"];
  return category === "toolActivity" && typeof toolCallId === "string" ? toolCallId : undefined;
}

/** A JSON number that is a whole number from 0 to 2^53 − 1, else `undefined`. */
function wholeNumberOf(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}
