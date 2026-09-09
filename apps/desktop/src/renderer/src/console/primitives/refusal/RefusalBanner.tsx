// The banner shape: across the frame, because what the whole room can do has changed.
//
// `refusal-contract.ts` states the grammar all three shapes obey and declares the
// props they share; this module decides only the two things that are the banner's
// own — whether a person can put it away, and that it does not speak for itself.

import { GLYPH_SIZE_CHROME } from "../../tokens/index.js";
import { Glyph, WireFigure, formatWireString } from "../figures/index.js";
import { type RefusalProps } from "./refusal-contract.js";

export interface RefusalBannerProps extends Omit<RefusalProps, "detail"> {
  /**
   * What happened, as text the daemon sent or as the console's own sentence.
   *
   * ONE SLOT, WIDENED — never a second one beside `detail`. `React.ReactNode` already
   * includes `string`, so every call site that hands over a daemon message is
   * unchanged and still goes through {@link formatWireString} below: the "message
   * verbatim" half of rule 9 is exactly as strong as it was.
   *
   * WIDENED ON THE BANNER AND ON NEITHER SIBLING, because the banner is the shape
   * whose message is routinely the CONSOLE's own composition rather than a daemon
   * string — the honest-chrome plane's four standing conditions are all authored here
   * — and rule 4 requires every wire figure inside such a sentence to wear the mono
   * provenance signature. A `string` made that unreachable: the only way to name a
   * protocol version or an attempt counter inside a sentence was to paste it into
   * proportional prose, which is what `frame/shell-state/shell-sentences.ts` was
   * doing. The inline and card shapes render a refusal somebody else wrote and keep
   * `RefusalProps` exactly as it is.
   */
  readonly detail: React.ReactNode;
  /** Omit to make the banner undismissable — it clears when the condition does. */
  readonly onDismiss?: () => void;
}

/** Across the frame, when what the whole room can do has changed. */
export function RefusalBanner(props: RefusalBannerProps): React.JSX.Element {
  return (
    <div
      className="meridian-refusal meridian-refusal--banner"
      // Not a live region. The banner is inserted already carrying its text, which
      // most screen readers never announce, and the frame announces every raise
      // through the one `LiveAnnouncer` (`frame/composition/banner-announcements.ts`). A
      // `role="status"` here would be a second, unreliable read of the same
      // sentence; the banner stays in the tree as a plain group carrying the code.
      role="group"
    >
      <Glyph name="alert" size={GLYPH_SIZE_CHROME} />
      <div className="meridian-refusal__body">
        <WireFigure value={props.code} />
        <span className="meridian-refusal__message">
          {typeof props.detail === "string" ? formatWireString(props.detail) : props.detail}
        </span>
      </div>
      {props.action !== undefined ? (
        <div className="meridian-refusal__action">{props.action}</div>
      ) : null}
      {props.onDismiss !== undefined ? (
        <button
          type="button"
          className="meridian-refusal__dismiss"
          onClick={props.onDismiss}
          aria-label="Dismiss this notice"
        >
          <Glyph name="close" size={GLYPH_SIZE_CHROME} />
        </button>
      ) : null}
    </div>
  );
}
