import { useEffect, useState } from "react";

import { useDeadlineWake } from "#renderer/hooks/useDeadlineWake.js";
import { MILLISECONDS_PER_SECOND, parseInstant } from "#renderer/lib/instant.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";

/**
 * How long a sign-in code has left, in milliseconds, counting down once a second and stopping at
 * zero; `undefined` when the provider gave no expiry or one this app cannot read. Only the next
 * two whole-second marks are ever armed, so a long-lived code holds one timer, not one per second.
 */
export function useSignInTimeLeft(expiresAt: string | undefined): number | undefined {
  const clock = useClock();
  const reading = expiresAt === undefined ? undefined : parseInstant(expiresAt);
  const expiresAtMilliseconds = reading?.kind === "instant" ? reading.epochMilliseconds : undefined;
  // The instant the marks are counted from: the first render's reading, then each wake-up's. Two
  // marks are armed because the wake-up returns the mark it crossed, and the next one must still
  // be ahead until the effect below moves the count on.
  const [marksFrom, setMarksFrom] = useState(() => clock.now());
  const instant = useDeadlineWake(
    clock,
    expiresAtMilliseconds === undefined ? [] : nextSecondMarks(expiresAtMilliseconds, marksFrom),
  );
  useEffect(() => {
    setMarksFrom(instant);
  }, [instant]);
  return expiresAtMilliseconds === undefined
    ? undefined
    : Math.max(0, expiresAtMilliseconds - instant);
}

/** The next two instants at which the whole seconds left drop by one, and the expiry itself. */
function nextSecondMarks(expiresAtMilliseconds: number, fromMilliseconds: number): number[] {
  const wholeSecondsLeft = Math.ceil(
    (expiresAtMilliseconds - fromMilliseconds) / MILLISECONDS_PER_SECOND,
  );
  if (wholeSecondsLeft <= 1) {
    return [expiresAtMilliseconds];
  }
  const nextMark = expiresAtMilliseconds - (wholeSecondsLeft - 1) * MILLISECONDS_PER_SECOND;
  return [nextMark, nextMark + MILLISECONDS_PER_SECOND, expiresAtMilliseconds];
}
