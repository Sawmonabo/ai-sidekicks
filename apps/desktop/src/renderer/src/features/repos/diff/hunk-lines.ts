// One hunk's body, read line by line: what each prefix means, where the numbering lands,
// and the `\ No newline at end of file` annotation. `patch-parse.ts` reads the patch's
// structure; this reads inside one hunk.

import { reportTripwire } from "@renderer/lib/tripwires.js";
import type { DiffLine, DiffLineKind } from "./diff-model.js";
import { wholeLineSegments } from "./diff-model.js";

/** What each prefix character in a hunk body means. Closed by the format itself. */
const LINE_KIND_BY_PREFIX: Readonly<Record<string, DiffLineKind>> = {
  " ": "context",
  "+": "insert",
  "-": "delete",
};

/** What a tripwire report from this module names as the site it fired at. */
const HUNK_LINES_SITE = "features/repos/diff/hunk-lines.ts";

/**
 * The prefix the unified format reserves for its one annotation. The prefix is read, not
 * the sentence after it, because producers may localize the text.
 */
const NO_NEWLINE_MARKER_PREFIX = "\\";

/**
 * Map one hunk's prefixed lines onto the model. The two counters advance independently: an
 * insert takes a head number only, a delete a base number only. A `\ No newline at end of
 * file` marker is not a row; it is carried onto the line above, since dropping it would lose
 * a change that only adds or removes the final newline (identical deleted and inserted text).
 */
export function hunkLines(
  prefixedLines: readonly string[],
  oldStart: number,
  newStart: number,
): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  let baseLineNumber = oldStart;
  let headLineNumber = newStart;
  for (const prefixedLine of prefixedLines) {
    if (prefixedLine.startsWith(NO_NEWLINE_MARKER_PREFIX)) {
      // Onto the line above; a marker that opens a hunk annotates nothing.
      const annotated = lines.at(-1);
      if (annotated !== undefined) {
        lines[lines.length - 1] = { ...annotated, noNewlineAtEnd: true };
      }
      continue;
    }
    // An empty line is a context line with empty text, the one body line with no prefix:
    // `parsePatch` pushes blank context lines raw (`""`). Dropping it would hide the blank
    // and stop both counters, leaving every later gutter number in the hunk one too low.
    const kind = prefixedLine === "" ? "context" : LINE_KIND_BY_PREFIX[prefixedLine.slice(0, 1)];
    if (kind === undefined) {
      // Every defined prefix is handled above, so this line carries something unplaceable;
      // dropping it silently would stop both counters and leave every later number wrong.
      reportTripwire(
        "wire-figure-formatting",
        HUNK_LINES_SITE,
        `a hunk body line carried the unrecognized prefix ${JSON.stringify(prefixedLine.slice(0, 1))}; it is not rendered and both line counters stop advancing at it, so every later number in this hunk is low`,
      );
      continue;
    }
    const text = prefixedLine.slice(1);
    // Spread rather than `: undefined`: under `exactOptionalPropertyTypes` an optional member
    // set to `undefined` is a different type from an absent one.
    lines.push({
      kind,
      ...(kind === "insert" ? {} : { baseLineNumber }),
      ...(kind === "delete" ? {} : { headLineNumber }),
      segments: wholeLineSegments(text),
    });
    if (kind !== "insert") {
      baseLineNumber += 1;
    }
    if (kind !== "delete") {
      headLineNumber += 1;
    }
  }
  return lines;
}
