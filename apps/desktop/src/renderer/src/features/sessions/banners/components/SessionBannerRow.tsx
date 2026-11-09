// One banner under the session header, in the header's banner shape: a sunken strip of muted
// words parted by ` · `, the banner's one act where it has one, and the × that puts it away at its
// right end where it can be put away. A refused act says so beside its word, and the word can be
// pressed again.

import { Fragment, useState } from "react";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { useAnnounceBannerRefusal } from "#renderer/hooks/announce/useAnnounceBannerRefusal.js";
import { refusalSentence } from "#renderer/lib/code-words.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";

/** A banner's one act: its word, and the press, which settles to a refusal when it was refused. */
export interface SessionBannerAct {
  readonly label: string;
  readonly press: () => Promise<ExtendedRefusal | undefined>;
}

/** One banner row: its words in reading order, its act, and its ×, each where it has one. */
export function SessionBannerRow(props: {
  readonly words: readonly string[];
  readonly act?: SessionBannerAct;
  readonly onDismiss?: () => void;
}): React.JSX.Element {
  const [isActing, setIsActing] = useState(false);
  const [refusal, setRefusal] = useState<ExtendedRefusal | undefined>(undefined);
  useAnnounceBannerRefusal(refusal);
  const { act, onDismiss } = props;

  return (
    <AnnouncedLine
      element="div"
      className="meridian-session-screen__banner"
      words={props.words.join(", ")}
      // A banner reports a condition the person has to know about now.
      politeness="assertive"
    >
      {props.words.map((part, index) => (
        <Fragment key={part}>
          {index > 0 ? (
            <span className="meridian-session-screen__banner-separator" aria-hidden="true">
              ·
            </span>
          ) : null}
          <span>{part}</span>
        </Fragment>
      ))}
      {act === undefined ? null : (
        <>
          <span className="meridian-session-screen__banner-separator" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            className="meridian-link-button"
            // One press is one act: a second press while the first is out would send it twice.
            disabled={isActing}
            onClick={() => {
              setIsActing(true);
              setRefusal(undefined);
              void act.press().then((settled) => {
                setRefusal(settled);
                setIsActing(false);
              });
            }}
          >
            {act.label}
          </button>
          {refusal === undefined ? null : (
            <span className="meridian-session-screen__banner-refusal">
              {refusalSentence(refusal.code, refusal.reason, formatWireString(refusal.detail))}
            </span>
          )}
        </>
      )}
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="meridian-session-screen__banner-dismiss"
          aria-label="Dismiss this notice"
          onClick={onDismiss}
        >
          <Glyph name="close" size={GLYPH_SIZE_CHROME} />
        </button>
      )}
    </AnnouncedLine>
  );
}
