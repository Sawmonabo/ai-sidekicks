// One control in the Preview pane's chrome.

import "./AddressLineButton.css";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { GLYPH_SIZE_CHROME, type GlyphName } from "#renderer/styles/glyphs.js";

/**
 * One chrome control. `disabled` and `unavailableReason` come from the view's reported state and
 * are never computed here, so absent state disables the control (an enabled control that cannot
 * act is a lie). A control with a reason is grayed in place yet keeps focus, so its hover label
 * shows the reason, and a press changes nothing. The history controls use text labels because the
 * closed glyph set has no arrow or reload mark.
 */
export function AddressLineButton(props: {
  readonly label: string;
  /** `| undefined` explicitly: the shared reload/stop button passes one arm without a glyph. */
  readonly glyph?: GlyphName | undefined;
  readonly disabled?: boolean;
  /** Why the control cannot act now; set, it grays the control and labels it with these words. */
  readonly unavailableReason?: string | undefined;
  readonly onActivate: () => void;
}): React.JSX.Element {
  const isUnavailable = props.unavailableReason !== undefined;
  return (
    <HoverLabel text={props.unavailableReason} textRole="description">
      <button
        type="button"
        className="meridian-preview-action"
        disabled={props.disabled === true}
        aria-disabled={isUnavailable ? true : undefined}
        onClick={isUnavailable ? undefined : props.onActivate}
      >
        {props.glyph === undefined ? null : <Glyph name={props.glyph} size={GLYPH_SIZE_CHROME} />}
        {props.label}
      </button>
    </HoverLabel>
  );
}
