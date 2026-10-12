// Which of a window's rows a run group lets through. A second pass over the derived window, not a
// branch inside the derivation: the derivation changes when the log does, this changes when a
// person folds or opens a group or a stretch of a long run, and folding inside would re-project
// every row on each press. When the window only grew at its end, the fold applies what grew; a
// press, or a window derived again whole, folds the whole window.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import {
  runWindowEdgeKey,
  type RunCallWindow,
  type RunCallWindows,
  type RunWindowMeasure,
} from "../runs/call-window.js";
import { type RunGroup } from "../runs/groups.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { FilteredMap } from "../window/map-views.js";
import { positionOfRow, rowGrowthOf, sequenceInsertionPosition } from "../window/row-positions.js";
import {
  NO_ROWS_REMOVED,
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "../window/transcript-window.js";

/** The windows of a session's long runs, and what they are measured in. */
export interface RunWindowInputs {
  /** Where each run's window stands; the fold only asks for a window and drops gone groups'. */
  readonly windows: Pick<RunCallWindows, "windowOf" | "keepOnly">;
  /** The measure over one window model's rows. */
  readonly measureOf: (model: TranscriptWindowModel) => RunWindowMeasure;
  /** How many times a reader moved one of `windows`: a new count folds the whole window again. */
  readonly moveCount: number;
}

/**
 * Rows one stretch may push out of a long run's window before the fold is done whole instead:
 * each one leaves the middle of the published lists, which moves every row after it.
 */
const CAP_LEAVERS_FOLDED_IN_PLACE = 64;

/**
 * Puts a header above every run group, live or ended, at the row the group names, and lets
 * through the rows of each open group's window, held across one session's windows.
 *
 * The header is one viewport row keyed by the group's key, the `parentKey` every row of that group
 * already carries, so the group counts once against the window cap folded or open. A folded group
 * is its header alone; its rows leave both the viewport rows and the body lookup. An open group
 * keeps the rows of its window, with an edge line at each edge that has rows beyond it, keyed
 * under the group as its rows are. The rows it withholds are returned as `removedRows` for the
 * find field's counts.
 */
export class RunGroupFold {
  #input: TranscriptWindowModel | undefined;
  #foldedRunGroupKeys: ReadonlySet<string> | undefined;
  #runWindowInputs: RunWindowInputs | undefined;
  #stage: TranscriptPipelineStage | undefined;
  /** Each run group header's and edge line's identity, kept while its group stands. */
  #identityByKey = new Map<string, ViewportRow>();
  /** Each open group's window as the last stage folded it. */
  #windowByKey: ReadonlyMap<string, RunCallWindow> = new Map();
  /** The rows each open group's window admits, for each group whose window leaves rows out. */
  #admittedRowIdsByKey: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  /** How many of the last stage's withheld rows are system messages, for its map's size. */
  #withheldSystemMessageCount = 0;

  /**
   * The fold of `model` under `foldedRunGroupKeys`, the run groups a person folded, by key, with
   * each open group's window from `runWindowInputs`.
   */
  public fold(
    model: TranscriptWindowModel,
    foldedRunGroupKeys: ReadonlySet<string>,
    runWindowInputs: RunWindowInputs,
  ): TranscriptPipelineStage {
    const previousInput = this.#input;
    const previousStage = this.#stage;
    const previousRunWindowInputs = this.#runWindowInputs;
    const isSameReading =
      foldedRunGroupKeys === this.#foldedRunGroupKeys &&
      runWindowInputs.windows === previousRunWindowInputs?.windows &&
      runWindowInputs.measureOf === previousRunWindowInputs.measureOf &&
      runWindowInputs.moveCount === previousRunWindowInputs.moveCount;
    if (previousStage !== undefined && model === previousInput && isSameReading) {
      return previousStage;
    }
    let stage: TranscriptPipelineStage;
    if (model.runGroupByHeaderKey.size === 0) {
      stage = { window: model, removedRows: NO_ROWS_REMOVED };
      this.#windowByKey = new Map();
      this.#admittedRowIdsByKey = new Map();
      this.#withheldSystemMessageCount = 0;
    } else {
      const grown =
        previousInput !== undefined &&
        previousStage !== undefined &&
        previousStage.window !== previousInput &&
        isSameReading
          ? this.#foldGrowth(
              previousInput,
              previousStage,
              model,
              foldedRunGroupKeys,
              runWindowInputs,
            )
          : undefined;
      stage = grown ?? this.#foldWhole(model, foldedRunGroupKeys, runWindowInputs);
    }
    this.#input = model;
    this.#foldedRunGroupKeys = foldedRunGroupKeys;
    this.#runWindowInputs = runWindowInputs;
    this.#stage = stage;
    return stage;
  }

  #foldWhole(
    model: TranscriptWindowModel,
    foldedRunGroupKeys: ReadonlySet<string>,
    runWindowInputs: RunWindowInputs,
  ): TranscriptPipelineStage {
    const viewportRows: ViewportRow[] = [];
    const rows: TranscriptEventRow[] = [];
    const removedRows: TranscriptEventRow[] = [];
    let withheldSystemMessageCount = 0;
    const identityByKey = new Map<string, ViewportRow>();
    const windowByKey = new Map<string, RunCallWindow>();
    // Once per open run group, not per row: re-slicing a long run per row is quadratic.
    const admittedRowIdsByKey = new Map<string, ReadonlySet<string>>();
    const laterEdgeKeyByRowId = new Map<string, string>();
    const measure = runWindowInputs.measureOf(model);
    runWindowInputs.windows.keepOnly(model.runGroupByHeaderKey);
    for (const [runGroupKey, runGroup] of model.runGroupByHeaderKey) {
      if (foldedRunGroupKeys.has(runGroupKey)) {
        continue;
      }
      const window = runWindowInputs.windows.windowOf(runGroup, measure);
      windowByKey.set(runGroupKey, window);
      const admitted = admittedRowIdsOf(runGroup, window);
      if (admitted !== undefined) {
        admittedRowIdsByKey.set(runGroupKey, admitted);
      }
      const lastRowId = runGroup.rowIds[window.lastRowPosition];
      if (window.laterCount > 0 && lastRowId !== undefined) {
        laterEdgeKeyByRowId.set(lastRowId, runGroupKey);
      }
    }
    const pushIdentity = (key: string, runGroupKey: string, parentKey: string | undefined) => {
      const identity = this.#identityOf(key, runGroupKey, parentKey);
      identityByKey.set(key, identity);
      viewportRows.push(identity);
    };
    model.rows.forEach((row, position) => {
      // The fold files a row under the same parent as the window it folds, so it hands on that
      // window's identity object.
      const identity = model.viewportRows[position] as ViewportRow;
      const runGroupKey = identity.parentKey;
      if (
        runGroupKey !== undefined &&
        !identityByKey.has(runGroupKey) &&
        model.runGroupByHeaderKey.get(runGroupKey)?.headerRowId === row.id
      ) {
        // At the row the group names, so the header sits where the stretch starts and log order
        // holds; the earlier edge stands under it, above the window's first row.
        pushIdentity(runGroupKey, runGroupKey, undefined);
        if ((windowByKey.get(runGroupKey)?.earlierCount ?? 0) > 0) {
          pushIdentity(runWindowEdgeKey(runGroupKey, "earlier"), runGroupKey, runGroupKey);
        }
      }
      if (isAdmitted(runGroupKey, row.id, foldedRunGroupKeys, admittedRowIdsByKey)) {
        viewportRows.push(identity);
        rows.push(row);
      } else {
        removedRows.push(row);
        withheldSystemMessageCount += model.systemMessageByRowId.has(row.id) ? 1 : 0;
      }
      const laterEdgeGroupKey = laterEdgeKeyByRowId.get(row.id);
      if (laterEdgeGroupKey !== undefined && laterEdgeGroupKey === runGroupKey) {
        pushIdentity(
          runWindowEdgeKey(laterEdgeGroupKey, "later"),
          laterEdgeGroupKey,
          laterEdgeGroupKey,
        );
      }
    });
    this.#identityByKey = identityByKey;
    this.#windowByKey = windowByKey;
    this.#admittedRowIdsByKey = admittedRowIdsByKey;
    this.#withheldSystemMessageCount = withheldSystemMessageCount;
    return foldedStage(
      model,
      viewportRows,
      rows,
      removedRows.length === 0 ? NO_ROWS_REMOVED : removedRows,
      foldedRunGroupKeys,
      admittedRowIdsByKey,
      withheldSystemMessageCount,
    );
  }

  /**
   * The fold of `model` applied to `previousStage` by what grew since `previousInput`: rows
   * projected again take their place, new rows join, and an open group whose window holds its
   * newest calls lets the calls it trims go. `undefined` when the window moved any other way, an
   * edge line came or went, or a row projected again stopped or started being a system message.
   */
  #foldGrowth(
    previousInput: TranscriptWindowModel,
    previousStage: TranscriptPipelineStage,
    model: TranscriptWindowModel,
    foldedRunGroupKeys: ReadonlySet<string>,
    runWindowInputs: RunWindowInputs,
  ): TranscriptPipelineStage | undefined {
    const growth = rowGrowthOf(previousInput.rows, model.rows);
    if (growth === undefined) {
      return undefined;
    }
    const lists = new FoldedLists(previousStage);
    for (const position of growth.replacedPositions) {
      const previousRow = previousInput.rows[position] as TranscriptEventRow;
      if (
        previousInput.systemMessageByRowId.has(previousRow.id) !==
          model.systemMessageByRowId.has(previousRow.id) ||
        !lists.replaceRow(previousRow, model.rows[position] as TranscriptEventRow)
      ) {
        return undefined;
      }
    }
    // Each open group the stretch grew, with its window before and after.
    const measure = runWindowInputs.measureOf(model);
    const grownWindows = new Map<string, GrownWindow>();
    for (let position = growth.appendedFrom; position < model.rows.length; position += 1) {
      const runGroupKey = (model.viewportRows[position] as ViewportRow).parentKey;
      const runGroup =
        runGroupKey === undefined ? undefined : model.runGroupByHeaderKey.get(runGroupKey);
      if (
        runGroupKey === undefined ||
        runGroup === undefined ||
        foldedRunGroupKeys.has(runGroupKey) ||
        grownWindows.has(runGroupKey)
      ) {
        continue;
      }
      const grown = {
        runGroup,
        before: this.#windowByKey.get(runGroupKey),
        after: runWindowInputs.windows.windowOf(runGroup, measure),
      };
      if (!isWindowGrownInPlace(grown)) {
        return undefined;
      }
      grownWindows.set(runGroupKey, grown);
    }
    let withheldSystemMessageCount = this.#withheldSystemMessageCount;
    const countWithheld = (row: TranscriptEventRow): void => {
      withheldSystemMessageCount += model.systemMessageByRowId.has(row.id) ? 1 : 0;
    };
    for (let position = growth.appendedFrom; position < model.rows.length; position += 1) {
      const row = model.rows[position] as TranscriptEventRow;
      const identity = model.viewportRows[position] as ViewportRow;
      const runGroupKey = identity.parentKey;
      if (runGroupKey === undefined) {
        lists.admit(identity, row);
        continue;
      }
      if (model.runGroupByHeaderKey.get(runGroupKey)?.headerRowId === row.id) {
        lists.admitHeader(this.#identityOf(runGroupKey, runGroupKey, undefined));
      }
      const window = grownWindows.get(runGroupKey)?.after;
      if (foldedRunGroupKeys.has(runGroupKey) || (window !== undefined && window.laterCount > 0)) {
        lists.withhold(row);
        countWithheld(row);
      } else {
        lists.admit(identity, row);
      }
    }
    let windowByKey = this.#windowByKey;
    let admittedRowIdsByKey = this.#admittedRowIdsByKey;
    for (const [runGroupKey, { runGroup, before, after }] of grownWindows) {
      windowByKey = new Map(windowByKey).set(runGroupKey, after);
      const admitted = admittedRowIdsOf(runGroup, after);
      admittedRowIdsByKey =
        admitted === undefined
          ? withoutKey(admittedRowIdsByKey, runGroupKey)
          : new Map(admittedRowIdsByKey).set(runGroupKey, admitted);
      const leaversFrom = before?.firstRowPosition ?? after.firstRowPosition;
      if (after.firstRowPosition - leaversFrom > CAP_LEAVERS_FOLDED_IN_PLACE) {
        return undefined;
      }
      for (const rowId of runGroup.rowIds.slice(leaversFrom, after.firstRowPosition)) {
        const row = model.rowsByKey.get(rowId);
        if (row === undefined || !lists.letGo(row)) {
          return undefined;
        }
        countWithheld(row);
      }
    }
    this.#windowByKey = windowByKey;
    this.#admittedRowIdsByKey = admittedRowIdsByKey;
    this.#withheldSystemMessageCount = withheldSystemMessageCount;
    return foldedStage(
      model,
      lists.viewportRows(),
      lists.rows(),
      lists.removedRows(),
      foldedRunGroupKeys,
      admittedRowIdsByKey,
      withheldSystemMessageCount,
    );
  }

  // A header is keyed by its group's key and an edge line by its own, each its group's cut unit
  // or hanging from it, so pruning the header takes its edges with it.
  #identityOf(key: string, runGroupKey: string, parentKey: string | undefined): ViewportRow {
    let identity = this.#identityByKey.get(key);
    if (identity === undefined) {
      identity = { key, parentKey, rootCursor: runGroupKey };
      this.#identityByKey.set(key, identity);
    }
    return identity;
  }
}

