import { Glyph } from "../../primitives/index.js";

/**
 * One toggle.
 *
 * `aria-pressed` rather than a checkbox, because these are stateful buttons over
 * a view and not fields of a form; the label is real text beside the glyph rather
 * than a tooltip, so the control is named without hovering and reads at any
 * measure.
 */
export function DiffToggle(props: {
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

/** Glyph edge length in the toolbar, matching the primitives' own inline size. */
export const DIFF_TOOLBAR_GLYPH_SIZE = 12;
