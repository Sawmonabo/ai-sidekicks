import { useEffect, useState } from "react";

import type { Clock } from "#renderer/lib/clock.js";

/**
 * `text` as it stood once the person paused typing for `pauseMs` on `clock`, so a read keyed on it
 * runs once per pause rather than once per keystroke. One timeout is armed at a time.
 */
export function useTypingPause(clock: Clock, text: string, pauseMs: number): string {
  const [pausedText, setPausedText] = useState(text);
  useEffect(() => {
    const handle = clock.scheduleTimeout(() => {
      setPausedText(text);
    }, pauseMs);
    return () => {
      clock.cancel(handle);
    };
  }, [clock, text, pauseMs]);
  return pausedText;
}
