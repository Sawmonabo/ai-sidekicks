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
// ONE COMPARISON, AND NO SENTINEL UNDER IT. The sort below reads an RFC 3339 string a
// daemon sent and has to say what an UNPARSEABLE one means. It is DESCENDING and hands
// its readings to `compareInstants`, which puts an unreadable start LAST in both
// directions: a numeric floor cannot, because the value that sorts last ascending
// sorts first descending, and two floors subtract to `NaN`, which a comparator may
// answer and `Array.prototype.sort` may read as anything it likes.
//
// ONE PARSE OF THE START, AND EVERY READER TAKES IT. The reading rides the row, so the
// sort and the surface that PRINTS the start are looking at the same value. They were
// not: the row printed `run.startedAt` through the figure chokepoint's `formatDateTime`,
// which reads an instant under the default `"any-offset"` policy, while the sort read
// it under this plane's declared `"utc-only"` one. A start spelled with a numeric
// offset is legible to the first and malformed to the second, so the list sorted such a
// run last — under every run whose start it could read — and then printed a perfectly
// readable time on it, with nothing on screen saying its stamp had been refused.
//
// AND THE SORT ENDS ON THE RUN'S OWN IDENTITY. Band, then start, then `workflowRunId`
// — because the first two both admit ties (two runs started in the same millisecond,
// two unreadable starts) and a comparator that answers zero hands the pair back in
// enumeration order. A list is read twice, from two responses that need not enumerate
// alike, so a tie-break on nothing is a list whose rows move under a person between
// one read and the next.
//
// THE CLASSIFICATION RIDES THE PARKED PHASE, NOT THE ROW. Whether a park resumes
// itself is `run-list-rows.ts`'s three-arm `WorkflowParkSchedule`, attached to each
// parked phase as it is projected — because the surface that says which kind of park
// this is renders ONE park at a time, and a row-level "something here is unscheduled"
// cannot tell it which. THREE row members used to carry that fact in aggregate and no
// renderer consumed any of them: the badge re-derived the answer from `autoResumeAt`'s
// presence and called a malformed instant a schedule. The last of the three was the
// soonest armed resume across a run's parks, which every surface that draws a resume
// reads off the park it is drawing; a row member nothing reads is a derivation run per
// row for nobody, and neither gate reports one — knip sees unused EXPORTS, not unused
// members of a used interface.
//
// THE SHAPES ARE NEXT DOOR AND THE VOCABULARY IS ON THE SUBSTRATE. `run-list-rows.ts`
// derives the run and phase rows from `bridge/workflow-projection.ts`, which is where
// the statuses and park reasons are declared; this module holds the reading — bands,
// order, and the counts a header shows — and declares exactly one closed set of its
// own, the attention band, because a band is a reading of a status rather than a
// status. It re-exports none of those shapes: this module used to forward
// `parkAwaitsPerson`, `parkSchedule`, `phasePark`, and six types it does not declare,
// so a reader who followed the park badge's import arrived at a module whose whole
// subject is the run LIST and found nothing there — the declaration was one more hop
// away, and the forwarding line was the only thing that said so. Every consumer names
// the declaring module directly, which is the same rule the family door obeys one
// level up.

import { compareInstants, type InstantReading } from "../../core/index.js";
import {
  parkSchedule,
  phasePark,
  workflowInstant,
  type WorkflowParkedPhase,
  type WorkflowPhaseStateRow,
  type WorkflowRunSnapshot,
  type WorkflowRunState,
} from "./run-list-rows.js";

/**
 * The three bands a run sits in, in the order the list shows them.
 *
 * A band is about ATTENTION, not about status: `parked` is where a person may be
 * needed, `active` is where the engine is working, `settled` is where nothing more
 * will happen. Ordering by the six-value status directly would put `pending` above
 * `suspended` because the contract declares it first, which is a fact about the DDL
 * and not about what an operator should look at.
 *
 * MODULE-PRIVATE: the comparator below is the only reader, and the band a surface
 * shows arrives on the row. Published, the tuple invites a second surface to band a
 * run itself rather than reading the one this projection already decided.
 */
const WORKFLOW_RUN_ATTENTION_BANDS = ["parked", "active", "settled"] as const;

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
   * The run's start as this plane reads it, malformed included.
   *
   * The READING rather than the string, because the surface that prints it and the
   * comparator that orders it must not read the wire's spelling twice under two
   * grammars. `run.startedAt` is still on the snapshot for the title a figure carries
   * — the wire's own bytes, which is what a person pastes into a search.
   */
  readonly startedAt: InstantReading;
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
 * What a row's open control does, when a caller supplies one.
 *
 * Declared beside the row it hands back rather than inside either component, on the
 * precedent `definitions/definition-rows.ts` sets for `OpenDefinition`: the list and
 * the row are two modules that have to agree about one signature, and declaring it in
 * one of them makes the other import a component module for a type.
 */
