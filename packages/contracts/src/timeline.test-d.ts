// Conditional-type test against the `TimelineRow` narrowing guarantee.
//
// Verifies (Plan-013 T1.1; `Plan-013 §Invariants` I-013-1 and I-013-3):
//   `Plan-013 §API And Transport Changes` — "every timeline surface returns
//   the `TimelineRow` union, genuinely discriminated on the literal `kind`
//   field … consumers narrow structurally on `row.kind`, never probing the
//   free-form `type`".
//
// The runtime suite (`__tests__/timeline.test.ts`) proves the SCHEMA refuses a
// partial run row. That is a different claim from the one asserted here, and
// neither implies the other: a schema can refuse a partial row while the TYPE
// still leaves `position` optional, in which case every consumer must
// defensively re-check a member the parser already guaranteed — and one that
// forgets ships an `undefined` into the rollback comparison. This file pins
// the type side.
//
// Four claims, each a compile-time constraint rather than a runtime assertion:
//   1. Narrowing on `kind === "run"` yields a type whose `runId` / `position` /
//      `epoch` are REQUIRED, and whose `superseded` is optional.
//   2. Narrowing on `kind === "legacy_stub"` yields a type that has NO
//      `position` / `epoch` / `superseded` keys at all — structurally absent,
//      not optional-and-usually-missing.
//   3. Narrowing on `kind === "rollback_boundary"` yields a typed
//      `RunRolledBackEvent` payload, so `payload.targetPosition` is a `number`
//      reachable without a cast (I-013-5).
//   4. Narrowing on `kind === "general"` yields a type carrying NO attribution
//      member, so a consumer cannot read a run identity off the non-run arm.
//
// Negative-test verification (run during the implementing task):
//   • make `position` optional on `RunScopedTimelineEntry`
//   • run `pnpm --filter @ai-sidekicks/contracts typecheck`
//   • expect TS2344 at the `RunArmAttributionIsRequired` line below
//   • restore + re-run to confirm typecheck passes
// The same dance was run for claims 2, 3, and 4. Subsequent edits to the row
// union re-trigger every check in CI typecheck.

import type { EventCursor } from "./session.js";
import type { RunRolledBackEvent } from "./runControl.js";
import type {
  ChildRunCompleteness,
  ChildRunExpandResponse,
  ChildRunSummary,
  ReasoningSurfaceReadResponse,
  TimelineReadResponse,
  TimelineRow,
} from "./timeline/index.js";

/**
 * Type-level constraint failure when `T` is non-never — TS2344 fires at the
 * instantiation. `@typescript-eslint/no-unused-vars` does not flag unused type
 * aliases, so no suppression is needed; the `_` prefix matches the repo lint
 * config's `varsIgnorePattern` regardless.
 */
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

// The four narrowed arms, obtained the way a consumer obtains them: by
// discriminating the union on `kind`, never by importing the arm interface.
// Importing the arm would prove the arm's own shape and prove nothing about
// whether `kind` selects it.
type RunArm = Extract<TimelineRow, { kind: "run" }>;
type LegacyStubArm = Extract<TimelineRow, { kind: "legacy_stub" }>;
type RollbackBoundaryArm = Extract<TimelineRow, { kind: "rollback_boundary" }>;
type GeneralArm = Extract<TimelineRow, { kind: "general" }>;

// ---------------------------------------------------------------------------
// Claim 1 — the run arm's attribution triple is required, all-or-none (I-013-1)
// ---------------------------------------------------------------------------

type _RunArmAttributionIsRequired = AssertExtends<
  RequiredKeys<RunArm>,
  "runId" | "position" | "epoch"
>;

/** `position` and `epoch` are plain numbers on the narrowed arm — no `| undefined`. */
type _RunArmPositionIsNumber = AssertExtends<number, RunArm["position"]>;
type _RunArmEpochIsNumber = AssertExtends<number, RunArm["epoch"]>;

/** The marker is optional — absence is what "current" means (I-013-3). */
type _SupersededMarkerIsOptional = AssertNever<Extract<RequiredKeys<RunArm>, "superseded">>;

