// One change set on screen: the toolbar, the changed-file list and the rows. Split from
// `DiffPane.tsx` so the view-state hooks do not run for addresses that hold no diff.

import "./DiffChangeSet.css";

import { DiffFileList } from "./DiffFileList.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { DiffToolbar } from "./DiffToolbar.js";
import { useDiffViewControls } from "../hooks/useDiffViewControls.js";
import { type DiffModel } from "../model.js";
import { useDiffModelViewState } from "../hooks/useDiffModelViewState.js";

/** What one change set is drawn from. */
export interface DiffChangeSetProps {
  readonly diff: DiffModel;
}

/** The toolbar, changed-file list and rows of one diff, with the view state that diff owns. */
export function DiffChangeSet(props: DiffChangeSetProps): React.JSX.Element {
  const { diff } = props;
  const viewControls = useDiffViewControls();
  // The selected file and gap expansion belong to the model and are dropped with it, so a stale
  // selected path cannot narrow the rows to nothing. The split toggle is the pane's and is not
  // reset with them.
  const modelViewState = useDiffModelViewState(diff);

  return (
    // Its own column inside the chrome's body box: the toolbar, then the list-and-rows pair
    // filling the remaining height.
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
