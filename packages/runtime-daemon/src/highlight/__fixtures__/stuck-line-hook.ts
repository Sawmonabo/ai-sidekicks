// A line the tokenizer never finishes, as a regex caught in runaway backtracking never returns: the
// hook spins without yielding on a line that holds the marker, so only ending the thread stops it.
// The tokenizing thread loads it by URL and runs it before each line.

/** What a line holds to hold the thread. */
export const STUCK_LINE_MARKER = "__stuck_line__";

/** Never returns on a line that holds `STUCK_LINE_MARKER`. */
export function beforeLine(line: string): void {
  while (line.includes(STUCK_LINE_MARKER)) {
    // Spins without yielding.
  }
}

/** This module's URL, which the tokenizing thread is handed. */
export const STUCK_LINE_HOOK_URL: URL = new URL(import.meta.url);