/** …and single-field: `targetPosition` is the whole of it. */
type _SupersededMarkerIsSingleField = AssertExtends<
  "targetPosition",
  keyof NonNullable<RunArm["superseded"]>
>;

// ---------------------------------------------------------------------------
// Claim 2 — the legacy stub has no position/epoch KEYS (structurally absent)
// ---------------------------------------------------------------------------

type _LegacyStubHasNoOrdinals = AssertNever<
  Extract<keyof LegacyStubArm, "position" | "epoch" | "superseded">
>;

/** It does keep `runId` — every run-scoped stub preserves it. */
type _LegacyStubKeepsRunId = AssertExtends<RequiredKeys<LegacyStubArm>, "runId">;

// ---------------------------------------------------------------------------
// Claim 3 — the boundary arm's payload is the typed event, reachable uncast
// ---------------------------------------------------------------------------

type _BoundaryPayloadIsTyped = AssertExtends<RunRolledBackEvent, RollbackBoundaryArm["payload"]>;

/**
 * The consequence that matters: the live client rule reads a `number` cutoff
 * straight off the narrowed row. On the open `Record<string, unknown>` payload
 * the other arms carry, this member would be `unknown`.
 */
type _BoundaryCutoffIsNumber = AssertExtends<
  number,
  RollbackBoundaryArm["payload"]["targetPosition"]
>;

/** The boundary arm's `type` is pinned, not the base's free-form string. */
type _BoundaryTypeIsPinned = AssertExtends<"run.rolled_back", RollbackBoundaryArm["type"]>;

/**
 * …and so is its `category`. On the other three arms this is the open
 * `EventCategory` enum; here it is the one literal `run.rolled_back` is
 * registered under, so a consumer that groups rows by category cannot be
 * handed a boundary filed anywhere else.
 */
type _BoundaryCategoryIsPinned = AssertExtends<"run_lifecycle", RollbackBoundaryArm["category"]>;

// ---------------------------------------------------------------------------
// Claim 4 — the general arm carries no attribution member
// ---------------------------------------------------------------------------

type _GeneralArmHasNoAttribution = AssertNever<
  Extract<keyof GeneralArm, "runId" | "position" | "epoch" | "superseded">
>;

// ---------------------------------------------------------------------------
// The read window's continuation cursor is reachable without a guard (T1.3)
// ---------------------------------------------------------------------------

type ContinuingWindow = Extract<TimelineReadResponse, { hasMore: true }>;
type TerminalWindow = Extract<TimelineReadResponse, { hasMore: false }>;

/** On the continuing arm the cursor is REQUIRED, not optional. */
type _ContinuingWindowRequiresCursor = AssertExtends<
  RequiredKeys<ContinuingWindow>,
  "entries" | "hasMore" | "nextCursor"
>;

/**
 * On the terminal arm it is OPTIONAL — present as a key, never required.
 *
 * Both halves are load-bearing and neither implies the other. The key must
 * exist, because a final page is exactly where a client switches to
 * `timeline.subscribe` and needs the position it stopped at. It must not be
 * required, because a producer that has nothing more to say is not obliged to
 * mint one.
 */
type _TerminalWindowAllowsCursor = AssertExtends<keyof TerminalWindow, "nextCursor">;
type _TerminalWindowCursorIsOptional = AssertNever<
  Extract<RequiredKeys<TerminalWindow>, "nextCursor">
>;

/**
 * The consumer this shape exists for. A client paginating the timeline reaches
 * `nextCursor` after narrowing on `hasMore` alone — no non-null assertion, no
 * optional chain, and no runtime check for a member the contract already
 * guarantees. Under the previous `nextCursor?:` shape this function could not
 * be written without one of those three.
 */
export function nextPageCursorOf(window: TimelineReadResponse): EventCursor | null {
  return window.hasMore ? window.nextCursor : null;
}

// ---------------------------------------------------------------------------
// The other two paged replies split on `hasMore` the same way
// ---------------------------------------------------------------------------

