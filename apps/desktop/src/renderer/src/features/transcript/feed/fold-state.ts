// Which run groups and which calls a person folded. Nothing here reads whether a run is still
// going: every group and every call is open until a press, or `Fold every run`, folds it, and a
// run that ends stays as the person left it.

import { type TranscriptRowDensity } from "../rows/renderer.js";

/** The run groups and calls one session's reader folded; everything else is open. */
export class TranscriptFoldState {
  readonly #foldedRunGroupKeys = new Set<string>();
  readonly #foldedCallRowIds = new Set<string>();

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

  /** The run groups a person folded, by key. */
  public get foldedRunGroupKeys(): ReadonlySet<string> {
    return this.#foldedRunGroupKeys;
  }

  /** The calls a person folded, by row id. */
  public get foldedCallRowIds(): ReadonlySet<string> {
    return this.#foldedCallRowIds;
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
