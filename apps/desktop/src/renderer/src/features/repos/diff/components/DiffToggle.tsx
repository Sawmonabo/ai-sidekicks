import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";

/**
 * One toggle button. `aria-pressed` because it is stateful over a view, not a form field; the
 * text label means it is named without hovering.
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
