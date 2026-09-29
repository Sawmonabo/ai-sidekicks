// One change set on screen: the toolbar, the changed-file list, and the rows.
//
// SPLIT OUT OF `DiffPane.tsx` because only a change set needs the view state it is read
// with. Left in the pane, its hooks would have run on every address the pane opens at,
// including the ones that hold no diff.
//
// THE TWO HOOKS ARE THE MODEL'S AND NOT THE PANE'S, which is why they live with this
// body: both are scoped to the change set being rendered, and both drop what they hold
// when the diff does.

import { DiffFileList } from "./DiffFileList.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { DiffToolbar, useDiffViewControls } from "@renderer/console/repos/diff-pane/DiffToolbar.js";
import { type ConsoleDiffModel } from "../diff-model.js";
import { useDiffModelViewState } from "../hooks/useDiffModelViewState.js";

export interface DiffChangeSetProps {
  readonly diff: ConsoleDiffModel;
}

export function DiffChangeSet(props: DiffChangeSetProps): React.JSX.Element {
  const { diff } = props;
  const viewControls = useDiffViewControls();
  // This pane's own density: it opens on the changed-file list with the first
  // file expanded. Selecting a file narrows the rows to it; selecting none reads
  // the whole change set, which is what "the first file expanded" degrades to
  // once a reader has scrolled past it.
  //
  // BOTH PIECES ARE THE MODEL'S AND NOT THE PANE'S, so they live in a hook that
  // drops them when the diff does — a selected path the next diff does not
  // contain would narrow the rows to nothing, and the renderer would report two
  // identical states over a change set that has changes. The toolbar's split toggle
  // is the pane's and is deliberately not reset with them.
  const modelViewState = useDiffModelViewState(diff);

  return (
    // A column of its own inside the chrome's body box, because the body scrolls as one
    // and this surface has two bands: the toolbar, and the list-and-rows pair that takes
    // the rest of the height.
    <div className="meridian-diff-pane">
      <DiffToolbar controls={viewControls} />
      <div className="meridian-diff-pane__content">
        <DiffFileList
          diff={diff}
          selectedFilePath={modelViewState.selectedFilePath}
          onSelectFilePath={modelViewState.selectFilePath}
        />
        <DiffRenderer
          model={diff}
          shownFilePath={modelViewState.selectedFilePath}
          viewMode={viewControls.viewMode}
          expansion={modelViewState.expansion}
          onExpandGap={modelViewState.expandGapAt}
          label={`Diff, ${diff.baseRef} to ${diff.headRef}`}
        />
      </div>
    </div>
  );
}
