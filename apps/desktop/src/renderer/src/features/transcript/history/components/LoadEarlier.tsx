// The line at the top of the loaded history: `Load earlier` while the daemon holds rows before the
// head, `Couldn't load earlier messages · Try again` after a read of them failed, and nothing once
// the head is where the session's history starts. Nearing the top and a pull at the very top read
// the stretch on their own; the line is for the case they cannot see. Like `JumpToLatest.tsx` it
// sits outside the scroll container, so it never changes the height the reading position is
// measured against.

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { type TranscriptHistory } from "../hooks/useTranscriptHistory.js";

/** The words of the line after a read of earlier messages failed, before its `Try again`. */
const EARLIER_READ_FAILED_WORDS = "Couldn't load earlier messages";

/** The history whose head the line offers and whose stretch it asks for. */
export interface LoadEarlierProps {
  readonly history: TranscriptHistory;
}

/** The line at the top of the loaded history, or nothing once nothing lies before it. */
export function LoadEarlier(props: LoadEarlierProps): React.JSX.Element | null {
  const { history } = props;
  const { hasMore, isReading, hasFailed, failureCount } = history.state.earlier;
  // A failed read is sent again unchanged: the press asks the reader for the stretch it failed.
  const readEarlier = (): void => {
    history.readStretch("head");
  };
  if (hasFailed) {
    return (
      <div className="meridian-transcript-viewport__head">
        {/* `Try again` beside the failure is not read out. */}
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
      </div>
    );
  }
  if (!hasMore) {
    return null;
  }
  return (
    <div className="meridian-transcript-viewport__head">
      <button
        type="button"
        className="meridian-transcript-viewport__load-earlier"
        onClick={readEarlier}
        // Disabled while a stretch is read rather than hidden, so the line does not vanish under
        // the pointer that pressed it.
        disabled={isReading}
      >
        Load earlier
      </button>
    </div>
  );
}
