// One control in the Preview pane's chrome.

import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_CHROME, type GlyphName } from "@renderer/styles/glyphs.js";

/**
 * One chrome control. `disabled` comes from the view's reported state and is never computed
 * here, so absent state disables the control (an enabled control that cannot act is a lie).
 * The history controls use text labels because the closed glyph set has no arrow or reload mark.
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
      {props.glyph === undefined ? null : <Glyph name={props.glyph} size={GLYPH_SIZE_CHROME} />}
      {props.label}
    </button>
  );
}
