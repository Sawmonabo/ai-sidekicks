// Run groups: the fold that makes parallel runs read as parallel stories. A row joins a run
// group by its carried `runId` only (a `general` row has none), rows keep the log's order inside
// a run group, and run groups keep the order their first row arrived in: the fold partitions and
// never sorts. Whether a group is open lives in `run-group-fold-state.ts`, so the live run group
// never collapses. This module renders nothing; `RunGroupHeader.tsx` draws the model.

import type { TimelineRow } from "@ai-sidekicks/contracts/timeline/row";

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
  /**
   * The row that ended it, or `undefined` while live. Carried as an id so a folded run group
   * renders its header and that row without scanning for its receipt.
   */
  readonly terminalRowId: string | undefined;
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
  #runGroups: readonly RunGroup[] | undefined;

  public constructor(rows: readonly TimelineRow[]) {
    this.#rows = rows;
  }

  /** Every run group, in the order each run's first row arrived. */
  public runGroups(): readonly RunGroup[] {
    this.#runGroups ??= groupRowsByRun(this.#rows);
    return this.#runGroups;
  }

  /** Run groups that have ended. The input to "collapse all terminal run groups". */
  public terminalRunGroups(): readonly RunGroup[] {
    return this.runGroups().filter((runGroup) => runGroup.lifecycle === "terminal");
  }
}

/**
 * The run group a row hangs from, or `undefined` for a row that belongs to none: a
 * session-scoped row inside a run's group would attribute it to that run.
 *
 * Narrowed on `kind`: `runId` is required on three arms and absent from `general`.
 */
export function readRunGroupKey(row: TimelineRow): string | undefined {
  return row.kind === "general" ? undefined : row.runId;
}

/**
 * Partition one loaded window into run groups.
 *
 * Exported beside the class so a test or bench can drive the fold without an index.
 */
export function groupRowsByRun(rows: readonly TimelineRow[]): readonly RunGroup[] {
  const accumulatorsByRunId = new Map<string, RunGroupAccumulator>();

  for (const row of rows) {
    const runId = readRunGroupKey(row);
    if (runId === undefined) {
      continue;
    }
    const existing = accumulatorsByRunId.get(runId);
    const accumulator = existing ?? newAccumulator(runId);
    if (existing === undefined) {
      accumulatorsByRunId.set(runId, accumulator);
    }
    absorbRow(accumulator, row);
  }

  return [...accumulatorsByRunId.values()].map(sealRunGroup);
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
}

function newAccumulator(runId: string): RunGroupAccumulator {
  return {
    runId,
    rowIds: [],
    actorId: undefined,
    terminalEventType: undefined,
    terminalRowId: undefined,
    runStateEventType: undefined,
    payingAccountId: undefined,
    bodyRows: new RunGroupBodyRowWindow(),
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
    terminalRowId: accumulator.terminalRowId,
  };
}
