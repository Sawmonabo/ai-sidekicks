// A long run's window of calls: the stretch of a run group's drawn rows the outer list holds,
// measured in screen heights as the transcript's own window is, and what its edges count. A
// window holds the run's newest calls until a reader opens an earlier stretch, and holds the newest
// again once a later stretch reaches them. Each edge line is a row of the outer list keyed under
// its group, so it goes with the group wherever the group goes. The run group fold cuts the
// window rather than the transcript's window cap: the cap holds one unbroken span of the list and
// a group's header stands before every row of it, so a cut above a run's window would take the
// header with it.

import {
  TRANSCRIPT_LET_GO_SCREEN_HEIGHTS,
  TRANSCRIPT_RETAINED_SCREEN_HEIGHTS,
  TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
} from "../viewport/caps.js";
import { type RunGroup } from "./groups.js";

/** An edge of a run's window: toward the stretch's first call, or toward its newest. */
export type RunWindowEdge = "earlier" | "later";

/** What a window is measured in: the screen, and each row's height as the list lays it out. */
export interface RunWindowMeasure {
  /** The viewport's height in pixels, the window's unit. */
  readonly screenHeightPx: () => number;
  /** A row's height in pixels: as it was measured, else its estimate; zero for one never drawn. */
  readonly rowHeightPx: (rowId: string) => number;
}

/** Where a run group's window stands, in its drawn rows and in its row ids. */
export interface RunCallWindow {
  /** The window's first drawn row, as an index into the group's drawn rows. */
  readonly firstCallIndex: number;
  /** One past the window's last drawn row. */
  readonly endCallIndex: number;
  /** The first of the group's `rowIds` the outer list holds. */
  readonly firstRowPosition: number;
  /** The last of the group's `rowIds` the outer list holds. */
  readonly lastRowPosition: number;
  /** The drawn rows before the window, which the `earlier` edge counts. */
  readonly earlierCount: number;
  /** The drawn rows after the window, which the `later` edge counts. */
  readonly laterCount: number;
}

/** One edge line of one run group's window, as a row of the outer list. */
export interface RunWindowEdgeRow {
  readonly runGroup: RunGroup;
  readonly edge: RunWindowEdge;
}

/**
 * The windows of one session's long runs, by run group key. A window holding a run's newest calls
 * keeps the retained share of screens and lets its oldest calls go only once it passes the let-go
 * distance, so heights settling as rows are measured do not move it row by row. A window a reader
 * moved keeps both of its ends until the next press.
 */
export class RunCallWindows {
  readonly #heldByKey = new Map<string, HeldWindow>();
  readonly #resolvedByKey = new Map<string, RunCallWindow>();

  /** The window of `runGroup` now, adjusted to the screen as `measure` reads it. */
  public windowOf(runGroup: RunGroup, measure: RunWindowMeasure): RunCallWindow {
    const walk = new CallWalk(runGroup, measure);
    const held = this.#heldByKey.get(runGroup.key);
    const lastCallIndex = walk.callIndexOf(held?.lastCallRowId);
    let firstCallIndex = walk.callIndexOf(held?.firstCallRowId);
    let endCallIndex: number;
    if (lastCallIndex !== undefined && firstCallIndex !== undefined) {
      endCallIndex = lastCallIndex + 1;
    } else {
      endCallIndex = walk.callCount;
      const heightPx =
        firstCallIndex === undefined ? 0 : walk.heightPx(firstCallIndex, endCallIndex);
      if (
        firstCallIndex === undefined ||
        heightPx < walk.screensPx(TRANSCRIPT_RETAINED_SCREEN_HEIGHTS) ||
        heightPx > walk.screensPx(TRANSCRIPT_LET_GO_SCREEN_HEIGHTS)
      ) {
        firstCallIndex = walk.firstIndexBefore(endCallIndex, TRANSCRIPT_RETAINED_SCREEN_HEIGHTS);
      }
    }
    this.#hold(runGroup, walk, firstCallIndex, endCallIndex);
    const window = walk.windowOf(firstCallIndex, endCallIndex);
    this.#resolvedByKey.set(runGroup.key, window);
    return window;
  }

