// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The transcript row every transcript read returns, discriminated on the closed `kind`, and the run stamp of an event delivered without its row.

import type {
  EventCategory,
  HydratedContentUnavailableReason,
  SourceEpoch,
  SourcePosition,
} from "../event/envelope.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { AgentRunRolledBackEvent } from "../run/control.js";
import type { RunId } from "../run/id.js";
import type { EventCursor, SessionId } from "../session/id.js";
import type { ChildRunSummary } from "./child-run-summary.js";

/** The event type the `rollbackBoundary` arm pins. */
export const TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE = "agent.run.rolledBack" as const;

/**
 * The category every `runLifecycle` event belongs to, and the one the boundary arm pins.
 * Every type in it is run-scoped, which is why the `general` arm refuses the category.
 */
export const TRANSCRIPT_RUN_LIFECYCLE_CATEGORY = "runLifecycle" as const;

/** The payload keys that name a run: `runId` everywhere, and `targetRunId` on interventions. */
export const TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS = ["runId", "targetRunId"] as const;

/**
 * The event type of a turn boundary, which moves its run to the position its opening message
 * takes.
 */
export const TURN_STARTED_EVENT_TYPE = "agent.turn.started" as const;

/**
 * The event types that move a run to a position of its own, one per message of the person's
 * the run took: a turn boundary and a steer.
 */
export const RUN_POSITION_EVENT_TYPES = ["agent.turn.started", "agent.turn.steered"] as const;

/**
 * The event type that opens a tool call; the call's later rows take the run position it
 * opened at.
 */
export const TOOL_CALL_OPENING_EVENT_TYPE = "agent.toolCall.invoked" as const;

/**
 * Where every run starts: the first epoch, before the first of the person's messages it
 * takes.
 */
export const RUN_START_POSITION = { epoch: 0, position: 0 } as const;

/**
 * Why a prose body carries no block starts: its markdown cut failed, so the screen draws the row
 * with the failure rather than leaving it out. A failed cut fails that row alone.
 */
export type BlockCutFailure = "stalled" | "overPage";
/**
 * What a row read from history carries of its body: the body itself, why there is none, or the
 * size alone of a large one. An `available` body serializes to at most 32,768 JSON bytes.
 */
export type TranscriptRowContent =
  | {
      status: "available";
      /**
       * The whole body. A body whose JSON takes more than
       * [`TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES`] bytes belongs on the `large` arm.
       */
      body: string;
      /**
       * The whole body's UTF-8 byte length, echoed from the stored payload.
       */
      contentLength?: number;
      /**
       * The body's block starts, on a prose body; on a row whose reply is still arriving, only
       * those no later text can move.
       */
      blockStarts?: Uint8Array;
      /**
       * Why a prose body carries no block starts, when its cut failed; never beside them.
       */
      blockCutFailure?: BlockCutFailure;
    }
  | {
      status: "unavailable";
      /**
       * Why.
       */
      reason: HydratedContentUnavailableReason;
    }
  | {
      status: "large";
      /**
       * The whole body's UTF-8 byte length, as the stored event states it.
       */
      contentLength: number;
    };
/**
 * A transcript row as a read returns it, its body required, discriminated on `kind`. The arm is
 * chosen by `kind`, so a failure is reported against that arm and never retried against a
 * sibling.
 */
