// One banner under the session header, in the header's banner shape: a sunken strip of muted
// words parted by ` · `, the banner's one act where it has one, and the × that puts it away at its
// right end where it can be put away. A refused act says so beside its word, and the word can be
// pressed again.

import { Fragment, useState } from "react";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";

/**
 * A banner's one act: its word, and the press, which settles to the line its refusal draws beside
 * the word, or `undefined` when it went through.
 */
export interface SessionBannerAct {
  readonly label: string;
  readonly press: () => Promise<string | undefined>;
}

/** One banner row: its words in reading order, its act, and its ×, each where it has one. */
export function SessionBannerRow(props: {
  readonly words: readonly string[];
  readonly act?: SessionBannerAct;
  readonly onDismiss?: () => void;
}): React.JSX.Element {
  const [isActing, setIsActing] = useState(false);
  // Held in an object, so a press refused again in the same words is a new attempt, said again.
  const [refusal, setRefusal] = useState<{ readonly line: string } | undefined>(undefined);
  useAnnounceWhenChanged(refusal?.line, "assertive", { attempt: refusal });
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
              void act.press().then((line) => {
                setRefusal(line === undefined ? undefined : { line });
                setIsActing(false);
              });
            }}
          >
            {act.label}
          </button>
          {refusal === undefined ? null : (
            <span className="meridian-session-screen__banner-refusal">{refusal.line}</span>
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
