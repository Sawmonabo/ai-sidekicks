import { useEffect, useRef, useState } from "react";

import { type Clock } from "#renderer/lib/clock.js";

/**
 * How long the window has to be behind before the catching-up line appears, and how long
 * the line holds its words. One figure for both, so a quick repair shows nothing and a line
 * that appears never flickers.
 */
export const CATCH_UP_LINE_DWELL_MS = 400;

/** What the catching-up line says: `Catching up…` or `Couldn't catch up · Try again`. */
export type CatchUpWords = "catching-up" | "could-not-catch-up";

/**
 * The words the catching-up line shows, or nothing while it is down.
 *
 * It goes up once the window has been behind for the dwell, with the words standing at
 * that moment. From then on it holds those words for the dwell: a change inside the hold,
 * to other words or to caught up, waits for the hold to end and applies only if it still
 * stands then, and new words hold for the dwell in turn. Each edge arms one timeout on
 * the window's clock and nothing re-arms while the line holds still, so nothing polls.
 */
export function useCatchUpLineWords(
  words: CatchUpWords | undefined,
  clock: Clock,
): CatchUpWords | undefined {
  const [shown, setShown] = useState<ShownWords | undefined>(undefined);
  // The words standing now, read by the timeout that puts the line up: the delay runs from
  // when the window fell behind, so a change of words during it must not re-arm it.
  const standingWords = useRef(words);
  useEffect(() => {
    standingWords.current = words;
  }, [words]);

  const isBehind = words !== undefined;
  const isShown = shown !== undefined;
  useEffect(() => {
    if (!isBehind || isShown) {
      return undefined;
    }
    const handle = clock.scheduleTimeout(() => {
      const wordsWhenShown = standingWords.current;
      if (wordsWhenShown !== undefined) {
        setShown({ sinceMilliseconds: clock.now(), words: wordsWhenShown });
      }
    }, CATCH_UP_LINE_DWELL_MS);
    return () => {
      clock.cancel(handle);
    };
  }, [isBehind, isShown, clock]);

  useEffect(() => {
    if (shown === undefined || words === shown.words) {
      return undefined;
    }
    const handle = clock.scheduleTimeout(
      () => {
        setShown(words === undefined ? undefined : { sinceMilliseconds: clock.now(), words });
      },
      Math.max(0, shown.sinceMilliseconds + CATCH_UP_LINE_DWELL_MS - clock.now()),
    );
    return () => {
      clock.cancel(handle);
    };
  }, [words, shown, clock]);

  return shown?.words;
}

interface ShownWords {
  readonly sinceMilliseconds: number;
  readonly words: CatchUpWords;
}