export type TranscriptReadRow =
  | {
      kind: "rollbackBoundary";
      /**
       * The id of the event this row projects from; opaque on the wire.
       */
      id: string;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The session event sequence, never a run position: re-execution reuses run
       * ordinals.
       */
      sequence: number;
      /**
       * The position the session's stream delivers this event at, relayed verbatim, so a
       * link naming a message by its cursor finds the row however the row was read.
       */
      cursor: EventCursor;
      /**
       * Who acted.
       */
      actor?: string;
      /**
       * When the event occurred.
       */
      timestamp: WireInstant;
      /**
       * Present when this row is a summarized child-run row.
       */
      childRunSummary?: ChildRunSummary;
      /**
       * Present on a tool call's row that left out one or more patches.
       *
       * @minItems 1
       */
      omittedPatches?: [TranscriptOmittedPatch, ...TranscriptOmittedPatch[]];
      /**
       * The row's body.
       */
      content: TranscriptRowContent;
      /**
       * Pinned with `type`: `agent.run.rolledBack` belongs to this category only.
       */
      category: "runLifecycle";
      /**
       * The rollback event's type.
       */
      type: "agent.run.rolledBack";
      /**
       * The run the rollback rewound.
       */
      runId: RunId;
      /**
       * The boundary row's own originating position, the confirmed rewind floor.
       */
      position: SourcePosition;
      /**
       * The epoch the rollback rewound.
       */
      epoch: SourceEpoch;
      /**
       * Present when a later, lower rollback superseded the boundary row itself.
       */
      superseded?: SupersededMarker;
      /**
       * The rollback, which names the row's run, session and position.
       */
      payload: AgentRunRolledBackEvent;
    }
  | {
      kind: "run";
      /**
       * The id of the event this row projects from; opaque on the wire.
       */
      id: string;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The session event sequence, never a run position: re-execution reuses run
       * ordinals.
       */
      sequence: number;
      /**
       * The position the session's stream delivers this event at, relayed verbatim, so a
       * link naming a message by its cursor finds the row however the row was read.
       */
      cursor: EventCursor;
      /**
       * Who acted.
       */
      actor?: string;
      /**
       * When the event occurred.
       */
      timestamp: WireInstant;
      /**
       * Present when this row is a summarized child-run row.
       */
      childRunSummary?: ChildRunSummary;
      /**
       * Present on a tool call's row that left out one or more patches.
       *
       * @minItems 1
       */
      omittedPatches?: [TranscriptOmittedPatch, ...TranscriptOmittedPatch[]];
      /**
       * The row's body.
       */
      content: TranscriptRowContent;
      /**
       * The event's category.
       */
      category: EventCategory;
      /**
       * The event's type; never `agent.run.rolledBack`, which only the boundary arm carries.
       */
      type: string;
      /**
       * The run the row belongs to.
       */
      runId: RunId;
      /**
       * The row's originating run position; above any superseded marker's cutoff.
       */
      position: SourcePosition;
      /**
       * The row's execution epoch.
       */
      epoch: SourceEpoch;
      /**
       * Present exactly when the row's turn is superseded.
       */
      superseded?: SupersededMarker;
      /**
       * The event's payload, an open record whose echoed attribution agrees with the row's.
       */
      payload: {
        runId?: unknown;
        targetRunId?: unknown;
        sourceEpoch?: unknown;
        sourcePosition?: unknown;
        [k: string]: unknown | undefined;
      };
    }
  | {
      kind: "general";
      /**
       * The id of the event this row projects from; opaque on the wire.
       */
      id: string;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The session event sequence, never a run position: re-execution reuses run
       * ordinals.
       */
      sequence: number;
      /**
       * The position the session's stream delivers this event at, relayed verbatim, so a
       * link naming a message by its cursor finds the row however the row was read.
       */
      cursor: EventCursor;
      /**
       * Who acted.
       */
      actor?: string;
      /**
       * When the event occurred.
       */
      timestamp: WireInstant;
      /**
       * Present when this row is a summarized child-run row.
       */
      childRunSummary?: ChildRunSummary;
      /**
       * Present on a tool call's row that left out one or more patches.
       *
       * @minItems 1
       */
      omittedPatches?: [TranscriptOmittedPatch, ...TranscriptOmittedPatch[]];
      /**
       * The row's body.
       */
      content: TranscriptRowContent;
      /**
       * The event's category; never `runLifecycle`, whose every event is run-scoped.
       */
      category: EventCategory;
      /**
       * The event's type, free-form by contract: narrow on `kind`, never on this.
       */
      type: string;
      /**
       * The event's payload, an open record that names no run.
       */
      payload: {
        runId?: unknown;
        targetRunId?: unknown;
        [k: string]: unknown | undefined;
      };
    };

/**
 * The superseded marker: present exactly when the row's run position is superseded.
 * `targetPosition` is the rewind cutoff of the first accepted rollback in the run's lineage, at
 * the row's epoch or later, that rewound the surviving history containing the row.
 */
export interface SupersededMarker {
  /**
   * The rewind cutoff.
   */
  targetPosition: SourcePosition;
}
/**
 * One file whose patch a tool call's row left out, and the patch's size in bytes;
 * `transcript.patch.list` fetches every left-out patch of the call in one read.
 */
export interface TranscriptOmittedPatch {
  /**
   * The file's path; a file the call moved is named by its new path.
   */
  path: string;
  /**
   * The old path of a file the call moved.
   */
  oldPath?: string;
  /**
   * The patch's size in bytes.
   */
  size: number;
}
/**
 * The run attribution the daemon stamps on one event of a run: its run position, its execution
 * epoch and, when the position was rolled back, the superseded marker, which ranks below the
 * position.
 */
export interface TranscriptRunStamp {
  /**
   * The run position: the person's messages the run took (a turn's opening or a steer).
   */
  position: SourcePosition;
  /**
   * The execution epoch.
   */
  epoch: SourceEpoch;
  /**
   * Present when the turn was rolled back.
   */
  superseded?: SupersededMarker;
}

export {
  validateBlockCutFailure,
  validateSupersededMarker,
  validateTranscriptOmittedPatch,
  validateTranscriptReadRow,
  validateTranscriptRowContent,
  validateTranscriptRunStamp,
} from "../checks/transcript/row.js";