/** An open group a stretch grew: its window as the last stage folded it, and now. */
interface GrownWindow {
  readonly runGroup: RunGroup;
  readonly before: RunCallWindow | undefined;
  readonly after: RunCallWindow;
}

/**
 * Whether a grown group's window can be applied in place: its edge lines stand as they stood,
 * and its first row moved only toward its newest, so rows only leave at its earlier edge.
 */
function isWindowGrownInPlace({ before, after }: GrownWindow): boolean {
  const hasEarlierEdge = (window: RunCallWindow | undefined) => (window?.earlierCount ?? 0) > 0;
  const hasLaterEdge = (window: RunCallWindow | undefined) => (window?.laterCount ?? 0) > 0;
  if (
    hasEarlierEdge(before) !== hasEarlierEdge(after) ||
    hasLaterEdge(before) !== hasLaterEdge(after)
  ) {
    return false;
  }
  if (before === undefined) {
    return true;
  }
  return hasLaterEdge(after)
    ? after.firstRowPosition === before.firstRowPosition &&
        after.lastRowPosition === before.lastRowPosition
    : after.firstRowPosition >= before.firstRowPosition;
}

/** The rows `window` admits of `runGroup`, or `undefined` when it admits all of them. */
function admittedRowIdsOf(
  runGroup: RunGroup,
  window: RunCallWindow,
): ReadonlySet<string> | undefined {
  return window.firstRowPosition === 0 && window.lastRowPosition >= runGroup.rowIds.length - 1
    ? undefined
    : new Set(runGroup.rowIds.slice(window.firstRowPosition, window.lastRowPosition + 1));
}

