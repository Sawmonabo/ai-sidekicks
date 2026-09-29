import { GLYPH_SIZE_ROW } from "@renderer/styles/glyphs.js";
import { Glyph } from "@renderer/components/Glyph/Glyph.js";

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
      <Glyph name="inspector" size={GLYPH_SIZE_ROW} />
      {props.label}
    </button>
  );
}
