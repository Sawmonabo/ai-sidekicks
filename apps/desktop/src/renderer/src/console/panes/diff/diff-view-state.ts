// The view state that belongs to ONE diff, and is dropped when the diff moves.
//
// A pane is reused. `DiffPane` and `InlineDiffCard` both take their model as a
// prop, and a host that points either at a different change set hands it a
// different `ConsoleDiffModel` on the next render. Two pieces of their state are
// addressed against that model and mean nothing without it:
//
//   • the SELECTED FILE PATH, which narrows the rows. A path the new diff does
//     not contain narrows the index to no file at all — `rowCount` is zero and
//     the renderer says "These states are identical" over a diff that has
//     changes, which is the console asserting a fact nobody established.
//   • the GAP EXPANSION, which is keyed by `(fileIndex, hunkIndex)`. Those
//     indices exist in the new diff too, and address entirely different hunks, so
//     the new model opens with somebody else's gaps already unfolded.
//
// WHAT IS DELIBERATELY NOT RESET. The four `useDiffViewControls` toggles — view
// mode, wrap, whitespace, attribution marks — are reading preferences over the
// PANE and not over one model. Resetting them would undo a person's toggle every
// time the subject moved, which is a different defect in the same place.
//
// THE IDENTITY IS THE PROP REFERENCE, and there is no other candidate.
// `ConsoleDiffModel` carries no id (`diff-model.ts` says why its producer does
// not exist yet), and a key derived from `baseRef` / `headRef` / attribution
// would both miss a real change — two diffs of the same two refs can hold
// different content — and claim a member the model does not have.
//
// THE COMPARISON IS HELD IN STATE RATHER THAN IN A REF. React's own rule for
// adjusting state when a prop changes is a state register compared during
// render; writing a ref during render is what React documents as forbidden, and
// under a double-invoked render it would mark the change handled before the
// state that answers it was ever set.

import { useCallback, useState } from "react";

import type { ConsoleDiffModel } from "./diff-model.js";
import { expandGap, type DiffGapExpansion } from "./diff-row-model.js";

/** The two pieces of view state one diff owns, and the two ways they move. */
export interface DiffModelViewState {
  /** The path whose rows are shown, or `undefined` for the whole change set. */
  readonly selectedFilePath: string | undefined;
  readonly expansion: DiffGapExpansion;
  /** Narrow the rows to one file, or to the whole change set with `undefined`. */
  selectFilePath(path: string | undefined): void;
  /** Reveal one more band of one gap's hidden context. */
  expandGapAt(fileIndex: number, hunkIndex: number): void;
}

/**
 * Hold one diff's view state, and drop it when the diff changes.
 *
 * The indices `expandGapAt` is given address `diff.files`, which is what makes
 * it correct beside a renderer that NARROWS rather than filters: a filtered
 * model renumbers its files, and a gap in the second file would arrive as file
 * zero and resolve the first file's context.
 */
export function useDiffModelViewState(diff: ConsoleDiffModel | undefined): DiffModelViewState {
  const [renderedModel, setRenderedModel] = useState<ConsoleDiffModel | undefined>(diff);
  const [expansion, setExpansion] = useState<DiffGapExpansion>(() => new Map());
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>(undefined);

  if (renderedModel !== diff) {
    setRenderedModel(diff);
    setExpansion(new Map());
    setSelectedFilePath(undefined);
  }

  const expandGapAt = useCallback(
    (fileIndex: number, hunkIndex: number) => {
      const available = diff?.files[fileIndex]?.hunks[hunkIndex]?.precedingContext.length ?? 0;
      setExpansion((previous) => expandGap(previous, fileIndex, hunkIndex, available));
    },
    [diff],
  );

  return {
    // The state a render that has just seen a new model still holds is the OLD
    // model's, and React re-renders before committing this one — but reading the
    // stale values here would paint one frame of the previous diff's narrowing
    // over the new one.
    selectedFilePath: renderedModel === diff ? selectedFilePath : undefined,
    expansion: renderedModel === diff ? expansion : new Map(),
    selectFilePath: setSelectedFilePath,
    expandGapAt,
  };
}
