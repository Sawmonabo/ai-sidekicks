// The run list's projection: what a set of run snapshots reads as, before anything
// renders one.
//
// A run list has to answer three questions that no single wire field answers, and
// answering them in a component would answer them once per render and differently
// per surface. So they are answered here, once, as a value:
//
//   1. **Is anything parked, and why?** Not from the phase's `state`. The phase-run
//      status union carries no suspended arm — that is deliberate — and the park
//      instead rides four additive-optional members that a daemon emits for exactly
//      those phases parked when the response was built. So `parkReason` PRESENCE is the
//      wire's park discriminator, and a projection that read `state` would report a
//      phase that already resumed as still waiting.
//   2. **Which parks resume themselves and which need a person?** `autoResumeAt` is
//      armed only where a provider reported a reset boundary; its absence narrows
//      the park to the unscheduled, operator-resumable kind rather than denying it.
//   3. **Is this run pinned to a version its definition has moved past?** That is
//      the frozen-definition state — the condition an operator repairs on resume. It
//      is an INEQUALITY between two opaque ids the caller passes through verbatim,
//      never a parse of either, and it is unknown rather than false when the caller
//      holds no latest.
//
// WHAT THIS MODULE IS NOT. It is not eligibility. Nothing here decides whether a run
// may be canceled, resumed, or re-pinned — those are daemon adjudications reaching
// the console as typed refusals (`workflow.control_denied`,
// `workflow.run_not_cancelable`, `workflow.resume_not_parked`, and the three
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
// sort and the surface that PRINTS the start look at the same value. Two readings would
// split this plane's `"utc-only"` policy from the figure chokepoint's default
// `"any-offset"` one: a start spelled with a numeric offset is legible to the second and
// malformed to the first, so the list would sort that run last and still print a
// readable time on it, with nothing on screen saying its stamp had been refused.
//
// AND THE SORT ENDS ON THE RUN'S OWN IDENTITY. Start, then `workflowRunId` — because
// the start admits ties (two runs started in the same millisecond, two unreadable
// starts) and a comparator that answers zero hands the pair back in enumeration order.
// A list is read twice, from two responses that need not enumerate alike, so a
// tie-break on nothing is a list whose rows move under a person between one read and
// the next.
//
// THE CLASSIFICATION RIDES THE PARKED PHASE, NOT THE ROW. Whether a park resumes
// itself is `run-list-rows.ts`'s three-arm `WorkflowParkSchedule`, attached to each
// parked phase as it is projected — because the surface that says which kind of park
// this is renders ONE park at a time, and a row-level "something here is unscheduled"
// cannot tell it which.
//
// THE SHAPES ARE NEXT DOOR. `run-list-rows.ts` derives the run and phase rows from
// `bridge/wire-shapes/workflow-projection.ts`, which declares the statuses and park
// reasons; this module holds the reading — order, the parked flag, and the counts a
// header shows. It re-exports none of those shapes: every consumer names the declaring
// module directly.

import { compareInstants, type InstantReading } from "@renderer/lib/instant.js";
import { foldParkAttention, type WorkflowParkAttentionEntry } from "./park-attention-fold.js";
import {
  parkSchedule,
  phasePark,
  workflowInstant,
  type WorkflowParkedPhase,
  type WorkflowPhaseStateRow,
  type WorkflowRunSnapshot,
} from "./run-list-rows.js";

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
  /**
   * True when a person may be needed: a phase is parked, or the run's status is
   * `suspended`.
   *
   * The status counts on its own because a `suspended` run can carry no park members,
   * and the run still says something is waiting.
   */
  readonly isParked: boolean;
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
 * The run list, projected once from the snapshots a caller holds.
 *
 * A class rather than a function because the rows and the counts read off them are
 * one computation with two consumers — a list body and its header — and computing
 * them separately is how a header comes to disagree with the list under it. The
 * projection is performed in the constructor and the instance is immutable, so a
 * caller memoizes the INSTANCE against its input and every read after that is free.
 *
 * It holds no subscription, no timer, and no store. A run list that refreshed itself
 * would be a second scheduler beside `store/read/refresh-scheduler.ts`; this projects what it is
 * given and nothing more.
 */
