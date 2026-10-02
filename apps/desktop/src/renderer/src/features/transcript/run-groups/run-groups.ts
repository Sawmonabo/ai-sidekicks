// Run groups: the fold that makes parallel runs read as parallel stories. A row joins a run
// group by its carried `runId` only (a `general` row has none), rows keep the log's order inside
// a run group, and run groups keep the order their first row arrived in: the fold partitions and
// never sorts. Whether a group is open lives in `run-group-fold-state.ts`, so the live run group
// never collapses. This module renders nothing; `RunGroupHeader.tsx` draws the model.

import type { ChildRunCompleteness, TimelineRow } from "@ai-sidekicks/contracts";

import { RunGroupBodyRowWindow, countClippedHeadRows } from "./run-group-body.js";
import {
  isReopeningEventType,
  isRunStateEventType,
  isTerminalEventType,
  payingAccountIdOf,
  type RunTerminalEventType,
} from "./run-lifecycle-events.js";

/** Whether a run group is still being written: a terminal one folds, a live one stays open. */
export const RUN_GROUP_LIFECYCLES = ["live", "terminal"] as const;

/** One lifecycle value of a run group. */
export type RunGroupLifecycle = (typeof RUN_GROUP_LIFECYCLES)[number];

/** One run's rows, folded. */
export interface RunGroup {
  /** The run this run group is, wire-verbatim. The only thing rows are grouped by. */
  readonly runId: string;
  /** The run group's row ids in arrival order, cached so the header and body read one array. */
  readonly rowIds: readonly string[];
  readonly rowCount: number;
  /**
   * Rows the outer list's ceiling left out, which the body clips behind a top-edge fade.
   * Counted by `countClippedHeadRows`, the rule the body's window is cut with, so the figure and
   * the rows agree; reported rather than dropped so the row count stays true.
   */
  readonly clippedRowCount: number;
  /** The actor the run's rows are attributed to, wire-verbatim, or `undefined` if none. */
  readonly actorId: string | undefined;
  readonly lifecycle: RunGroupLifecycle;
  /**
   * The newest run state the log reported for this run, wire-verbatim, or `undefined` where no
   * row carried one and after a rewind that cleared it. A live run has a state even though it has
   * no `terminalEventType`.
   */
  readonly runStateEventType: string | undefined;
  /**
   * The provider account this run was admitted under, wire-verbatim, or `undefined` where no row
   * in the window named one.
   */
  readonly payingAccountId: string | undefined;
  /**
   * The rows immediately older than the ones the outer list mounted, oldest first and bounded by
   * the same ceiling. A subset of what `clippedRowCount` counts: a run long enough to outrun both
   * bounds has older rows than these.
   */
  readonly clippedHeadRows: readonly TimelineRow[];
  /** Which terminal ended it, wire-verbatim, or `undefined` while live. */
  readonly terminalEventType: RunTerminalEventType | undefined;
  /**
   * The row that ended it, or `undefined` while live. Carried as an id so a folded run group
   * renders its header and that row without scanning for its receipt.
   */
  readonly terminalRowId: string | undefined;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly firstTimestamp: string;
  readonly lastTimestamp: string;
  /**
   * A child run this run group summarizes whose expansion is incomplete, read off
   * `TimelineRow.childRunSummary`.
   *
   * Derived from the latest reading of each child, never accumulated: a child later summarized
   * as complete is one child observed twice, and the second reading is current.
   */
  readonly hasIncompleteChildExpand: boolean;
}

/** What a fold produced: the run groups, and the rows that belong to none. */
export interface RunGroupFold {
  readonly runGroups: readonly RunGroup[];
  /**
   * Rows carrying no run attribution (the `general` arm). Not folded into a run group: a
   * session-scoped row inside a run's group would attribute it to that run.
   */
  readonly ungroupedRowIds: readonly string[];
}

/**
 * The run group fold over one loaded window.
 *
 * A class because the fold is read several times per frame; the instance is the memo, built once
 * per loaded-window identity and computing nothing until something is read.
 */
export class RunGroupIndex {
  readonly #rows: readonly TimelineRow[];
  /** The lazy fold. Undefined until the first read. */
  #fold: RunGroupFold | undefined;
  #runGroupByRunId: ReadonlyMap<string, RunGroup> | undefined;

  public constructor(rows: readonly TimelineRow[]) {
    this.#rows = rows;
  }

  /** Every run group, in the order each run's first row arrived. */
  public runGroups(): readonly RunGroup[] {
    return this.#foldOnce().runGroups;
  }

  /** Rows carrying no run attribution, in log order. */
  public ungroupedRowIds(): readonly string[] {
    return this.#foldOnce().ungroupedRowIds;
  }

  /** One run group by run, or `undefined` when the window holds none of that run. */
  public runGroupFor(runId: string): RunGroup | undefined {
    this.#runGroupByRunId ??= new Map(
      this.#foldOnce().runGroups.map((runGroup) => [runGroup.runId, runGroup]),
    );
    return this.#runGroupByRunId.get(runId);
  }

  /** Run groups that have ended. The input to "collapse all terminal run groups". */
  public terminalRunGroups(): readonly RunGroup[] {
    return this.#foldOnce().runGroups.filter((runGroup) => runGroup.lifecycle === "terminal");
  }

  #foldOnce(): RunGroupFold {
    this.#fold ??= groupRowsByRun(this.#rows);
    return this.#fold;
  }
}

/**
 * The run a row belongs to, or `undefined` for a row that belongs to none.
 *
 * Narrowed on `kind`: `runId` is required on three arms and absent from `general`.
 */
