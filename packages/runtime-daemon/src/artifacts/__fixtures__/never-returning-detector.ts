// A detector stuck in a loop, as a parser handed a malformed payload can be: it never returns and
// never yields, so only terminating the thread it runs on stops it. The type detection thread loads
// it by URL in place of the real detector.

/** Never returns. */
export function detectMediaType(): Promise<string | undefined> {
  for (;;) {
    // Spins without yielding.
  }
}

/** This module's URL, which the detection thread is handed. */
export const NEVER_RETURNING_DETECTOR_URL: URL = new URL(import.meta.url);