export class RunListProjection {
  readonly #rows: readonly WorkflowRunListRow[];
  readonly #parkAttention: readonly WorkflowParkAttentionEntry[];

  public constructor(runs: readonly WorkflowRunSnapshot[]) {
    this.#rows = runs
      .map((run) => projectRun(run))
      .sort((left, right) => {
        // Newest first: a run started a minute ago is the one an operator scanning the
        // list is looking for. An unreadable start lands last here as it does in every
        // other direction, because the console's one comparator holds that arm before
        // it compares numbers at all — below every legible start, since a run nothing
        // can be said about belongs under every run that carries a start a person can
        // read.
        const startDelta = compareInstants(left.startedAt, right.startedAt, "newest-first");
        // And then the run's own id, which is what makes the claim above TRUE rather
        // than usually true. Two runs started in the same millisecond, and two whose
        // starts are both unreadable, compare equal on every key before this one — so
        // without it the list held whatever order the enumeration supplied, and a
        // later read that supplied them the other way round swapped them on screen.
        return startDelta !== 0 ? startDelta : workflowRunIdAscending(left, right);
      });
    // Folded from the SORTED rows, so the entries come out in the same order the list
    // draws — the fold takes first-encounter order and has no comparator of its own to
    // disagree with the one above.
    this.#parkAttention = foldParkAttention(
      this.#rows.map((row) => ({
        workflowRunId: row.run.workflowRunId,
        parkedPhases: row.parkedPhases,
      })),
    );
  }

  /** Every row, newest first. */
  public get rows(): readonly WorkflowRunListRow[] {
    return this.#rows;
  }

  /**
   * Every live park as the attention surface reads it: correlated waits folded into
   * one entry each, uncorrelated ones standing alone.
   *
   * On the projection rather than computed by the surface, for the reason every other
   * derivation here is: the fold and the count read off it are one computation with
   * two consumers, and a header that counted separately from the body it heads is how
   * the two come to disagree.
   */
  public get parkAttention(): readonly WorkflowParkAttentionEntry[] {
    return this.#parkAttention;
  }

  /**
   * The badge's figure: how many DISTINCT attention entries there are, never how many
   * runs they stand for.
   *
   * That distinction is the whole point of the fold. Six runs parked on one spent
   * provider account are one thing to look at, and a badge reading `6` would undo the
   * fold on the surface most likely to be glanced at rather than read — while an
   * operator comparing it against the list would find six rows and one line and have
   * no way to tell which number was wrong.
   */
  public get parkAttentionCount(): number {
    return this.#parkAttention.length;
  }

  /**
   * How many runs the list shows as parked. The header's own reading.
   *
   * Counted off each row's `isParked` rather than off the parked phases, because a
   * `suspended` run can be parked with no parked phase on it: counting phases would
   * report no parked runs while the list draws one.
   */
  public get parkedRunCount(): number {
    return this.#rows.filter((row) => row.isParked).length;
  }

  /** How many runs are pinned to a version their definition has moved past. */
  public get frozenPinCount(): number {
    return this.#rows.filter((row) => row.isPinnedBehindLatestVersion).length;
  }
}

/**
 * Every phase of one run that is parked, classified, in the order they arrived.
 *
 * THE PARK PROJECTION, AND THE ONLY ONE. Three surfaces draw a park — the run row's
 * badges, the run pane's stack of cards, and the phase node above that stack — and each
 * takes the discriminator, the schedule rule and the phase's name from here, so no two
 * of them can draw the same park differently.
 *
 * Takes the phases rather than the run because two of the three callers hold only a
 * phase list.
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
    isParked: parkedPhases.length > 0 || run.state === "suspended",
  };
}
