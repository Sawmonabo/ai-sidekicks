// The round Send the composer and the steer box both draw: the one filled control on its card,
// an arrow on the accent, named `Send` whatever it is doing, and dimmed while it has nothing to
// send.

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { GLYPH_SIZE_CHROME, GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";

import "./SendIconButton.css";

/** How large the circle is drawn: `regular` on the composer, `compact` in a narrow pane. */
export type SendIconButtonSize = "regular" | "compact";

/** Props for `SendIconButton`. */
export interface SendIconButtonProps {
  /** `submit` inside a form whose submit handler sends; `button` with `onPress`. */
  readonly type: "button" | "submit";
  readonly size: SendIconButtonSize;
  /** Dims the circle while the message holds nothing; the press stays live. */
  readonly isEmpty: boolean;
  /** Latches the press while a send is already going. */
  readonly isSending: boolean;
  readonly onPress?: () => void;
}

/** One Send press: a filled circle with an up arrow, named `Send` in every state. */
export function SendIconButton(props: SendIconButtonProps): React.JSX.Element {
  return (
    <HoverLabel text="Send" textRole="name">
      <button
        type={props.type}
        className={
          `meridian-composer__send-icon meridian-composer__send-icon--${props.size} ` +
          "meridian-accent-fill"
        }
        aria-busy={props.isSending}
        disabled={props.isSending}
        data-empty={props.isEmpty ? "" : undefined}
        onClick={props.onPress}
      >
        <Glyph
          name="arrow-up"
          size={props.size === "regular" ? GLYPH_SIZE_CHROME : GLYPH_SIZE_ROW}
        />
      </button>
    </HoverLabel>
  );
}
