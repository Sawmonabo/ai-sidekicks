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

import type { RunRolledBackEvent } from "./runControl.js";
import type { TimelineRow } from "./timeline/index.js";

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

// ---------------------------------------------------------------------------
// Claim 4 — the general arm carries no attribution member
// ---------------------------------------------------------------------------

type _GeneralArmHasNoAttribution = AssertNever<
  Extract<keyof GeneralArm, "runId" | "position" | "epoch" | "superseded">
>;

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
