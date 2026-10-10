// Which run groups and which calls a person folded, and which calls' output they opened whole.
// Nothing here reads whether a run is still going: every group and every call is open until a
// press, or `Fold every run`, folds it, a run that ends stays as the person left it, and an output
// opened whole stays whole through a fold and back.

import { type TranscriptRowDensity } from "../rows/renderer.js";

/**
 * The run groups and calls one session's reader folded, everything else being open, and the calls
 * whose output they opened whole.
 */
export class TranscriptFoldState {
  readonly #foldedRunGroupKeys = new Set<string>();
  readonly #foldedCallRowIds = new Set<string>();
  readonly #openedOutputRowIds = new Set<string>();

  /** Fold an open run group, or open a folded one: what a press on its header does. */
  public toggleRunGroup(runGroupKey: string): void {
    if (!this.#foldedRunGroupKeys.delete(runGroupKey)) {
      this.#foldedRunGroupKeys.add(runGroupKey);
    }
  }

  /** Open one run group. Answers whether it was folded, so an open one costs no repaint. */
  public openRunGroup(runGroupKey: string): boolean {
    return this.#foldedRunGroupKeys.delete(runGroupKey);
  }

  /** Fold every run group named. Answers whether any was open. */
  public foldRunGroups(runGroupKeys: Iterable<string>): boolean {
    const foldedBefore = this.#foldedRunGroupKeys.size;
    for (const runGroupKey of runGroupKeys) {
      this.#foldedRunGroupKeys.add(runGroupKey);
    }
    return this.#foldedRunGroupKeys.size !== foldedBefore;
  }

  /** Open every run group named. Answers whether any was folded. */
  public unfoldRunGroups(runGroupKeys: Iterable<string>): boolean {
    let opened = false;
    for (const runGroupKey of runGroupKeys) {
      opened = this.#foldedRunGroupKeys.delete(runGroupKey) || opened;
    }
    return opened;
  }

  /** Fold an open call, or open a folded one: what a press on its chevron does. */
  public toggleCall(rowId: string): void {
    if (!this.#foldedCallRowIds.delete(rowId)) {
      this.#foldedCallRowIds.add(rowId);
    }
  }

  /**
   * Draw one call's output whole rather than cut at the visible flow: what `Show all` does.
   * Answers whether it was cut, so an output already whole costs no repaint.
   */
  public openOutput(rowId: string): boolean {
    if (this.#openedOutputRowIds.has(rowId)) {
      return false;
    }
    this.#openedOutputRowIds.add(rowId);
    return true;
  }

  /** The run groups a person folded, by key. */
  public get foldedRunGroupKeys(): ReadonlySet<string> {
    return this.#foldedRunGroupKeys;
  }

  /** The calls a person folded, by row id. */
  public get foldedCallRowIds(): ReadonlySet<string> {
    return this.#foldedCallRowIds;
  }

  /** The calls whose output a person opened whole, by row id. */
  public get openedOutputRowIds(): ReadonlySet<string> {
    return this.#openedOutputRowIds;
  }
}

/**
 * One row's density as the list hands it to the row renderer: `collapsed` exactly where a person
 * folded the call. Whether a call has a body to fold at all is the call's own fact, which the
 * tool card and the height estimate read beside this.
 */
export function densityFor(
  rowId: string,
  foldedCallRowIds: ReadonlySet<string>,
): TranscriptRowDensity {
  return foldedCallRowIds.has(rowId) ? "collapsed" : "expanded";
}
