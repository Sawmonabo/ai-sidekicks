// The banner shape: across the frame, because what the whole room can do has changed. It adds
// whether a person can dismiss it, and it does not speak for itself.

import "./Refusal.css";

import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { Glyph } from "../Glyph/Glyph.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { type RefusalProps } from "./refusal-props.js";

/** Props for `RefusalBanner`. */
export interface RefusalBannerProps extends Omit<RefusalProps, "detail"> {
  /**
   * What happened: a daemon string, shown verbatim, or the app's own composed sentence. Wider
   * than the siblings' `string` because a composed sentence must be able to hold wire figures in
   * mono.
   */
  readonly detail: React.ReactNode;
  /** Omit to make the banner undismissable — it clears when the condition does. */
  readonly onDismiss?: () => void;
}

/** A refusal spanning the frame; dismissible only when `onDismiss` is given. */
export function RefusalBanner(props: RefusalBannerProps): React.JSX.Element {
  return (
    <div
      className="meridian-refusal meridian-refusal--banner"
      // Not a live region: the banner mounts already carrying its text, which most screen readers
      // never announce, and the frame announces every raise through the one `LiveAnnouncer`
      // (`layout/AppShell/hooks/useRefusalBannerAnnouncements.ts`). A `role="status"` would read
      // the sentence twice.
      role="group"
      data-refusal-code={props.code}
    >
      <Glyph name="alert" size={GLYPH_SIZE_CHROME} />
      <div className="meridian-refusal__body">
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
