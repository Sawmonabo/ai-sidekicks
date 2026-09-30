// The console's run and phase rows, derived from the substrate's wire declaration
// (`services/wire-shapes/workflow-projection.ts`) rather than mirrored, so a mirrored shape cannot
// go stale. Each row is a `Pick` chosen by a disposition map that is total over the wire shape's
// members: a member added on the substrate fails to compile here until this file says what
// becomes of it.

import type {
  WorkflowPhaseState,
  WorkflowRunSnapshot as WorkflowWireRunSnapshot,
} from "@renderer/services/wire-shapes/workflow-projection.js";
import { parseInstant, type InstantReading } from "@renderer/lib/instant.js";

/** One run status, read off the substrate's own declaration. Never restated. */
export type WorkflowRunState = WorkflowWireRunSnapshot["state"];

/**
 * One park reason, read off the substrate's own declaration. `NonNullable` because the wire
 * member is optional; the badge that names each reason is total over this set.
 */
export type WorkflowParkReason = NonNullable<WorkflowPhaseState["parkReason"]>;

/**
 * A park, as a value that exists only when there is one. The wire carries four independent
 * optional members; narrowing once here keeps components from re-deriving the discriminator,
 * and from picking `parkCause` (present whenever `parkReason` is) instead.
 */
export interface WorkflowPhasePark {
  readonly parkReason: WorkflowParkReason;
  /** The engine's own bounded sentence about the wait. Rendered verbatim. */
  readonly parkCause: string;
  /**
   * RFC 3339 UTC. Present only where the park armed a schedule. `| undefined` because this
   * shape is constructed from wire members, and under `exactOptionalPropertyTypes` an absent key
   * and a key holding `undefined` are different types.
   */
  readonly autoResumeAt?: string | undefined;
  /** The provider-account key concurrently parked phases fold by. */
  readonly parkAttentionKey?: string | undefined;
}

/** One phase's projected state, with the park members exactly as the wire carries them. */
export type WorkflowPhaseStateRow = ProjectedFrom<
  WorkflowPhaseState,
  WirePhaseMemberDispositions
> & {
  /**
   * The phase's own name, where anything carries one. Added, not picked: no registered read
   * carries it, and a required name would force a caller to invent one. Without it the row shows
   * the id as the wire value it is.
   */
  readonly phaseName?: string;
};

/**
 * One run, as the console holds it: the wire's run header, this console's phase rows,
 * and the two facts a caller joins in from beside the run read.
 */
export type WorkflowRunSnapshot = ProjectedFrom<
  WorkflowWireRunSnapshot,
  WireRunMemberDispositions
> & {
  readonly phaseStates: readonly WorkflowPhaseStateRow[];
  /**
   * The definition's name, where the caller holds one. Optional here though required on the
   * enumeration entry, because this row is also built from a single run read, which names no
   * definition; the row then shows the run's own id.
   */
  readonly definitionName?: string;
  /**
   * The definition's newest version id, when the caller holds it. Absent means the frozen-pin
   * state is unknown and the projection reports `false`: calling a run current is a smaller
   * error than inviting a repair the daemon would refuse.
   */
  readonly definitionLatestWorkflowVersionId?: string;
};

/** A parked phase, paired with the park that made it one and what that park says. */
export interface WorkflowParkedPhase {
  readonly phaseId: string;
  /** `| undefined` for the reason stated on `WorkflowPhasePark.autoResumeAt`. */
  readonly phaseName?: string | undefined;
  readonly park: WorkflowPhasePark;
  /**
   * What this park says about the end of the wait, classified once. Not derivable from
   * `autoResumeAt === undefined`: a present instant no parser accepts is unscheduled too.
   */
  readonly schedule: WorkflowParkSchedule;
}

/**
 * What a park says about when, if ever, the engine picks the phase back up. Three arms, because
 * they draw differently: `armed` resumes itself; `unscheduled` waits for a person; `unreadable`
 * also waits for a person (fail closed) but is kept apart as the only evidence of a malformed
 * instant.
 */
export type WorkflowParkSchedule =
  /**
   * The wire's instant, verbatim, on the arm the reading admitted it to. No parsed milliseconds
   * ride beside it: nothing compares two resumes.
   */
  | { readonly kind: "armed"; readonly autoResumeAt: string }
  | { readonly kind: "unscheduled" }
  | { readonly kind: "unreadable"; readonly autoResumeAt: string };