  /**
   * Open the next stretch beyond `edge`: the window moves a stretch of screens that way and keeps
   * the retained share, so the rows beside the pressed edge stay in it. A later stretch that
   * reaches the newest call holds the newest again.
   */
  public openStretch(runGroup: RunGroup, edge: RunWindowEdge, measure: RunWindowMeasure): void {
    const current = this.windowOf(runGroup, measure);
    const walk = new CallWalk(runGroup, measure);
    if (edge === "earlier") {
      const firstCallIndex = walk.firstIndexBefore(
        current.firstCallIndex,
        TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
      );
      const endCallIndex = walk.endIndexAfter(firstCallIndex, TRANSCRIPT_RETAINED_SCREEN_HEIGHTS);
      this.#hold(runGroup, walk, firstCallIndex, endCallIndex);
      return;
    }
    const endCallIndex = walk.endIndexAfter(
      current.endCallIndex,
      TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
    );
    this.#hold(
      runGroup,
      walk,
      walk.firstIndexBefore(endCallIndex, TRANSCRIPT_RETAINED_SCREEN_HEIGHTS),
      endCallIndex,
    );
  }

  /** The window the last `windowOf` resolved for a run group, by its key. */
  public resolvedWindowOf(runGroupKey: string): RunCallWindow | undefined {
    return this.#resolvedByKey.get(runGroupKey);
  }

  /**
   * A copy of these windows as they stand, which a fold of another log may move without moving
   * these: a copy of rows the store let go cuts each run where the feed would draw it.
   */
  public clone(): RunCallWindows {
    const copy = new RunCallWindows();
    for (const [runGroupKey, held] of this.#heldByKey) {
      copy.#heldByKey.set(runGroupKey, held);
    }
    return copy;
  }

  /** Forget every window but those of the run groups `runGroupByHeaderKey` still holds. */
  public keepOnly(runGroupByHeaderKey: ReadonlyMap<string, RunGroup>): void {
    for (const runGroupKey of this.#heldByKey.keys()) {
      if (!runGroupByHeaderKey.has(runGroupKey)) {
        this.#heldByKey.delete(runGroupKey);
        this.#resolvedByKey.delete(runGroupKey);
      }
    }
  }

  // An end at the newest call is held as none, so the window grows with the run.
  #hold(runGroup: RunGroup, walk: CallWalk, firstCallIndex: number, endCallIndex: number): void {
    this.#heldByKey.set(runGroup.key, {
      firstCallRowId: walk.rowIdOf(firstCallIndex),
      lastCallRowId: endCallIndex >= walk.callCount ? undefined : walk.rowIdOf(endCallIndex - 1),
    });
  }
}

/**
 * The drawn row beside `edge` inside `window`, which a press on that edge holds where it stands
 * while the rows beyond it land.
 */
export function rowBesideRunWindowEdge(
  runGroup: RunGroup,
  window: RunCallWindow,
  edge: RunWindowEdge,
): string | undefined {
  const callIndex = edge === "earlier" ? window.firstCallIndex : window.endCallIndex - 1;
  const position = runGroup.drawnRowPositions[callIndex];
  return position === undefined ? undefined : runGroup.rowIds[position];
}

/** The outer list's key of one run group's edge line. */
export function runWindowEdgeKey(runGroupKey: string, edge: RunWindowEdge): string {
  return `${runGroupKey}${EDGE_KEY_SEPARATOR}${edge}`;
}

/** The edge line `rowKey` names, or `undefined` when it names none of these run groups'. */
export function readRunWindowEdgeKey(
  rowKey: string,
  runGroupByHeaderKey: ReadonlyMap<string, RunGroup>,
): RunWindowEdgeRow | undefined {
  const separatorAt = rowKey.lastIndexOf(EDGE_KEY_SEPARATOR);
  if (separatorAt === -1) {
    return undefined;
  }
  const edge = rowKey.slice(separatorAt + EDGE_KEY_SEPARATOR.length);
  const runGroup = runGroupByHeaderKey.get(rowKey.slice(0, separatorAt));
  return runGroup !== undefined && (edge === "earlier" || edge === "later")
    ? { runGroup, edge }
    : undefined;
}

/** Between a group's key and its edge in an edge line's key; no group key or row id holds it. */
const EDGE_KEY_SEPARATOR = "#window-";

