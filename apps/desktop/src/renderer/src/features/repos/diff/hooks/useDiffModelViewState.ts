// View state owned by one diff and dropped when the diff changes: the selected file path (a
// path the new diff lacks would show "nothing to review" over real changes) and the gap
// expansion (keyed by file and hunk index, so it would unfold another diff's gaps). The
// model reference is the subject: `DiffModel` has no id, and refs can repeat across content.

import { useCallback } from "react";

import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";

import type { DiffModel } from "../diff-model.js";
import { expandGap, type DiffGapExpansion } from "../row-model.js";

/**
 * The subject for a pane holding no diff. A module constant so every diff-less pass is one
 * subject and the seed does not re-run; a `DiffModel` is never equal to it.
 */
const NO_DIFF_SUBJECT: object = {};

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
 * Hold one diff's view state, and drop it when the diff changes. The indices `expandGapAt`
 * receives address `diff.files`, which stays correct beside a renderer that narrows rather
 * than filters.
 */
export function useDiffModelViewState(diff: DiffModel | undefined): DiffModelViewState {
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
      // Update against the held value, not an expansion read from this closure: two presses
      // settling in one tick would otherwise both grow the rendered map and lose the first.
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

/** The two pieces of view state one diff owns, held as one value. */
interface HeldDiffViewState {
  readonly selectedFilePath: string | undefined;
  readonly expansion: DiffGapExpansion;
}

/**
 * What a diff opens on: the whole change set with nothing unfolded, and what the pane
 * degrades to when the model moves.
 */
function unnarrowedDiffViewState(): HeldDiffViewState {
  return { selectedFilePath: undefined, expansion: new Map() };
}
