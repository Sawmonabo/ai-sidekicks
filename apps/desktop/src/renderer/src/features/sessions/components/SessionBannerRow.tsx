// One banner under the session header, in the header's banner shape: a sunken strip of
// muted words parted by ` · `, and the × that puts it away at its right end.

import { Fragment } from "react";

import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_CHROME } from "@renderer/styles/glyphs.js";
import { sessionBannerKey, type SessionBanner } from "../session-banners.js";

/** One banner row, dismissed by the key the column holds it under. */
export function SessionBannerRow(props: {
  readonly banner: SessionBanner;
  readonly onDismiss: (key: string) => void;
}): React.JSX.Element {
  return (
    <div className="meridian-session-screen__banner" role="status">
      {props.banner.words.map((part, index) => (
        <Fragment key={part}>
          {index > 0 ? (
            <span className="meridian-session-screen__banner-separator" aria-hidden="true">
              ·
            </span>
          ) : null}
          <span>{part}</span>
        </Fragment>
      ))}
      <button
        type="button"
        className="meridian-session-screen__banner-dismiss"
        aria-label="Dismiss this notice"
        onClick={() => {
          props.onDismiss(sessionBannerKey(props.banner));
        }}
      >
        <Glyph name="close" size={GLYPH_SIZE_CHROME} />
      </button>
    </div>
  );
}
