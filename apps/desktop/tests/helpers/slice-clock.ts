// The clock work done in slices reads to end each slice, set by a case for the rest of it, so the
// case reads the same however fast the machine running it is: every slice has time to finish its
// work, a slice ends when the case spends it, or every slice ends after its first piece.

import { onTestFinished, vi } from "vitest";

import { SLICE_MS } from "#renderer/lib/work-slices.js";

/** Stops the clock for the rest of the case, so every slice has time to finish its work. */
export function giveEverySliceTime(): void {
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  onTestFinished(() => {
    now.mockRestore();
  });
}

/**
 * Stops the clock for the rest of the case until the case spends the slice under way, and returns
 * what spends it: the clock moves a whole slice on, so the slice ends at its next check.
 */
export function stopSliceClock(): () => void {
  let elapsedMs = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  onTestFinished(() => {
    now.mockRestore();
  });
  return () => {
    elapsedMs += SLICE_MS;
  };
}

/**
 * Moves the clock a whole slice on at each reading for the rest of the case, so every slice ends
 * after its first piece of work.
 */
export function endEverySliceAtOnce(): void {
  let elapsedMs = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => (elapsedMs += SLICE_MS));
  onTestFinished(() => {
    now.mockRestore();
  });
}
