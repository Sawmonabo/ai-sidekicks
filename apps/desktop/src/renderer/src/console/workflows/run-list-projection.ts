// The run list's projection: what a set of run snapshots reads as, before anything
// renders one.
//
// A run list has to answer three questions that no single wire field answers, and
// answering them in a component would answer them once per render and differently
// per surface. So they are answered here, once, as a value:
//
//   1. **Is anything parked, and why?** Not from the phase's `state`. The phase-run
//      status union is FIVE values and carries no suspended arm — that is deliberate
//      (`Spec-017 §Park surfacing on the read model (SA-44)`), and the park instead
//      rides four additive-optional members that a daemon emits for exactly those
//      phases parked when the response was built. So `parkReason` PRESENCE is the
//      wire's park discriminator, and a projection that read `state` would report a
//      phase that already resumed as still waiting.
//   2. **Which parks resume themselves and which need a person?** `autoResumeAt` is
//      armed only where a provider reported a reset boundary; its absence narrows
//      the park to the unscheduled, operator-resumable kind rather than denying it.
//   3. **Is this run pinned to a version its definition has moved past?** That is
//      the frozen-definition state — the condition an operator repairs on resume
//      (`Spec-017 §Frozen-definition repair (SA-41)`). It is an INEQUALITY between
//      two opaque ids the caller passes through verbatim, never a parse of either,
//      and it is unknown rather than false when the caller holds no latest.
//
// WHAT THIS MODULE IS NOT. It is not eligibility. Nothing here decides whether a run
// may be cancelled, resumed, or re-pinned — those are daemon adjudications reaching
// the console as typed refusals (`workflow.control_denied`,
// `workflow.run_not_cancellable`, `workflow.resume_not_parked`, and the three
// `workflow.repair_*` codes), and a renderer that predicted one would be a second
// authority on a question the daemon owns. What it computes is what the operator can
// SEE: a park, its shape, and a pin that has fallen behind.
//
// WIRE STATUS — READ THIS BEFORE ADDING A CALLER. `packages/contracts` registers no
// `workflow.*` method, no `workflow.*` event type, and none of these shapes; the
// wire registry carries thirteen workflow operations and none of them enumerates
// runs. The types below are therefore the CONSOLE's consumption shapes, mirroring
// the `PhaseState` and `WorkflowRunReadResponse` declarations in
// `docs/architecture/contracts/api-payload-contracts.md`, on the same footing as the
// growth port's own signature table: what a surface needs, not a claim about a wire.
// They are fixture-fed until the `workflow-event-registration` slate row lands, and
// a caller wiring them to a live bridge before then is a review rejection.

/**
 * The five phase-run statuses, and exactly five.
 *
 * The tuple is the declaration and the union derives from it, so widening the set
 * is one edit a reviewer sees rather than two that agree until they do not. This
 * particular set is load-bearing beyond the usual reason: `Spec-017` keeps it at
 * five ON PURPOSE and routes the park around it, so a sixth arm added here would
 * silently undo the producer rule the park's whole readability rests on.
 */
export const WORKFLOW_PHASE_RUN_STATES = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;

/** One phase-run status. Derived from the tuple, never restated. */
export type WorkflowPhaseRunState = (typeof WORKFLOW_PHASE_RUN_STATES)[number];

/** The six run statuses, in the order the contract declares them. */
export const WORKFLOW_RUN_STATES = [
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
] as const;

/** One run status. Derived from the tuple, never restated. */
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

/** The two park reasons V1 defines. Widening is an amendment, never a comment. */
export const WORKFLOW_PARK_REASONS = ["waiting-human", "provider-usage-limited"] as const;

/** One park reason. Derived from the tuple, never restated. */
export type WorkflowParkReason = (typeof WORKFLOW_PARK_REASONS)[number];

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
   * are different types. The wire rows below keep the plain optional form, since a
   * caller omits those keys outright.
   */
  readonly autoResumeAt?: string | undefined;
  /** The provider-account key concurrently parked phases fold by. */
  readonly parkAttentionKey?: string | undefined;
}

/** One phase's projected state, with the park members exactly as the wire carries them. */
export interface WorkflowPhaseStateRow {
  readonly phaseId: string;
  /** The phase's own name, for a park a person has to act on. */
  readonly phaseName: string;
  readonly state: WorkflowPhaseRunState;
  readonly parkReason?: WorkflowParkReason;
  readonly parkCause?: string;
  readonly autoResumeAt?: string;
  readonly parkAttentionKey?: string;
}

/** One run, as the console holds it: the run header plus its phase projection. */
export interface WorkflowRunSnapshot {
  readonly workflowRunId: string;
  readonly state: WorkflowRunState;
  /** The immutable version this run is pinned to. Opaque; passed through, never parsed. */
  readonly workflowVersionId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Also the cancellation reason on a `cancelled` run, per the contract's own split. */
  readonly failureReason?: string;
  readonly phaseStates: readonly WorkflowPhaseStateRow[];
  /** The definition's name, so a run row reads as something other than an id. */
  readonly definitionName: string;
  /**
   * The definition's newest version id, when the caller holds it.
   *
   * Optional because a run read alone does not carry it — it comes from the
   * definition enumeration beside it. Absent, the frozen-pin state is UNKNOWN and
   * the projection reports `false` rather than guessing, which is the fail-closed
   * direction: claiming a run is current is a smaller error than claiming it is
   * stale and inviting a repair the daemon would refuse.
   */
  readonly definitionLatestWorkflowVersionId?: string;
}

/** A parked phase, paired with the park that made it one. */
export interface WorkflowParkedPhase {
  readonly phaseId: string;
  readonly phaseName: string;
  readonly park: WorkflowPhasePark;
}

