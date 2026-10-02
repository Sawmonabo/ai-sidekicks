// Compile-time tests of the `TimelineRow` narrowing the renderer relies on: it narrows on
// `row.kind`, never on the free-form `type`, and reads the arm's members without a re-check.
// A failing claim shows up as TS2344 in the package typecheck.

import type { RunRolledBackEvent } from "./run-control.js";
import type { TimelineRow } from "./timeline/row.js";

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

// Claim 3: the general arm carries no attribution member

type _GeneralArmHasNoAttribution = AssertNever<
  Extract<keyof GeneralArm, "runId" | "position" | "epoch" | "superseded">
>;