function withoutKey<TValue>(
  map: ReadonlyMap<string, TValue>,
  key: string,
): ReadonlyMap<string, TValue> {
  if (!map.has(key)) {
    return map;
  }
  const without = new Map(map);
  without.delete(key);
  return without;
}

/**
 * The lists a stage published, written on copies taken at the first write, so a stretch that moves
 * none of them hands on the arrays the last stage published.
 */
class FoldedLists {
  readonly #previous: TranscriptPipelineStage;
  #viewportRows: ViewportRow[] | undefined;
  #rows: TranscriptEventRow[] | undefined;
  #removedRows: TranscriptEventRow[] | undefined;

  public constructor(previous: TranscriptPipelineStage) {
    this.#previous = previous;
  }

  /** Append a row the fold lets through, with its place in the identity list. */
  public admit(identity: ViewportRow, row: TranscriptEventRow): void {
    this.#writableViewportRows().push(identity);
    this.#writableRows().push(row);
  }

  /** Append a run group's header. */
  public admitHeader(header: ViewportRow): void {
    this.#writableViewportRows().push(header);
  }

  /** Append a row the fold withholds. Appended rows are the log's newest, so log order holds. */
  public withhold(row: TranscriptEventRow): void {
    this.#writableRemovedRows().push(row);
  }

