// Compile-time tests of the `TimelineRow` narrowing guarantee: consumers narrow on `row.kind`,
// never on the free-form `type`. The runtime suite proves the schema refuses a partial run row;
// this file pins the type side, since a schema can refuse a partial row while the type leaves
// `position` optional and every consumer must then re-check it. Three claims:
//   1. `kind === "run"` yields a type whose `runId`, `position` and `epoch` are required and
//      whose `superseded` is optional.
//   2. `kind === "rollback_boundary"` yields a typed `RunRolledBackEvent` payload, so
//      `payload.targetPosition` is a `number` without a cast.
//   3. `kind === "general"` yields a type with no attribution member.
// A failing claim shows up as TS2344 in the package typecheck.

import type { EventCursor } from "./session.js";
import type { RunRolledBackEvent } from "./run-control.js";
import type {
  ChildRunCompleteness,
  ChildRunExpandResponse,
  ChildRunSummary,
  ReasoningSurfaceReadResponse,
  TimelineReadResponse,
  TimelineRow,
} from "./timeline/index.js";

/** Fails to compile (TS2344) at the instantiation when `T` is not `never`. */
type AssertNever<T extends never> = T;

/** Type-level constraint failure when `Actual` does not extend `Expected`. */
type AssertExtends<Expected, Actual extends Expected> = Actual;

/**
 * The keys of `T` that are REQUIRED. `object` is assignable to `{ k?: V }` and
 * not to `{ k: V }`, which is what separates the two.
 */
type RequiredKeys<T> = {
  [Key in keyof T]-?: object extends Pick<T, Key> ? never : Key;
}[keyof T];

// The narrowed arms are obtained the way a consumer obtains them, by discriminating on `kind`;
// importing the arm interface would not prove that `kind` selects it.
type RunArm = Extract<TimelineRow, { kind: "run" }>;
type RollbackBoundaryArm = Extract<TimelineRow, { kind: "rollback_boundary" }>;
type GeneralArm = Extract<TimelineRow, { kind: "general" }>;

// Claim 1: the run arm's attribution triple is required

type _RunArmAttributionIsRequired = AssertExtends<
  RequiredKeys<RunArm>,
  "runId" | "position" | "epoch"
>;

/** `position` and `epoch` are plain numbers on the narrowed arm, with no `| undefined`. */
type _RunArmPositionIsNumber = AssertExtends<number, RunArm["position"]>;
type _RunArmEpochIsNumber = AssertExtends<number, RunArm["epoch"]>;

/** The marker is optional: absence means current. */
type _SupersededMarkerIsOptional = AssertNever<Extract<RequiredKeys<RunArm>, "superseded">>;

/** The marker is single-field: `targetPosition` is the whole of it. */
type _SupersededMarkerIsSingleField = AssertExtends<
  "targetPosition",
  keyof NonNullable<RunArm["superseded"]>
>;

// Claim 2: the boundary arm's payload is the typed event, reachable without a cast

type _BoundaryPayloadIsTyped = AssertExtends<RunRolledBackEvent, RollbackBoundaryArm["payload"]>;

/**
 * The live client rule reads a `number` cutoff straight off the narrowed row; on the open
 * payload of the other arms this member would be `unknown`.
 */
type _BoundaryCutoffIsNumber = AssertExtends<
  number,
  RollbackBoundaryArm["payload"]["targetPosition"]
>;

/** The boundary arm's `type` is pinned, not the base's free-form string. */
type _BoundaryTypeIsPinned = AssertExtends<"run.rolled_back", RollbackBoundaryArm["type"]>;

/** Its `category` is pinned too, the one literal `run.rolled_back` is registered under. */
type _BoundaryCategoryIsPinned = AssertExtends<"run_lifecycle", RollbackBoundaryArm["category"]>;

// Claim 3: the general arm carries no attribution member

type _GeneralArmHasNoAttribution = AssertNever<
  Extract<keyof GeneralArm, "runId" | "position" | "epoch" | "superseded">
>;

// The read window's continuation cursor is reachable without a guard

type ContinuingWindow = Extract<TimelineReadResponse, { hasMore: true }>;
type TerminalWindow = Extract<TimelineReadResponse, { hasMore: false }>;