/** A window's ends as the drawn rows they stand at; no last row while it holds the newest. */
interface HeldWindow {
  readonly firstCallRowId: string;
  readonly lastCallRowId: string | undefined;
}

/** One run group's drawn rows, walked in pixels of one measure. */
class CallWalk {
  readonly #runGroup: RunGroup;
  readonly #measure: RunWindowMeasure;
  readonly #screenHeightPx: number;

  public constructor(runGroup: RunGroup, measure: RunWindowMeasure) {
    this.#runGroup = runGroup;
    this.#measure = measure;
    this.#screenHeightPx = measure.screenHeightPx();
  }

  public get callCount(): number {
    return this.#runGroup.drawnRowPositions.length;
  }

  public screensPx(screenHeights: number): number {
    return screenHeights * this.#screenHeightPx;
  }

  public rowIdOf(callIndex: number): string {
    const position = this.#runGroup.drawnRowPositions[callIndex];
    const rowId = position === undefined ? undefined : this.#runGroup.rowIds[position];
    if (rowId === undefined) {
      throw new Error(`A run group has no drawn row at ${String(callIndex)}`);
    }
    return rowId;
  }

  /** The index of the drawn row `rowId` names, or `undefined` for none or a row not drawn. */
  public callIndexOf(rowId: string | undefined): number | undefined {
    const position = rowId === undefined ? -1 : this.#runGroup.rowIds.indexOf(rowId);
    if (position === -1) {
      return undefined;
    }
    const positions = this.#runGroup.drawnRowPositions;
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((positions[middle] ?? 0) < position) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return positions[low] === position ? low : undefined;
  }

  /** The summed height of the drawn rows from `firstCallIndex` up to `endCallIndex`. */
  public heightPx(firstCallIndex: number, endCallIndex: number): number {
    let heightPx = 0;
    for (let callIndex = firstCallIndex; callIndex < endCallIndex; callIndex += 1) {
      heightPx += this.#measure.rowHeightPx(this.rowIdOf(callIndex));
    }
    return heightPx;
  }

  /**
   * The first index whose rows up to `endCallIndex` fill `screenHeights`, else the first call. It
   * takes one row at least, so a measure that reads zero before layout still draws a call.
   */
  public firstIndexBefore(endCallIndex: number, screenHeights: number): number {
    const targetPx = this.screensPx(screenHeights);
    let heightPx = 0;
    let callIndex = endCallIndex;
    while (callIndex > 0 && (heightPx < targetPx || callIndex === endCallIndex)) {
      callIndex -= 1;
      heightPx += this.#measure.rowHeightPx(this.rowIdOf(callIndex));
    }
    return callIndex;
  }

  /**
   * One past the last index whose rows from `firstCallIndex` fill `screenHeights`, else all. It
   * takes one row at least, as `firstIndexBefore` does.
   */
  public endIndexAfter(firstCallIndex: number, screenHeights: number): number {
    const targetPx = this.screensPx(screenHeights);
    let heightPx = 0;
    let callIndex = firstCallIndex;
    while (callIndex < this.callCount && (heightPx < targetPx || callIndex === firstCallIndex)) {
      heightPx += this.#measure.rowHeightPx(this.rowIdOf(callIndex));
      callIndex += 1;
    }
    return callIndex;
  }

  /**
   * The window over drawn rows `firstCallIndex` up to `endCallIndex`. A window from the first call
   * holds the rows before it too, and one at the newest call the rows after it, so no row of the
   * stretch stands between an edge and the group's own ends.
   */
  public windowOf(firstCallIndex: number, endCallIndex: number): RunCallWindow {
    const positions = this.#runGroup.drawnRowPositions;
    const lastRowPosition = this.#runGroup.rowIds.length - 1;
    return {
      firstCallIndex,
      endCallIndex,
      firstRowPosition: firstCallIndex === 0 ? 0 : (positions[firstCallIndex] ?? 0),
      lastRowPosition:
        endCallIndex >= this.callCount
          ? lastRowPosition
          : (positions[endCallIndex - 1] ?? lastRowPosition),
      earlierCount: firstCallIndex,
      laterCount: this.callCount - endCallIndex,
    };
  }
}
