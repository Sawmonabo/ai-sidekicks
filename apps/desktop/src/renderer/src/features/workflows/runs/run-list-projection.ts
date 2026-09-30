// The run list's projection: what a set of run snapshots reads as, before anything renders one.
// Answered once here so components cannot answer differently. A park is read from `parkReason`
// presence, not from the phase `state` (which has no suspended arm; a resumed phase would read as
// waiting). Whether it resumes itself is `autoResumeAt`; a frozen pin is an inequality between
// two opaque ids, unknown (not false-positive) when the caller holds no latest. No eligibility
// here: cancel, resume and re-pin are daemon adjudications that reach the console as typed
// refusals. The sort is newest first over one parse of the start (the row prints the same
// reading), an unreadable start sorts last through `compareInstants`, and ties end on
// `workflowRunId` so rows do not move between reads. The park classification rides each parked
// phase because the badge renders one park at a time. Shapes live in `run-list-rows.ts`.

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
   * The run's start as `workflowInstant` reads it, malformed included. The reading, not the
   * string, so the sort and the row that prints it never read the spelling under two grammars;
   * `run.startedAt` stays for the title a figure carries.
   */
  readonly startedAt: InstantReading;
  /**
   * True when the run's pinned version is not the definition's newest. False when the caller
   * supplied no latest: unknown is not stale.
   */
  readonly isPinnedBehindLatestVersion: boolean;
  /**
   * True when a person may be needed: a phase is parked, or the run's status is `suspended`,
   * which can carry no park members.
   */
  readonly isParked: boolean;
}

/**
 * What a row's open control does, when a caller supplies one. Declared beside the row it hands
 * back so the list and the row do not import a component module for a type.
 */
export type OpenRun = (row: WorkflowRunListRow) => void;

/**
 * The run list, projected once from the snapshots a caller holds. A class so the rows and the
 * counts read off them are one computation for the body and the header; the instance is
 * immutable, so a caller memoizes it against its input. It holds no subscription, timer or store.
 */
export class RunListProjection {
  readonly #rows: readonly WorkflowRunListRow[];
  readonly #parkAttention: readonly WorkflowParkAttentionEntry[];

  public constructor(runs: readonly WorkflowRunSnapshot[]) {
    this.#rows = runs
      .map((run) => projectRun(run))
      .sort((left, right) => {
        // Newest first; an unreadable start lands last, as `compareInstants` holds in every
        // direction.
        const startDelta = compareInstants(left.startedAt, right.startedAt, "newest-first");
        // Then the run id: equal starts (same millisecond, or both unreadable) would otherwise
        // keep enumeration order and swap on screen between reads.
        return startDelta !== 0 ? startDelta : workflowRunIdAscending(left, right);
      });
    // Folded from the sorted rows, so the entries come out in the list's own order.
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
   * Every live park as the attention list reads it: correlated waits folded into one entry each,
   * uncorrelated ones standing alone. On the projection so the fold and its count are one
   * computation.
   */
  public get parkAttention(): readonly WorkflowParkAttentionEntry[] {
    return this.#parkAttention;
  }

  /**
   * The badge's figure: distinct attention entries, never the runs they stand for. Six runs
   * parked on one spent account are one thing to look at, and `6` would undo the fold.
   */
  public get parkAttentionCount(): number {
    return this.#parkAttention.length;
  }

  /**
   * How many runs the list shows as parked. Counted off `isParked`, not parked phases, because a
   * `suspended` run can be parked with no parked phase.
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
 * Every phase of one run that is parked, classified, in arrival order. The one park projection:
 * the run row's badges, the run pane's cards and the phase node all take the discriminator,
 * schedule and name from here. Takes phases, not the run, because two callers hold only those.
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
 * The ordering tie-break. Compares by code unit, not `localeCompare`, so the order is the same
 * on every host.
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
    // Read once per run, not per comparison, so the sort cannot disagree with the row that
    // prints it.
    startedAt: workflowInstant(run.startedAt),
    isPinnedBehindLatestVersion:
      run.definitionLatestWorkflowVersionId !== undefined &&
      run.definitionLatestWorkflowVersionId !== run.workflowVersionId,
    isParked: parkedPhases.length > 0 || run.state === "suspended",
  };
}