/** On the continuing arm the cursor is REQUIRED, not optional. */
type _ContinuingWindowRequiresCursor = AssertExtends<
  RequiredKeys<ContinuingWindow>,
  "entries" | "hasMore" | "nextCursor"
>;

/**
 * On the terminal arm the cursor is optional: the key must exist, because a client opens the
 * live stream (`session.subscribe` with `afterCursor`) from where the last page stopped, and it
 * must not be required, because a producer with nothing more to say need not mint one.
 */
type _TerminalWindowAllowsCursor = AssertExtends<keyof TerminalWindow, "nextCursor">;
type _TerminalWindowCursorIsOptional = AssertNever<
  Extract<RequiredKeys<TerminalWindow>, "nextCursor">
>;

/**
 * The consumer this shape exists for: `nextCursor` is reached by narrowing on `hasMore` alone,
 * with no non-null assertion, optional chain or runtime check.
 */
export function nextPageCursorOf(window: TimelineReadResponse): EventCursor | null {
  return window.hasMore ? window.nextCursor : null;
}

// The other two paged replies split on `hasMore` the same way

type ContinuingExpansion = Extract<ChildRunExpandResponse, { hasMore: true }>;
type ContinuingReasoning = Extract<
  ReasoningSurfaceReadResponse,
  { availability: "available"; hasMore: true }
>;

/** The expansion's continuing arm requires its cursor and keeps every terminal member. */
type _ContinuingExpansionRequiresCursor = AssertExtends<
  RequiredKeys<ContinuingExpansion>,
  "runId" | "parentRunId" | "state" | "entries" | "hasMore" | "nextCursor"
>;

/** Same rule on the one reasoning state that carries entries. */
type _ContinuingReasoningRequiresCursor = AssertExtends<
  RequiredKeys<ContinuingReasoning>,
  "availability" | "reasoningEntries" | "hasMore" | "nextCursor"
>;

/** The non-`available` reasoning states carry no `hasMore`, `nextCursor` or entries at all. */
type _UnpagedReasoningStatesHaveNoContinuation = AssertNever<
  Extract<
    keyof Extract<
      ReasoningSurfaceReadResponse,
      { availability: "unavailable" | "policy_redacted" }
    >,
    "hasMore" | "nextCursor" | "reasoningEntries"
  >
>;

/** The cursor of a child-run expansion is reached by narrowing on `hasMore` alone. */
export function nextExpansionCursorOf(expansion: ChildRunExpandResponse): EventCursor | null {
  return expansion.hasMore ? expansion.nextCursor : null;
}

// The incompleteness marker narrows the same way

type CompleteArm = Extract<ChildRunCompleteness, { state: "complete" }>;
type IncompleteArm = Extract<ChildRunCompleteness, { state: "incomplete" }>;

/** `cause` and `observedAt` are required — on the incomplete arm only. */
type _IncompleteArmRequiresBoth = AssertExtends<
  RequiredKeys<IncompleteArm>,
  "state" | "cause" | "observedAt"
>;

/** The complete arm carries neither; an optional `cause` would let a `complete` row have one. */
type _CompleteArmHasNoCause = AssertNever<Extract<keyof CompleteArm, "cause" | "observedAt">>;

/** A consumer reaches the cause only after narrowing, so it is never `undefined`. */
export function retryabilityOf(summary: ChildRunSummary): "n/a" | "retryable" {
  if (summary.completeness.state === "complete") {
    return "n/a";
  }
  switch (summary.completeness.cause) {
    case "detail_fetch_failed":
      return "retryable";
    default: {
      // Exhaustiveness: a cause added without a case here fails to compile.
      const unreachable: never = summary.completeness.cause;
      return unreachable;
    }
  }
}

// The narrowing itself, exercised the way a renderer does it

/**
 * A worked consumer with no cast, no optional chaining onto the attribution triple and no read
 * of the free-form `type`; it stops compiling if `kind` stops discriminating.
 */
export function isSupersededAgainstCutoff(row: TimelineRow, rewindCutoff: number): boolean {
  switch (row.kind) {
    case "run":
      return row.position > rewindCutoff;
    case "rollback_boundary":
      return row.position > row.payload.targetPosition;
    case "general":
      return false;
    default: {
      // Exhaustiveness: a fourth arm added without a case here fails to compile.
      const unreachable: never = row;
      return unreachable;
    }
  }
}
