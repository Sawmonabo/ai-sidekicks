// One control in the browser pane's chrome.
//
// Its own module rather than a second component beside the pane body: the pane is a
// composition and this is a leaf, they change for different reasons, and the package
// binds one component per `.tsx`.

import { Glyph, type GlyphName } from "@renderer/console/primitives/index.js";

/** The glyph size the chrome's controls share, so the row's baseline stays even. */
const CONTROL_GLYPH_SIZE = 13;

/**
 * One chrome control. `disabled` comes in from the view's REPORTED state and is never
 * computed here: the chrome never derives navigability. Absent state disables the
 * control, which is the fail-closed direction: an enabled control that cannot act is a
 * lie.
 *
 * The label is TEXT rather than an icon for the history controls, because the console's
 * closed glyph set carries no directional arrow and no reload mark, and inventing
 * one at a call site is what `tokens/glyphs.ts` exists to prevent.
 *
 * It wears the preview feature's own `meridian-preview-action` rather than a chrome-only
 * button style, so the feature keeps one button shape.
 */
export function AddressLineButton(props: {
  readonly label: string;
  /** `| undefined` explicitly: the shared reload/stop button passes one arm without a glyph. */
  readonly glyph?: GlyphName | undefined;
  readonly disabled?: boolean;
  readonly onActivate: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="meridian-preview-action"
      disabled={props.disabled === true}
      onClick={props.onActivate}
    >
      {props.glyph === undefined ? null : <Glyph name={props.glyph} size={CONTROL_GLYPH_SIZE} />}
      {props.label}
    </button>
  );
}
