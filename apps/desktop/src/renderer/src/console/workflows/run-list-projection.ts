// The run list's projection: what a set of run snapshots reads as, before anything
// renders one.
//
// A run list has to answer three questions that no single wire field answers, and
// answering them in a component would answer them once per render and differently
// per surface. So they are answered here, once, as a value:
//
//   1. **Is anything parked, and why?** Not from the phase's `state`. The phase-run
//      status union carries no suspended arm — that is deliberate
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
// THE SHAPES ARE NEXT DOOR AND THE VOCABULARY IS ON THE SUBSTRATE. `run-list-rows.ts`
// derives the run and phase rows from `bridge/workflow-projection.ts`, which is where
// the statuses and park reasons are declared; this module holds the reading — bands,
// order, and the counts a header shows — and declares exactly one closed set of its
// own, the attention band, because a band is a reading of a status rather than a
// status. The four row symbols below are re-exported because their readers — the park
// badge and the run pane — read a run ROW through the module that projects a run
// LIST, and a second import edge into the family for the same fact is the thing that
// drifts.

import {
  phasePark,
  type WorkflowParkedPhase,
  type WorkflowRunSnapshot,
  type WorkflowRunState,
} from "./run-list-rows.js";

export { phasePark } from "./run-list-rows.js";
export type {
  WorkflowParkReason,
  WorkflowPhasePark,
  WorkflowRunSnapshot,
} from "./run-list-rows.js";

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

/**
 * The band each run status reads as, before its parks are looked at.
 *
 * TOTAL over the substrate's status set, and that totality is this module's own
 * compile-time control: a seventh status added to `bridge/workflow-projection.ts`
 * fails here until this table places it, where the `pending || running ? … : …`
 * expression it replaces would have banded it `settled` in silence and hidden a live
 * run under the finished ones.
 *
 * `suspended` bands `parked` on its own, with no phase carrying park members: an
 * older daemon emits none of the four, and the run status still says something is
 * waiting.
 */
const RUN_STATE_ATTENTION_BANDS = {
  pending: "active",
  running: "active",
  suspended: "parked",
  completed: "settled",
  failed: "settled",
  cancelled: "settled",
} as const satisfies Record<WorkflowRunState, WorkflowRunAttentionBand>;

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
  return parkedPhases.length > 0 ? "parked" : RUN_STATE_ATTENTION_BANDS[run.state];
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
