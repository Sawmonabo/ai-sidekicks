// The line at the top of the loaded history: `Load earlier` while the daemon holds rows before the
// head, `Loading…` while they are read, `Couldn't load earlier messages · Try again` after a read
// of them failed, `Message not found` once a linked message's reading back reached the start of
// history without it, and nothing else once the head is where the session's history starts.
// Nearing the top and a pull at the very top read the stretch on their own; the line is for the
// case they cannot see. The viewport draws it above the first row and holds the reader's row as
// its height changes.

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import { type TranscriptHistory } from "../hooks/useTranscriptHistory.js";

/** The words of the line after a read of earlier messages failed, before its `Try again`. */
const EARLIER_READ_FAILED_WORDS = "Couldn't load earlier messages";

/** The words of the line while a stretch of earlier messages is read. */
const READING_WORDS = "Loading…";

/** The words of the line once a linked message is nowhere in the session's history. */
const MESSAGE_NOT_FOUND_WORDS = "Message not found";

/** The history whose head the line offers and whose stretch it asks for. */
export interface LoadEarlierProps {
  readonly history: TranscriptHistory;
  /** Whether a link named a message the whole history, read back to its start, does not hold. */
  readonly isLinkedMessageMissing: boolean;
}

/** The line at the top of the loaded history, or nothing once nothing lies before it. */
export function LoadEarlier(props: LoadEarlierProps): React.JSX.Element | null {
  const { history } = props;
  const { hasMore, isReading, hasFailed, failureCount } = history.state.earlier;
  // Said each time a read starts: between reads the line reports nothing, so the same words that
  // come back with the next read are news again.
  useAnnounceWhenChanged(isReading ? READING_WORDS : null, "polite");
  // A failed read is sent again unchanged: the press asks the reader for the stretch it failed.
  // A press while a stretch is read asks for nothing.
  const readEarlier = (): void => {
    if (!isReading) {
      history.readStretch("head");
    }
  };
  if (props.isLinkedMessageMissing) {
    // Said once, when the reading back ends without the message; the page stays where it is.
    return (
      <AnnouncedLine
        element="p"
        className="meridian-transcript-viewport__message-not-found"
        words={MESSAGE_NOT_FOUND_WORDS}
        politeness="polite"
      >
        {MESSAGE_NOT_FOUND_WORDS}
      </AnnouncedLine>
    );
  }
  if (hasFailed) {
    return (
      // `Try again` beside the failure is not read out.
      <AnnouncedLine
        element="p"
        className="meridian-transcript-viewport__load-earlier-failed"
        words={EARLIER_READ_FAILED_WORDS}
        politeness="assertive"
        // A `Try again` that fails again leaves these words standing; each failure is said.
        attempt={failureCount}
      >
        {`${EARLIER_READ_FAILED_WORDS} · `}
        <TryAgainButton onPress={readEarlier} />
      </AnnouncedLine>
    );
  }
  if (!hasMore) {
    return null;
  }
  return (
    <button
      type="button"
      className="meridian-transcript-viewport__load-earlier meridian-clickable-word"
      onClick={readEarlier}
      // While a stretch is read the line says so in its own place, disabled rather than hidden,
      // so it does not vanish under the pointer that pressed it, and `aria-disabled` rather than
      // `disabled`, so the focus a keyboard press left on it stays.
      aria-disabled={isReading}
    >
      {isReading ? READING_WORDS : "Load earlier"}
    </button>
  );
}
