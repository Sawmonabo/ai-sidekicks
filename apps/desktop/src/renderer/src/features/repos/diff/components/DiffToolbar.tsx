import { type DiffViewControls } from "../hooks/useDiffViewControls.js";
import { DiffToggle } from "./DiffToggle.js";

/** What the toolbar is given: the view control it draws. */
export interface DiffToolbarProps {
  readonly controls: DiffViewControls;
}

/** The diff's toolbar: the split/unified view toggle. */
export function DiffToolbar(props: DiffToolbarProps): React.JSX.Element {
  const { controls } = props;
  return (
    <div className="meridian-diff-pane__toolbar" role="toolbar" aria-label="Diff view controls">
      <DiffToggle
        label={controls.viewMode === "split" ? "Split view" : "Unified view"}
        pressed={controls.viewMode === "split"}
        onToggle={controls.toggleViewMode}
      />
    </div>
  );
}