export type OpenRun = (row: WorkflowRunListRow) => void;

/**
 * The tie-break, and the reason the ordering is a property rather than a hope.
 *
 * `workflowRunId` is the run's own identity, so two rows compare equal here only when
 * they are the same run — and a list that held one run twice would be a fixture or a
 * daemon defect rather than an ordering question. Compared by code unit rather than
 * through `localeCompare`, because the order has to be the same on every host: a
 * locale-sensitive collation of opaque identifiers would put two operators' lists in
 * different orders and make a screenshot reference a fact about the machine that took
 * it.
 */
function workflowRunIdAscending(left: WorkflowRunListRow, right: WorkflowRunListRow): number {
  const leftRunId = left.run.workflowRunId;
  const rightRunId = right.run.workflowRunId;
  if (leftRunId === rightRunId) {
    return 0;
  }
  return leftRunId < rightRunId ? -1 : 1;
}

/** The band a run belongs to, decided by its parks first and its status second. */
function attentionBandFor(
  run: WorkflowRunSnapshot,
  parkedPhases: readonly WorkflowParkedPhase[],
): WorkflowRunAttentionBand {
  return parkedPhases.length > 0 ? "parked" : RUN_STATE_ATTENTION_BANDS[run.state];
}

/**
 * Every phase of one run that is parked, classified, in the order they arrived.
 *
 * THE PARK PROJECTION, AND THE ONLY ONE. Three surfaces draw a park — the run row's
 * badges, the run pane's stack of cards, and the phase node above that stack — and each
 * used to apply the discriminator and the schedule rule itself. Two of the three then
 * disagreed about the phase's NAME, because one read the row's own member and the other
 * substituted a module-level constant, so one screen named a parked phase and the
 * surface beside it drew the same park with no name at all. That is not a bug in either
 * one: it is the consequence of there being three.
 *
 * Takes the phases rather than the run because two of the three callers hold only a
 * phase list, and a projection that demanded a whole run would have sent them back to
 * deriving it themselves — which is the state this replaces.
 */
export function projectParkedPhases(
  phaseStates: readonly WorkflowPhaseStateRow[],
): readonly WorkflowParkedPhase[] {
  const parkedPhases: WorkflowParkedPhase[] = [];
  for (const phase of phaseStates) {
    const park = phasePark(phase);
    if (park !== undefined) {
      parkedPhases.push({
        phaseId: phase.phaseId,
        phaseName: phase.phaseName,
        park,
        schedule: parkSchedule(park),
      });
    }
  }
  return parkedPhases;
}

/** One run's row, with every derived fact read off the snapshot exactly once. */
function projectRun(run: WorkflowRunSnapshot): WorkflowRunListRow {
  const parkedPhases = projectParkedPhases(run.phaseStates);
  return {
    run,
    parkedPhases,
    // The start is read ONCE per run, here, rather than once per comparison and again
    // at the row. A key function called from inside the comparator parses the same
    // string on the order of `n log n` occasions, and — the reason that matters — gives
    // the sort a place to disagree with itself and with the surface above it.
    startedAt: workflowInstant(run.startedAt),
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
        if (bandDelta !== 0) {
          return bandDelta;
        }
        // Newest first inside a band: a run started a minute ago is the one an
        // operator scanning a band is looking for. An unreadable start lands last
        // here as it does in every other direction, because the console's one
        // comparator holds that arm before it compares numbers at all — below every
        // legible start, since a run nothing can be said about belongs under every
        // run that carries a start a person can read.
        const startDelta = compareInstants(left.startedAt, right.startedAt, "newest-first");
        // And then the run's own id, which is what makes the claim above TRUE rather
        // than usually true. Two runs started in the same millisecond, and two whose
        // starts are both unreadable, compare equal on every key before this one — so
        // without it the list held whatever order the enumeration supplied, and a
        // later read that supplied them the other way round swapped them on screen.
        return startDelta !== 0 ? startDelta : workflowRunIdAscending(left, right);
      });
  }

  /** Every row, attention first and newest first inside a band. */
  public get rows(): readonly WorkflowRunListRow[] {
    return this.#rows;
  }

  /**
   * How many runs the list is showing in its parked band. The header's own reading.
   *
   * Counted off the BAND rather than off the parked phases, because the band is the
   * one derivation and the two do not agree: an older daemon emits none of the four
   * park members, so a `suspended` run lands in the parked band with no parked phase
   * on it. Counting phases reported no parked runs while drawing one under the
   * heading that says there are none.
   */
  public get parkedRunCount(): number {
    return this.#rows.filter((row) => row.attentionBand === "parked").length;
  }

  /** How many runs are pinned to a version their definition has moved past. */
  public get frozenPinCount(): number {
    return this.#rows.filter((row) => row.isPinnedBehindLatestVersion).length;
  }
}
