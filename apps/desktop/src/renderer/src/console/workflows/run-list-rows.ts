// The console's run and phase rows, DERIVED from the substrate's wire declaration
// rather than written a second time beside it.
//
// `bridge/workflow-projection.ts` declares the workflow plane's read shapes and the
// closed vocabularies inside them. This module is the one place the console narrows
// those shapes for a list: it drops what a row does not show, replaces the phase
// collection with its own row type, and adds the two members a caller joins in from
// beside the run read. It declares no status, no park reason, and no second snapshot.
//
// WHY DERIVATION AND NOT A MIRROR. A mirrored shape agrees with its original until
// the original moves, and then it compiles anyway — which is exactly how a list comes
// to read a stale vocabulary through a growth port that already carries a wider one.
// Every row below is a `Pick` chosen by a disposition map that is TOTAL over the wire
// shape's members, so a member added on the substrate fails to compile here until
// this file says what becomes of it.
//
// WIRE STATUS. `packages/contracts` registers no `workflow.*` method, no `workflow.*`
// event type, and none of these shapes; the substrate declaration this module derives
// from is itself the console's consumption shape, on the same footing as the growth
// port's own signature table. It is fixture-fed until the
// `workflow-event-registration` slate row lands, and a caller wiring these rows to a
// live bridge before then is a review rejection.

import type {
  WorkflowPhaseState,
  WorkflowRunSnapshot as WorkflowWireRunSnapshot,
} from "../bridge/index.js";

/**
 * What this console does with one member of a wire shape.
 *
 * Three answers and no fourth: carried through unchanged, replaced by a shape of the
 * console's own, or deliberately not consumed. Naming the third is the point — a
 * member simply left out of a `Pick` reads exactly like one nobody noticed.
 */
type WireMemberDisposition = "projected" | "replaced" | "dropped";

/**
 * The members of a wire shape a row carries through unchanged, chosen by a TOTAL
 * disposition map.
 *
 * The CONSTRAINT is the compile-time control: `Dispositions extends
 * Record<keyof WireShape, …>` fails at the use site, naming the missing key, the
 * moment a member is added on the substrate and not dispositioned here. The maps are
 * TYPES rather than `as const` values for two reasons that point the same way — a
 * value read only as a type is dead weight at runtime and the lint rules say so, and
 * `--isolatedDeclarations` refuses to emit a `satisfies`-narrowed variable without an
 * annotation that would widen away the literal types this `Pick` reads.
 *
 * `-?` on the mapped type is load-bearing rather than decorative — a homomorphic map
 * over a shape with optional members yields `Member | undefined` at those keys, and
 * `Pick` refuses a key set that admits `undefined`.
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

/** One run status, read off the substrate's own declaration. Never restated. */
export type WorkflowRunState = WorkflowWireRunSnapshot["state"];

/**
 * One park reason, read off the substrate's own declaration.
 *
 * `NonNullable` rather than a second tuple: the member is live-scoped and therefore
 * optional on the wire, while what a park CARRIES once there is one is the reason
 * itself. Exported because the badge that names each reason on screen is total over
 * this set, which is what makes a third reason a compile error rather than a phase
 * that parks and says nothing.
 */
export type WorkflowParkReason = NonNullable<WorkflowPhaseState["parkReason"]>;

/**
 * A park, as a value that exists only when there IS one.
 *
 * The wire carries four independent optional members; this carries a park or
 * nothing. The difference matters at every call site downstream: a renderer handed
 * four optionals has to re-derive "is this parked" from the right one of them, and
 * the wrong one is `parkCause`, which is present whenever `parkReason` is and
 * therefore looks like it would do. Narrowing once here means no surface repeats
 * the discriminator rule, and no surface gets it wrong.
 */
export interface WorkflowPhasePark {
  readonly parkReason: WorkflowParkReason;
  /** The engine's own bounded sentence about the wait. Rendered verbatim. */
  readonly parkCause: string;
  /**
   * RFC 3339 UTC. Present only where the park armed a schedule.
   *
   * Spelled `| undefined` rather than merely optional because this shape is
   * CONSTRUCTED from four wire members rather than written as a literal, and under
   * `exactOptionalPropertyTypes` "the key is absent" and "the key holds undefined"
   * are different types. The wire rows keep the plain optional form, since a caller
   * omits those keys outright.
   */
  readonly autoResumeAt?: string | undefined;
  /** The provider-account key concurrently parked phases fold by. */
  readonly parkAttentionKey?: string | undefined;
}

/**
 * What a list row does with each member of the wire's phase projection.
 *
 * The four dropped members go on one rule: a row says whether a phase is parked and
 * never opens the phase. `phaseRunId` and `attemptNumber` address one execution of
 * it, `formRevision` is the token a form submit carries back, and `gateState` is the
 * phase's own gate — all four are the run pane's subject, and a list that read one
 * would be growing into the view that owns the question.
 */
type WirePhaseMemberDispositions = {
  readonly phaseId: "projected";
  readonly phaseRunId: "dropped";
  readonly attemptNumber: "dropped";
  readonly state: "projected";
  readonly gateState: "dropped";
  readonly formRevision: "dropped";
  readonly parkReason: "projected";
  readonly parkCause: "projected";
  readonly autoResumeAt: "projected";
  readonly parkAttentionKey: "projected";
};

