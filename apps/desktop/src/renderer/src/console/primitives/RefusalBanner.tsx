// The banner shape: across the frame, because what the whole room can do has changed.
//
// `refusal-contract.ts` states the grammar all three shapes obey and declares the
// props they share; this module decides only the two things that are the banner's
// own — whether a person can put it away, and that it does not speak for itself.

import { GLYPH_SIZE_CHROME } from "../tokens/index.js";
import { Glyph } from "./Glyph.js";
import { type RefusalProps } from "./refusal-contract.js";
import { WireFigure } from "./WireFigure.js";
import { formatWireString } from "./wire-figures.js";

export interface RefusalBannerProps extends RefusalProps {
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
      // through the one `LiveAnnouncer` (`frame/banner-announcements.ts`). A
      // `role="status"` here would be a second, unreliable read of the same
      // sentence; the banner stays in the tree as a plain group carrying the code.
      role="group"
    >
      <Glyph name="alert" size={GLYPH_SIZE_CHROME} />
      <div className="meridian-refusal__body">
        <WireFigure value={props.code} />
        <span className="meridian-refusal__message">{formatWireString(props.detail)}</span>
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
