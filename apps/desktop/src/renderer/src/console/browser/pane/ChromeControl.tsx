// One control in the browser pane's chrome.
//
// Its own module rather than a second component beside the pane body: the pane is a
// composition and this is a leaf, they change for different reasons, and the package
// binds one component per `.tsx`.

import { Glyph, type GlyphName } from "../../primitives/index.js";

/** The glyph size the chrome's controls share, so the row's baseline stays even. */
const CONTROL_GLYPH_SIZE = 13;

/**
 * One chrome control. `disabled` comes in from the view's REPORTED state and is never
 * computed here — 12.2: "The chrome never derives navigability." Absent state disables
 * the control, which is the fail-closed direction: an enabled control that cannot act
 * is a lie.
 *
 * The label is TEXT rather than an icon for the history controls, because the console's
 * closed glyph family carries no directional arrow and no reload mark, and inventing
 * one at a call site is what `tokens/glyphs.ts` exists to prevent.
 *
 * It wears the family's own `meridian-browser-action`, not a chrome-only button style:
 * three of these sit beside the settings page's and the cards', and a second button
 * shape for the same act is how two surfaces in one family stop looking like one.
 */
export function ChromeControl(props: {
  readonly label: string;
  /** `| undefined` explicitly: the reload/stop slot passes one arm without a glyph. */
  readonly glyph?: GlyphName | undefined;
  readonly disabled?: boolean;
  readonly onActivate: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="meridian-browser-action"
      disabled={props.disabled === true}
      onClick={props.onActivate}
    >
      {props.glyph === undefined ? null : <Glyph name={props.glyph} size={CONTROL_GLYPH_SIZE} />}
      {props.label}
    </button>
  );
}
