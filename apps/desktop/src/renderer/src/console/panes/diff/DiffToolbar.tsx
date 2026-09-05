import { useCallback, useState } from "react";
import { type DiffViewMode } from "./diff-model.js";
import { DiffToggle } from "./DiffToggle.js";

/** What the four controls hold, and the four setters that move them. */
export interface DiffViewControls {
  readonly viewMode: DiffViewMode;
  readonly showAttributionMarks: boolean;
  readonly wrapLongLines: boolean;
  readonly showWhitespaceChanges: boolean;
  toggleViewMode(): void;
  toggleAttributionMarks(): void;
  toggleWrapLongLines(): void;
  toggleWhitespaceChanges(): void;
}

/** What a host may fix at mount. Everything omitted takes the reading default. */
export interface DiffViewControlDefaults {
  readonly viewMode?: DiffViewMode;
  readonly showAttributionMarks?: boolean;
  readonly wrapLongLines?: boolean;
  readonly showWhitespaceChanges?: boolean;
}

/**
 * Hold the four view controls.
 *
 * One `useState` per control rather than one object: each toggle then re-renders
 * on its own value, and a host that reads only `viewMode` is not re-rendered by a
 * wrap toggle. The object the hook returns is rebuilt each render, which is
 * correct — its consumers are the toolbar and the renderer, both of which re-read
 * every field anyway.
 */
export function useDiffViewControls(defaults: DiffViewControlDefaults = {}): DiffViewControls {
  const [viewMode, setViewMode] = useState<DiffViewMode>(defaults.viewMode ?? "unified");
  const [showAttributionMarks, setShowAttributionMarks] = useState(
    defaults.showAttributionMarks ?? false,
  );
  const [wrapLongLines, setWrapLongLines] = useState(defaults.wrapLongLines ?? false);
  const [showWhitespaceChanges, setShowWhitespaceChanges] = useState(
    defaults.showWhitespaceChanges ?? true,
  );

  const toggleViewMode = useCallback(() => {
    setViewMode((previous) => (previous === "unified" ? "split" : "unified"));
  }, []);
  const toggleAttributionMarks = useCallback(() => {
    setShowAttributionMarks((previous) => !previous);
  }, []);
  const toggleWrapLongLines = useCallback(() => {
    setWrapLongLines((previous) => !previous);
  }, []);
  const toggleWhitespaceChanges = useCallback(() => {
    setShowWhitespaceChanges((previous) => !previous);
  }, []);

  return {
    viewMode,
    showAttributionMarks,
    wrapLongLines,
    showWhitespaceChanges,
    toggleViewMode,
    toggleAttributionMarks,
    toggleWrapLongLines,
    toggleWhitespaceChanges,
  };
}

export interface DiffToolbarProps {
  readonly controls: DiffViewControls;
}

export function DiffToolbar(props: DiffToolbarProps): React.JSX.Element {
  const { controls } = props;
  return (
    <div className="meridian-diff-pane__toolbar" role="toolbar" aria-label="Diff view controls">
      <DiffToggle
        label={controls.viewMode === "split" ? "Split view" : "Unified view"}
        glyph="inspector"
        pressed={controls.viewMode === "split"}
        onToggle={controls.toggleViewMode}
      />
      <DiffToggle
        label="Attribution marks"
        glyph="agent"
        pressed={controls.showAttributionMarks}
        onToggle={controls.toggleAttributionMarks}
      />
      <DiffToggle
        label="Wrap long lines"
        glyph="timeline"
        pressed={controls.wrapLongLines}
        onToggle={controls.toggleWrapLongLines}
      />
      <DiffToggle
        label="Whitespace changes"
        glyph="dot"
        pressed={controls.showWhitespaceChanges}
        onToggle={controls.toggleWhitespaceChanges}
      />
    </div>
  );
}
