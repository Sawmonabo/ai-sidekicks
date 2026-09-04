// Timeline-row builders for this subtree's co-located tests.
//
// WHY IT SITS HERE AND NOT UNDER `test/console/`. `apps/desktop/AGENTS.md` sends
// cross-TEST scaffolding to `test/console/`, and that home is for shared ROLES —
// the render harness, the spawn-and-scan harness, a path resolver — reached by the
// tier suites that live there. This is neither: it is one subtree's fixture
// vocabulary, used by the seven co-located `console-unit` files beside it and by
// nothing else, and no co-located console test in this tree reaches across into
// `test/`. Hoisting it into a shared home would make a private fixture look like a
// contract every tier may build on.
//
// It is deliberately NOT re-exported from `structure/index.ts`: the family door is
// what the console's surfaces consume, and a fixture builder is not part of that.
// The dead-code gate still reaches it, because the Vitest plugin makes every test
// file an entry point.
//
// WHAT THE BUILDERS GUARANTEE. Every row they produce is a real `TimelineRow`
// under the contract's own discriminated union — the arms are selected by `kind`
// and their required members are supplied, so a test can never assert against a
// shape the daemon could not send. The one cast is `SessionId`, whose brand is a
// compile-time nominal tag over `string` with no runtime witness.

import {
  TIMELINE_ROLLBACK_BOUNDARY_TYPE,
  TIMELINE_RUN_LIFECYCLE_CATEGORY,
  type EventCategory,
  type RunId,
  type SessionId,
  type TimelineRow,
} from "@ai-sidekicks/contracts";

/** The one session every fixture row belongs to. */
export const FIXTURE_SESSION_ID = "11111111-2222-4333-8444-555555555555" as SessionId;

/** What every builder takes, beyond what its own arm requires. */
export interface FixtureRowInput {
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
 * A wall-clock instant derived from the sequence.
 *
 * One second per sequence step from a fixed epoch, so a fixture's rows are ordered
 * the same way by sequence and by `occurredAt` unless a case deliberately says
 * otherwise — which is what lets a replay test assert ordering without every case
 * hand-writing timestamps.
 */
export function fixtureTimestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 0, 1, 9, 0, sequence)).toISOString();
}

function commonFields(input: FixtureRowInput): {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly sequence: number;
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
    category: input.category ?? "run_lifecycle",
    type: input.type,
    actor: input.actor,
    summary: input.summary ?? input.type,
    timestamp: input.timestamp ?? fixtureTimestamp(input.sequence),
  };
}

/** The `general` arm — a row carrying no run attribution. */
export function generalRow(input: FixtureRowInput): TimelineRow {
  return { ...commonFields(input), kind: "general", payload: input.payload ?? {} };
}

/** The `run` arm — the required-attribution one. */
export function runRow(
  input: FixtureRowInput & {
    readonly runId: string;
    readonly position: number;
    readonly epoch?: number;
    readonly supersededTargetPosition?: number;
    readonly childRunIncomplete?: boolean;
  },
): TimelineRow {
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
  const childRunSummary =
    input.childRunIncomplete === true
      ? {
          childRunSummary: {
            runId: `${input.runId}-child` as RunId,
            parentRunId: input.runId as RunId,
            state: "running",
            eventCount: 1,
            completeness: {
              state: "incomplete",
              cause: "pending_backfill",
              observedAt: fixtureTimestamp(input.sequence),
            },
          },
        }
      : {};
  return { ...base, ...superseded, ...childRunSummary } as TimelineRow;
}

/** The `legacy_stub` arm — a compacted stub that can never be ranked or marked. */
export function legacyStubRow(input: FixtureRowInput & { readonly runId: string }): TimelineRow {
  return {
    ...commonFields(input),
    kind: "legacy_stub",
    runId: input.runId as RunId,
    payload: input.payload ?? {},
  };
}

/** The `rollback_boundary` arm, whose payload is the typed `RunRolledBackEvent`. */
export function rollbackBoundaryRow(
  input: Omit<FixtureRowInput, "type" | "category"> & {
    readonly runId: string;
    readonly position: number;
    readonly epoch?: number;
    readonly runVersion?: number;
    /**
     * The rewind cutoff, which is NOT the boundary row's own position.
     *
     * Defaulted to the row's position so the common case reads short, and
     * overridable because the interesting cases are exactly the ones where a
     * boundary sits later in the log than the turn it rewound to.
     */
    readonly targetPosition?: number;
  },
): TimelineRow {
  return {
    ...commonFields({ ...input, type: TIMELINE_ROLLBACK_BOUNDARY_TYPE }),
    category: TIMELINE_RUN_LIFECYCLE_CATEGORY,
    type: TIMELINE_ROLLBACK_BOUNDARY_TYPE,
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