  /** Put a row projected again where its earlier object stands. Answers whether it stood. */
  public replaceRow(previous: TranscriptEventRow, next: TranscriptEventRow): boolean {
    const rowPosition = positionOfRow(this.#previous.window.rows, previous);
    if (rowPosition !== -1) {
      this.#writableRows()[rowPosition] = next;
      return true;
    }
    const removedPosition = positionOfRow(this.#previous.removedRows, previous);
    if (removedPosition === -1) {
      return false;
    }
    this.#writableRemovedRows()[removedPosition] = next;
    return true;
  }

  /**
   * Move an admitted row out of the window and into the withheld rows at its place in log order.
   * Answers whether it was admitted.
   */
  public letGo(row: TranscriptEventRow): boolean {
    const rows = this.#writableRows();
    const rowPosition = positionOfRow(rows, row);
    if (rowPosition === -1) {
      return false;
    }
    rows.splice(rowPosition, 1);
    // Headers stand only before a row, so the row's identity sits at its row position plus the
    // headers ahead of it.
    const viewportRows = this.#writableViewportRows();
    let identityPosition = rowPosition;
    while (
      identityPosition < viewportRows.length &&
      viewportRows[identityPosition]?.key !== row.id
    ) {
      identityPosition += 1;
    }
    viewportRows.splice(identityPosition, 1);
    const removedRows = this.#writableRemovedRows();
    removedRows.splice(sequenceInsertionPosition(removedRows, row.sequence), 0, row);
    return true;
  }

  /** The identity list as it now stands. */
  public viewportRows(): readonly ViewportRow[] {
    return this.#viewportRows ?? this.#previous.window.viewportRows;
  }

  /** The admitted rows as they now stand. */
  public rows(): readonly TranscriptEventRow[] {
    return this.#rows ?? this.#previous.window.rows;
  }

  /** The withheld rows as they now stand, in log order. */
  public removedRows(): readonly TranscriptEventRow[] {
    return this.#removedRows ?? this.#previous.removedRows;
  }

  #writableViewportRows(): ViewportRow[] {
    this.#viewportRows ??= [...this.#previous.window.viewportRows];
    return this.#viewportRows;
  }

  #writableRows(): TranscriptEventRow[] {
    this.#rows ??= [...this.#previous.window.rows];
    return this.#rows;
  }

