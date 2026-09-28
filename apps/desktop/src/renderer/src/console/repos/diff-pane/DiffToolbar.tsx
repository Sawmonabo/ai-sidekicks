import { useCallback, useState } from "react";
import { type DiffViewMode } from "./diff-model.js";
import { DiffToggle } from "./DiffToggle.js";

/** What the view control holds, and the setter that moves it. */
export interface DiffViewControls {
  readonly viewMode: DiffViewMode;
  toggleViewMode(): void;
}

export interface DiffToolbarProps {
  readonly controls: DiffViewControls;
}

/** Hold the split/unified view control. */
export function useDiffViewControls(): DiffViewControls {
  const [viewMode, setViewMode] = useState<DiffViewMode>("unified");

  const toggleViewMode = useCallback(() => {
    setViewMode((previous) => (previous === "unified" ? "split" : "unified"));
  }, []);

  return { viewMode, toggleViewMode };
}

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