/**
 * Read one of the workflow projection's instants: RFC 3339 in UTC and nothing wider. The wire
 * declares one encoding, so a producer's encoding change should arrive as the unreadable value it
 * is, not be read quietly. Uses `lib/instant.ts`, which validates the calendar and clock (month
 * 13, `2027-02-29`, hour 24 are refused; `Date.parse` would normalize them into another day) and
 * refuses a zoneless or date-only spelling. Returns the reading, not a number, and no numeric
 * sentinel: an unreadable start must sort last in both directions, which `compareInstants` does.
 * Exported so the park classification and the run sort share one rule.
 */
export function workflowInstant(iso: string): InstantReading {
  return parseInstant(iso, "utc-only");
}

/**
 * Whether this park is waiting on a person: everything but `armed`. An unreadable boundary fails
 * closed, since nothing legible says the run resumes itself. One function so the park badge and
 * the phase node spend amber on the same answer.
 */
export function parkAwaitsPerson(schedule: WorkflowParkSchedule): boolean {
  return schedule.kind !== "armed";
}

/** How one park's armed boundary reads. The one place the classification is made. */
export function parkSchedule(park: WorkflowPhasePark): WorkflowParkSchedule {
  const armed = park.autoResumeAt;
  if (armed === undefined) {
    return { kind: "unscheduled" };
  }
  return workflowInstant(armed).kind === "malformed"
    ? { kind: "unreadable", autoResumeAt: armed }
    : { kind: "armed", autoResumeAt: armed };
}

/**
 * The park a phase carries, or nothing. The one place the discriminator is written: `parkReason`
 * present means parked now. A reason without a cause is a malformed response and yields nothing,
 * not a park with an empty sentence.
 */
export function phasePark(phase: WorkflowPhaseStateRow): WorkflowPhasePark | undefined {
  if (phase.parkReason === undefined || phase.parkCause === undefined) {
    return undefined;
  }
  return {
    parkReason: phase.parkReason,
    parkCause: phase.parkCause,
    autoResumeAt: phase.autoResumeAt,
    parkAttentionKey: phase.parkAttentionKey,
  };
}

/**
 * What this console does with one member of a wire shape: carry it through, replace it with a
 * shape of its own, or deliberately not consume it. Naming the third keeps a dropped member from
 * reading like one nobody noticed.
 */
type WireMemberDisposition = "projected" | "replaced" | "dropped";

/**
 * The members of a wire shape a row carries through unchanged, chosen by a total disposition
 * map: `Dispositions extends Record<keyof WireShape, ...>` fails at the use site, naming the
 * missing key, when a substrate member is not dispositioned. The maps are types, not `as const`
 * values, because `--isolatedDeclarations` would refuse the annotation-free literal. `-?` is
 * needed because a homomorphic map over optional members yields `Member | undefined`, which
 * `Pick` refuses.
 */
type ProjectedFrom<
  WireShape,
  Dispositions extends Readonly<Record<keyof WireShape, WireMemberDisposition>>,
> = Pick<
  WireShape,
  {
    [Member in keyof WireShape]-?: Dispositions[Member] extends "projected" ? Member : never;
  }[keyof WireShape]
>;

/**
 * What a list row does with each member of the wire's phase projection. The six dropped members
 * are the run pane's subject; a row says whether a phase is parked and never opens it.
 */
type WirePhaseMemberDispositions = {
  readonly phaseId: "projected";
  readonly phaseRunId: "dropped";
  readonly attemptNumber: "dropped";
  readonly state: "projected";
  readonly gateState: "dropped";
  readonly formRevision: "dropped";
  readonly prompt: "dropped";
  readonly inputSchema: "dropped";
  readonly parkReason: "projected";
  readonly parkCause: "projected";
  readonly autoResumeAt: "projected";
  readonly parkAttentionKey: "projected";
};

/**
 * What a list row does with each member of the wire's run shape. `sessionId` is dropped because
 * a list renders inside one session; `phaseStates` is replaced by the console's phase rows.
 */
type WireRunMemberDispositions = {
  readonly workflowRunId: "projected";
  readonly sessionId: "dropped";
  readonly workflowVersionId: "projected";
  readonly state: "projected";
  readonly phaseStates: "replaced";
  readonly failureReason: "projected";
  readonly startedAt: "projected";
  readonly endedAt: "projected";
};