/** One phase's projected state, with the park members exactly as the wire carries them. */
export type WorkflowPhaseStateRow = ProjectedFrom<
  WorkflowPhaseState,
  WirePhaseMemberDispositions
> & {
  /**
   * The phase's own name, for a park a person has to act on — where anything
   * carries one.
   *
   * Added rather than picked, because no registered read carries it. The run read
   * projects phases by `phaseId` and nothing else names them, so a row built from
   * the wire has an opaque identity and no label; a projection that required a name
   * would force its caller to invent one, and an invented phase name is
   * indistinguishable on screen from an authored one. A surface without it shows the
   * id as the wire value it is.
   */
  readonly phaseName?: string;
};

/**
 * What a list row does with each member of the wire's run shape.
 *
 * `sessionId` is dropped because a list is rendered inside one session's context and
 * a row carrying its own would invite a list holding two. `phaseStates` is REPLACED
 * rather than projected: the phase rows above are this console's narrowing, and a
 * snapshot carrying both collections would leave every caller to pick one.
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
   * The definition's name, so a run row reads as something other than an id —
   * where the caller holds one.
   *
   * Optional HERE while it is required on the enumeration's own entry
   * (`bridge/workflow-projection.ts`), because this row is also built from a single
   * run read, which carries the pinned `workflowVersionId` and nothing about the
   * definition. A caller holding an enumeration entry passes it through; one holding
   * only a run passes nothing and the row shows the run's own identity rather than a
   * name nobody sent.
   */
  readonly definitionName?: string;
  /**
   * The definition's newest version id, when the caller holds it.
   *
   * Optional for the reason above, and additive-optional on the enumeration entry
   * itself. Absent, the frozen-pin state is UNKNOWN and the projection reports
   * `false` rather than guessing, which is the fail-closed direction: claiming a run
   * is current is a smaller error than claiming it is stale and inviting a repair the
   * daemon would refuse.
   */
  readonly definitionLatestWorkflowVersionId?: string;
};

/** A parked phase, paired with the park that made it one and what that park says. */
export interface WorkflowParkedPhase {
  readonly phaseId: string;
  /**
   * Spelled `| undefined` rather than merely optional, on this file's own stated
   * rule: the shape is CONSTRUCTED from a row rather than written as a literal, and
   * under `exactOptionalPropertyTypes` an absent key and a key holding `undefined`
   * are different types.
   */
  readonly phaseName?: string | undefined;
  readonly park: WorkflowPhasePark;
  /**
   * What this park says about the end of the wait, classified once.
   *
   * Beside the park rather than derived from it at each reader, because the
   * classification is not `autoResumeAt === undefined`: a present instant that no
   * parser accepts is unscheduled too, and a surface that re-derived from presence
   * alone rendered a park as scheduled and then had no time to show for it.
   */
  readonly schedule: WorkflowParkSchedule;
}

/**
 * An instant in milliseconds, or nothing when the string does not parse.
 *
 * Deliberately NOT a numeric sentinel. The list's two orderings read an instant in
 * opposite directions — runs sort descending and armed resumes pick ascending — so a
 * floor that sends an unreadable value last in one sends it first in the other. Each
 * caller states its own rule against this `undefined` instead.
 *
 * Exported because the park classification below and the run sort next door are the
 * only two readers of a wire instant in this family, and two parsers would be two
 * answers to "is this readable".
 */
export function instantMilliseconds(iso: string): number | undefined {
  const milliseconds = Date.parse(iso);
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

/**
 * What a park says about when, if ever, the engine picks the phase back up.
 *
 * Three arms and no boolean, because the three are three different things to draw. A
 * park that armed a readable boundary resumes itself and asks nobody for anything. A
 * park that armed nothing waits for a person. And a park that armed an instant this
 * console cannot read waits for a person too — the fail-closed reading of "we cannot
 * tell when this resumes" — but it is not the same fact, and a surface that folded it
 * into the second would drop the only evidence a daemon sent something malformed.
 */
export type WorkflowParkSchedule =
  /**
   * The wire's instant, and the reading of it that made this arm the armed one.
   *
   * The parsed milliseconds ride the arm because the classification already had to
   * parse to reach it, and the earliest-resume pick next door would otherwise parse
   * the same string a second time to compare it — two parses of one value, which is
   * the shape that eventually disagrees with itself.
   */
  | { readonly kind: "armed"; readonly autoResumeAt: string; readonly atMilliseconds: number }
  | { readonly kind: "unscheduled" }
  | { readonly kind: "unreadable"; readonly autoResumeAt: string };

/** How one park's armed boundary reads. The one place the classification is made. */
export function parkSchedule(park: WorkflowPhasePark): WorkflowParkSchedule {
  const armed = park.autoResumeAt;
  if (armed === undefined) {
    return { kind: "unscheduled" };
  }
  const atMilliseconds = instantMilliseconds(armed);
  return atMilliseconds === undefined
    ? { kind: "unreadable", autoResumeAt: armed }
    : { kind: "armed", autoResumeAt: armed, atMilliseconds };
}

/**
 * The park a phase carries, or nothing.
 *
 * The one place the discriminator rule is written. `parkReason` present means parked
 * now; `parkCause` accompanies it by the producer's own requirement, so a reason
 * without a cause is a malformed response rather than a park with no explanation —
 * and this returns nothing for it rather than rendering a park with an empty
 * sentence, which would read as an engine that had no reason.
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