export function readRunIdOfGroupedRow(row: TimelineRow): string | undefined {
  return row.kind === "general" ? undefined : row.runId;
}

/**
 * Partition one loaded window into run groups.
 *
 * Exported beside the class so a test or bench can drive the fold without an index.
 */
export function groupRowsByRun(rows: readonly TimelineRow[]): RunGroupFold {
  const accumulatorsByRunId = new Map<string, RunGroupAccumulator>();
  const ungroupedRowIds: string[] = [];

  for (const row of rows) {
    const runId = readRunIdOfGroupedRow(row);
    if (runId === undefined) {
      ungroupedRowIds.push(row.id);
      continue;
    }
    const existing = accumulatorsByRunId.get(runId);
    const accumulator = existing ?? newAccumulator(runId, row);
    if (existing === undefined) {
      accumulatorsByRunId.set(runId, accumulator);
    }
    absorbRow(accumulator, row);
  }

  return {
    runGroups: [...accumulatorsByRunId.values()].map(sealRunGroup),
    ungroupedRowIds,
  };
}

/** A run group under construction. Mutable only inside the fold. */
interface RunGroupAccumulator {
  readonly runId: string;
  readonly rowIds: string[];
  actorId: string | undefined;
  terminalEventType: RunTerminalEventType | undefined;
  terminalRowId: string | undefined;
  runStateEventType: string | undefined;
  payingAccountId: string | undefined;
  /** The bounded head this run group's body will draw. Fed one row at a time. */
  readonly bodyRows: RunGroupBodyRowWindow;
  firstSequence: number;
  lastSequence: number;
  firstTimestamp: string;
  lastTimestamp: string;
  /**
   * The latest completeness this run group's rows reported for each child run, replaced in row
   * order rather than folded into a boolean: the header asks about current readings. Keyed by
   * the child's run id, as `dispatches/child-run-entries.ts` re-summarizes, so header and card
   * agree on which observation is current.
   */
  readonly childExpandCompletenessByChildRunId: Map<string, ChildRunCompleteness["state"]>;
}

function newAccumulator(runId: string, row: TimelineRow): RunGroupAccumulator {
  return {
    runId,
    rowIds: [],
    actorId: undefined,
    terminalEventType: undefined,
    terminalRowId: undefined,
    runStateEventType: undefined,
    payingAccountId: undefined,
    bodyRows: new RunGroupBodyRowWindow(),
    firstSequence: row.sequence,
    lastSequence: row.sequence,
    firstTimestamp: row.timestamp,
    lastTimestamp: row.timestamp,
    childExpandCompletenessByChildRunId: new Map(),
  };
}

function absorbRow(accumulator: RunGroupAccumulator, row: TimelineRow): void {
  accumulator.rowIds.push(row.id);
  accumulator.bodyRows.admit(row);
  // The account is settled at admission, so the first naming wins.
  accumulator.payingAccountId ??= payingAccountIdOf(row);
  // The first actor wins: a later row naming another is a human steering inside the agent's run
  // group, which stays on that row's own leading edge.
  accumulator.actorId ??= row.actor;
  if (isRunStateEventType(row.type)) {
    // The newest state wins: a state is what the run is now.
    accumulator.runStateEventType = row.type;
  } else if (row.type === "run.rolled_back") {
    // A rewind says the run came back, not into what state, so the state is cleared rather than
    // kept.
    accumulator.runStateEventType = undefined;
  }
  if (isTerminalEventType(row.type)) {
    // The last terminal wins, set with its row so the two never name different rows.
    accumulator.terminalEventType = row.type;
    accumulator.terminalRowId = row.id;
  } else if (isReopeningEventType(row.type)) {
    // A run that came back clears its ending; a later ending seals it again.
    accumulator.terminalEventType = undefined;
    accumulator.terminalRowId = undefined;
  }
  if (row.childRunSummary !== undefined) {
    // Latest wins per child: a later `complete` replaces an earlier `incomplete`.
    accumulator.childExpandCompletenessByChildRunId.set(
      row.childRunSummary.runId,
      row.childRunSummary.completeness.state,
    );
  }
  if (row.sequence < accumulator.firstSequence) {
    accumulator.firstSequence = row.sequence;
    accumulator.firstTimestamp = row.timestamp;
  }
  if (row.sequence > accumulator.lastSequence) {
    accumulator.lastSequence = row.sequence;
    accumulator.lastTimestamp = row.timestamp;
  }
}

function sealRunGroup(accumulator: RunGroupAccumulator): RunGroup {
  const rowCount = accumulator.rowIds.length;
  return {
    runId: accumulator.runId,
    rowIds: accumulator.rowIds,
    rowCount,
    clippedRowCount: countClippedHeadRows(rowCount),
    actorId: accumulator.actorId,
    lifecycle: accumulator.terminalEventType === undefined ? "live" : "terminal",
    runStateEventType: accumulator.runStateEventType,
    payingAccountId: accumulator.payingAccountId,
    clippedHeadRows: accumulator.bodyRows.headRows,
    terminalEventType: accumulator.terminalEventType,
    terminalRowId: accumulator.terminalRowId,
    firstSequence: accumulator.firstSequence,
    lastSequence: accumulator.lastSequence,
    firstTimestamp: accumulator.firstTimestamp,
    lastTimestamp: accumulator.lastTimestamp,
    // Derived from the map the fold advanced, not a second walk over the rows.
    hasIncompleteChildExpand: [...accumulator.childExpandCompletenessByChildRunId.values()].some(
      (state) => state === "incomplete",
    ),
  };
}
