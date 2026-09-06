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
// AND ONE MORE THAT IS, HELD SOMEWHERE ELSE. `DiffFileList`'s filter text is a
// predicate over the model's own file PATHS, so it is in the first list rather
// than the second — but it belongs to the list that draws the input and never
// reaches this module's holder, so it takes the same subject and the same
// `undefined` key from `useSubjectScopedState` directly, beside its own register.
//
// THE IDENTITY IS THE PROP REFERENCE, and there is no other candidate.
// `ConsoleDiffModel` carries no id (`diff-model.ts` says why its producer does
// not exist yet), and a key derived from `baseRef` / `headRef` / attribution
// would both miss a real change — two diffs of the same two refs can hold
// different content — and claim a member the model does not have. So the model
// IS the subject, and the key within it is `undefined`: one model is one subject
// entire, with nothing inside it to name.
//
// AND THE RULE IS THE CONSOLE'S ONE COPY OF IT. `store/subject-scoped-state.ts`
// holds what a subject-scoped value may do — seeded during the render that first
// sees a new subject, so no committed frame carries the previous one's; and
// written only by a publisher captured under the subject still on screen, so a
// handler a consumer carried across the move writes NOWHERE rather than selecting
// one diff's path inside another. This module hand-rolled the first half from a
// state register and left the second open; both are now the substrate's, and this
// file only says what the diff's subject and seed are.

import { useCallback } from "react";

import { useSubjectScopedState } from "../../store/index.js";

import type { ConsoleDiffModel } from "./diff-model.js";
import { expandGap, type DiffGapExpansion } from "./diff-row-model.js";

/**
 * The subject a pane holding no diff is addressed at.
 *
 * A module-level constant rather than a fresh object per render, so every pass with
 * no diff is one subject and the seed is not re-run under a pane that is simply
 * waiting. It is never compared with a model — a `ConsoleDiffModel` is a different
 * object — so no diff can be mistaken for the absence of one.
 */
const NO_DIFF_SUBJECT: object = {};

/** The two pieces of view state one diff owns, held as one value. */
interface HeldDiffViewState {
  readonly selectedFilePath: string | undefined;
  readonly expansion: DiffGapExpansion;
}

/**
 * What a diff opens on: the whole change set, with nothing unfolded.
 *
 * Declared once rather than written at the seed site, because it is also what the
 * pane degrades to when the model moves — the same reading in both places, and one
 * of them cannot drift.
 */
function unnarrowedDiffViewState(): HeldDiffViewState {
  return { selectedFilePath: undefined, expansion: new Map() };
}

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
  const { value, publish } = useSubjectScopedState<HeldDiffViewState>(
    diff ?? NO_DIFF_SUBJECT,
    undefined,
    unnarrowedDiffViewState,
  );

  const selectFilePath = useCallback(
    (path: string | undefined) => {
      publish((previous) => ({ ...previous, selectedFilePath: path }));
    },
    [publish],
  );

  const expandGapAt = useCallback(
    (fileIndex: number, hunkIndex: number) => {
      const available = diff?.files[fileIndex]?.hunks[hunkIndex]?.precedingContext.length ?? 0;
      // The update runs where the held value is, rather than over an expansion read
      // out of this closure: two presses settling in one tick would otherwise both
      // grow the map the render produced, and the second would erase the first.
      publish((previous) => ({
        ...previous,
        expansion: expandGap(previous.expansion, fileIndex, hunkIndex, available),
      }));
    },
    [diff, publish],
  );

  return {
    selectedFilePath: value.selectedFilePath,
    expansion: value.expansion,
    selectFilePath,
    expandGapAt,
  };
}
