// Transcript-row builders for this subtree's co-located tests. Every row is a real
// `TranscriptEventRow` under the contract's discriminated union, so a test never asserts against a
// shape the daemon cannot send.

import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
  type TranscriptEventRow,
} from "@ai-sidekicks/contracts/transcript/row";
import type { EventCategory } from "@ai-sidekicks/contracts/event-envelope";
import type { RunId } from "@ai-sidekicks/contracts/provider-driver";
import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session";

/** The one session every fixture row belongs to. */
const FIXTURE_SESSION_ID = "11111111-2222-4333-8444-555555555555" as SessionId;

/** The `general` arm — a row carrying no run attribution. */
export function generalRow(input: FixtureRowInput): TranscriptEventRow {
  return { ...commonFields(input), kind: "general", payload: input.payload ?? {} };
}

/** The `run` arm — the required-attribution one. */
export function runRow(
  input: FixtureRowInput & {
    readonly runId: string;
    readonly position: number;
    readonly epoch?: number;
    readonly supersededTargetPosition?: number;
  },
): TranscriptEventRow {
  const base = {
    ...commonFields(input),
    kind: "run",
    runId: input.runId as RunId,
    position: input.position,
    epoch: input.epoch ?? 0,
    payload: input.payload ?? {},
  } as const;
  const superseded =
    input.supersededTargetPosition === undefined
      ? {}
      : { superseded: { targetPosition: input.supersededTargetPosition } };
  return { ...base, ...superseded } as TranscriptEventRow;
}

/** The `rollback_boundary` arm, whose payload is the typed `RunRolledBackEvent`. */
export function rollbackBoundaryRow(
  input: Omit<FixtureRowInput, "type" | "category"> & {
    readonly runId: string;
    readonly position: number;
    readonly epoch?: number;
    readonly runVersion?: number;
    /**
     * The rewind cutoff, which is not the boundary row's own position. Defaults to the row's
     * position; cases override it where the boundary sits later than the turn it rewound to.
     */
    readonly targetPosition?: number;
  },
): TranscriptEventRow {
  return {
    ...commonFields({ ...input, type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE }),
    category: TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
    type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
    kind: "rollback_boundary",
    runId: input.runId as RunId,
    position: input.position,
    epoch: input.epoch ?? 0,
    payload: {
      sessionId: FIXTURE_SESSION_ID,
      runId: input.runId as RunId,
      runVersion: input.runVersion ?? 1,
      targetPosition: input.targetPosition ?? input.position,
    },
  };
}

/** What every builder takes, beyond what its own arm requires. */
interface FixtureRowInput {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly category?: EventCategory;
  readonly actor?: string;
  readonly summary?: string;
  readonly timestamp?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * A wall-clock instant derived from the sequence: one second per step from a fixed epoch, so
 * rows order the same way by sequence and by `occurredAt` unless a case says otherwise.
 */
function fixtureTimestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 0, 1, 9, 0, sequence)).toISOString();
}

function commonFields(input: FixtureRowInput): {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly cursor: EventCursor;
  readonly category: EventCategory;
  readonly type: string;
  readonly actor: string | undefined;
  readonly summary: string;
  readonly timestamp: string;
} {
  return {
    id: input.id,
    sessionId: FIXTURE_SESSION_ID,
    sequence: input.sequence,
    cursor: `cursor-at-${String(input.sequence)}` as EventCursor,
    category: input.category ?? "run_lifecycle",
    type: input.type,
    actor: input.actor,
    summary: input.summary ?? input.type,
    timestamp: input.timestamp ?? fixtureTimestamp(input.sequence),
  };
}
