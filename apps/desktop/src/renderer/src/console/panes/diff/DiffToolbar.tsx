// The four renderer-local view controls, and the state they toggle.
//
// FOUR CONTROLS, ALL RENDERER-LOCAL, and this module is where that closed set is
// declared: attribution marks, view mode, wrap, and
// whitespace. Nothing here calls a wire, nothing here
// persists, and nothing here derives eligibility — a view control is available
// because the diff is on screen, which is a fact this component can see.
//
// THE HOOK AND THE COMPONENT SHIP TOGETHER because they are two halves of one
// seam: the hook owns the four values and the component renders exactly those
// four. Splitting them across modules would let a host construct the state and
// render a different set of controls over it, which is how a toolbar ends up
// with a toggle nothing reads.
//
// WHY THE DEFAULTS DIFFER BY HOST. THIS MODULE'S DENSITY RULE, which the two hosts
// read and neither restates: attribution marks are
// on by default in the pane and off by default in the timeline card, one toggle
// away in both — `Spec-023 §Meridian, the design language` rule 7's "secondary
// controls live one click away", spent on one control. So the hook takes its defaults
// from the host rather than fixing
// them — the card is a glance and the pane is a reading, and provenance marks
// earn their measure in the second and not the first.
//
// WHITESPACE IS A RENDER RULE, NOT A RE-COMPUTATION. Toggling it changes whether
// whitespace-only intraline segments are drawn as changed; it never re-runs a
// diff, because the console computes no diff (`diff-model.ts` says who does).

import { useCallback, useState } from "react";

import { Glyph } from "../../primitives/index.js";
import { type DiffViewMode } from "./diff-model.js";

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

/** Glyph edge length in the toolbar, matching the primitives' own inline size. */
const DIFF_TOOLBAR_GLYPH_SIZE = 12;

/**
 * One toggle.
 *
 * `aria-pressed` rather than a checkbox, because these are stateful buttons over
 * a view and not fields of a form; the label is real text beside the glyph rather
 * than a tooltip, so the control is named without hovering and reads at any
 * measure.
 */
function DiffToggle(props: {
  readonly label: string;
  readonly glyph: "inspector" | "agent" | "timeline" | "dot";
  readonly pressed: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="meridian-diff-pane__toggle"
      aria-pressed={props.pressed}
      onClick={props.onToggle}
    >
      <Glyph name={props.glyph} size={DIFF_TOOLBAR_GLYPH_SIZE} />
      {props.label}
    </button>
  );
}