/**
 * The three bands a run sits in, in the order the list shows them.
 *
 * A band is about ATTENTION, not about status: `parked` is where a person may be
 * needed, `active` is where the engine is working, `settled` is where nothing more
 * will happen. Ordering by the six-value status directly would put `pending` above
 * `suspended` because the contract declares it first, which is a fact about the DDL
 * and not about what an operator should look at.
 */
export const WORKFLOW_RUN_ATTENTION_BANDS = ["parked", "active", "settled"] as const;

/** One attention band. Derived from the tuple, never restated. */
export type WorkflowRunAttentionBand = (typeof WORKFLOW_RUN_ATTENTION_BANDS)[number];

/** One run's row in the list: the snapshot, plus everything read off it once. */
export interface WorkflowRunListRow {
  readonly run: WorkflowRunSnapshot;
  /** Every phase parked at the moment the snapshot was built. Empty when none is. */
  readonly parkedPhases: readonly WorkflowParkedPhase[];
  /**
   * The soonest armed resume across this run's parks, verbatim as the wire sent it.
   *
   * `undefined` when no park armed one — which is the operator-resumable case, not
   * the not-parked case. `parkedPhases` says which of the two.
   */
  readonly earliestAutoResumeAt: string | undefined;
  /** True when at least one park armed no schedule and so waits on a person. */
  readonly hasUnscheduledPark: boolean;
  /**
   * True when the run's pinned version is not the definition's newest.
   *
   * An inequality between two opaque ids. False when the caller supplied no latest,
   * because unknown is not stale.
   */
  readonly isPinnedBehindLatestVersion: boolean;
  readonly attentionBand: WorkflowRunAttentionBand;
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

/** Sorts an unparseable instant last rather than poisoning the comparison with `NaN`. */
function instantOrder(iso: string): number {
  const milliseconds = Date.parse(iso);
  return Number.isNaN(milliseconds) ? Number.NEGATIVE_INFINITY : milliseconds;
}

/** The band a run belongs to, decided by its parks first and its status second. */
function attentionBandFor(
  run: WorkflowRunSnapshot,
  parkedPhases: readonly WorkflowParkedPhase[],
): WorkflowRunAttentionBand {
  if (parkedPhases.length > 0 || run.state === "suspended") {
    return "parked";
  }
  return run.state === "pending" || run.state === "running" ? "active" : "settled";
}

/** The soonest armed resume among a run's parks, or nothing when none armed one. */
function earliestArmedResume(parkedPhases: readonly WorkflowParkedPhase[]): string | undefined {
  let earliest: string | undefined;
  for (const parked of parkedPhases) {
    const armed = parked.park.autoResumeAt;
    if (armed === undefined) {
      continue;
    }
    if (earliest === undefined || instantOrder(armed) < instantOrder(earliest)) {
      earliest = armed;
    }
  }
  return earliest;
}

/** One run's row, with every derived fact read off the snapshot exactly once. */
function projectRun(run: WorkflowRunSnapshot): WorkflowRunListRow {
  const parkedPhases: WorkflowParkedPhase[] = [];
  for (const phase of run.phaseStates) {
    const park = phasePark(phase);
    if (park !== undefined) {
      parkedPhases.push({ phaseId: phase.phaseId, phaseName: phase.phaseName, park });
    }
  }
  return {
    run,
    parkedPhases,
    earliestAutoResumeAt: earliestArmedResume(parkedPhases),
    hasUnscheduledPark: parkedPhases.some((parked) => parked.park.autoResumeAt === undefined),
    isPinnedBehindLatestVersion:
      run.definitionLatestWorkflowVersionId !== undefined &&
      run.definitionLatestWorkflowVersionId !== run.workflowVersionId,
    attentionBand: attentionBandFor(run, parkedPhases),
  };
}

/**
 * The run list, projected once from the snapshots a caller holds.
 *
 * A class rather than a function because the rows and the counts read off them are
 * one computation with two consumers — a list body and its header — and computing
 * them separately is how a header comes to disagree with the list under it. The
 * projection is performed in the constructor and the instance is immutable, so a
 * caller memoizes the INSTANCE against its input and every read after that is free.
 *
 * It holds no subscription, no timer, and no store. A run list that refreshed itself
 * would be a second scheduler beside `store/scheduling.ts`; this projects what it is
 * given and nothing more.
 */
export class RunListProjection {
  readonly #rows: readonly WorkflowRunListRow[];

  public constructor(runs: readonly WorkflowRunSnapshot[]) {
    this.#rows = runs
      .map((run) => projectRun(run))
      .sort((left, right) => {
        const bandDelta =
          WORKFLOW_RUN_ATTENTION_BANDS.indexOf(left.attentionBand) -
          WORKFLOW_RUN_ATTENTION_BANDS.indexOf(right.attentionBand);
        // Newest first inside a band: a run started a minute ago is the one an
        // operator scanning a band is looking for, and a stable secondary key keeps
        // two runs from swapping places between renders.
        return bandDelta !== 0
          ? bandDelta
          : instantOrder(right.run.startedAt) - instantOrder(left.run.startedAt);
      });
  }

  /** Every row, attention first and newest first inside a band. */
  public get rows(): readonly WorkflowRunListRow[] {
    return this.#rows;
  }

  /** How many runs hold at least one parked phase. The list header's own reading. */
  public get parkedRunCount(): number {
    return this.#rows.filter((row) => row.parkedPhases.length > 0).length;
  }

  /** How many runs are pinned to a version their definition has moved past. */
  public get frozenPinCount(): number {
    return this.#rows.filter((row) => row.isPinnedBehindLatestVersion).length;
  }
}