  #writableRemovedRows(): TranscriptEventRow[] {
    this.#removedRows ??= [...this.#previous.removedRows];
    return this.#removedRows;
  }
}

/**
 * Whether the fold lets a row through: a row of no group, or of an open group within its window.
 * `runGroupKey` is the key of the group the row belongs to, or `undefined` for none.
 */
function isAdmitted(
  runGroupKey: string | undefined,
  rowId: string,
  foldedRunGroupKeys: ReadonlySet<string>,
  admittedRowIdsByKey: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (runGroupKey === undefined) {
    return true;
  }
  const admittedRowIds = admittedRowIdsByKey.get(runGroupKey);
  return (
    !foldedRunGroupKeys.has(runGroupKey) &&
    (admittedRowIds === undefined || admittedRowIds.has(rowId))
  );
}

/**
 * The stage over these lists. Its body lookup and system messages are views over the window's
 * own, narrowed to the rows the fold lets through, so no whole-log map is built per stretch. Each
 * row is filed under its own id, so each view's size is a count of the lists, except in a window
 * where two rows share an id, whose views count themselves.
 */
function foldedStage(
  model: TranscriptWindowModel,
  viewportRows: readonly ViewportRow[],
  rows: readonly TranscriptEventRow[],
  removedRows: readonly TranscriptEventRow[],
  foldedRunGroupKeys: ReadonlySet<string>,
  admittedRowIdsByKey: ReadonlyMap<string, ReadonlySet<string>>,
  withheldSystemMessageCount: number,
): TranscriptPipelineStage {
  const isEveryRowIdOwn = model.rowsByKey.size === model.rows.length;
  const rowsByKey = new FilteredMap(
    model.rowsByKey,
    (rowId) =>
      isAdmitted(
        model.runGroupKeyByRowId.get(rowId),
        rowId,
        foldedRunGroupKeys,
        admittedRowIdsByKey,
      ),
    isEveryRowIdOwn ? rows.length : undefined,
  );
  return {
    window: {
      ...model,
      viewportRows,
      rows,
      rowsByKey,
      systemMessageByRowId: new FilteredMap(
        model.systemMessageByRowId,
        (rowId) => rowsByKey.has(rowId),
        isEveryRowIdOwn ? model.systemMessageByRowId.size - withheldSystemMessageCount : undefined,
      ),
    },
    removedRows,
  };
}