type ContinuingExpansion = Extract<ChildRunExpandResponse, { hasMore: true }>;
type ContinuingReasoning = Extract<
  ReasoningSurfaceReadResponse,
  { availability: "available"; hasMore: true }
>;

/**
 * The expansion's continuing arm requires its cursor, and keeps every member a
 * terminal expansion carries — the continuation is additive to the shape, not
 * a different reply.
 */
type _ContinuingExpansionRequiresCursor = AssertExtends<
  RequiredKeys<ContinuingExpansion>,
  "runId" | "parentRunId" | "state" | "entries" | "hasMore" | "nextCursor"
>;

/** Same rule on the one reasoning state that carries entries. */
type _ContinuingReasoningRequiresCursor = AssertExtends<
  RequiredKeys<ContinuingReasoning>,
  "availability" | "reasoningEntries" | "hasMore" | "nextCursor"
>;

/**
 * The three non-`available` reasoning states carry no continuation at all —
 * `hasMore` on a state that returns no entries would be a promise of more of
 * nothing. Structurally absent rather than optional-and-always-missing.
 */
type _UnpagedReasoningStatesHaveNoContinuation = AssertNever<
  Extract<
    keyof Extract<ReasoningSurfaceReadResponse, { availability: "unavailable" | "compacted" }>,
    "hasMore" | "nextCursor" | "reasoningEntries"
  >
>;

/**
 * The consumer both shapes exist for, written once against the whole
 * namespace: whichever paged reply arrives, the cursor is reached by narrowing
 * on `hasMore` and nothing else.
 */
export function nextExpansionCursorOf(expansion: ChildRunExpandResponse): EventCursor | null {
  return expansion.hasMore ? expansion.nextCursor : null;
}

// ---------------------------------------------------------------------------
// The incompleteness marker narrows the same way (T1.2, I-013-10)
// ---------------------------------------------------------------------------

type CompleteArm = Extract<ChildRunCompleteness, { state: "complete" }>;
type IncompleteArm = Extract<ChildRunCompleteness, { state: "incomplete" }>;

/** `cause` and `observedAt` are required — on the incomplete arm only. */
type _IncompleteArmRequiresBoth = AssertExtends<
  RequiredKeys<IncompleteArm>,
  "state" | "cause" | "observedAt"
>;

/**
 * And the complete arm carries NEITHER, structurally. This is the half a
 * `cause?: ChildRunIncompleteCause` optional would have lost: with an
 * optional, a `complete` row could still be handed a cause and typecheck.
 */
type _CompleteArmHasNoCause = AssertNever<Extract<keyof CompleteArm, "cause" | "observedAt">>;

/**
 * A consumer reaches the cause only after narrowing, so there is no arm on
 * which `cause` is `undefined` to guard against.
 */
export function retryabilityOf(summary: ChildRunSummary): "n/a" | "retryable" | "terminal" {
  if (summary.completeness.state === "complete") {
    return "n/a";
  }
  switch (summary.completeness.cause) {
    case "detail_fetch_failed":
    case "pending_backfill":
      return "retryable";
    case "compacted":
      // Terminal: no retry recovers a compacted row.
      return "terminal";
    default: {
      // Exhaustiveness: a fourth cause added without a case here fails to compile.
      const unreachable: never = summary.completeness.cause;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// The narrowing itself, exercised the way a renderer does it
// ---------------------------------------------------------------------------

/**
 * A worked consumer. The point is what is NOT here: no cast, no optional
 * chaining onto the attribution triple, and no read of the free-form `type`.
 * If `kind` ever stopped discriminating, this function stops compiling.
 */
export function isSupersededAgainstCutoff(row: TimelineRow, rewindCutoff: number): boolean {
  switch (row.kind) {
    case "run":
      return row.position > rewindCutoff;
    case "rollback_boundary":
      // Reached through the narrowed payload, never through a cast.
      return row.position > row.payload.targetPosition;
    case "legacy_stub":
      // Exempt by construction: the row has no ordinal to rank.
      return false;
    case "general":
      return false;
    default: {
      // Exhaustiveness: a fifth arm added without a case here fails to compile.
      const unreachable: never = row;
      return unreachable;
    }
  }
}
