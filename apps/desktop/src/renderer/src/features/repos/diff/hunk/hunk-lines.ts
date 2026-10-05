// One hunk's body, read line by line: what each prefix means, where the numbering lands,
// and the `\ No newline at end of file` annotation. `patch-parse.ts` reads the patch's
// structure; this reads inside one hunk.

import { RealClock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/diagnostic-capture.js";
import type { DiffLine, DiffLineKind } from "../diff-model.js";
import { wholeLineSegments } from "../diff-model.js";

/** What each prefix character in a hunk body means. Closed by the format itself. */
const LINE_KIND_BY_PREFIX: Readonly<Record<string, DiffLineKind>> = {
  " ": "context",
  "+": "insert",
  "-": "delete",
};

/** The source a diagnostic record from this module carries. */
const HUNK_LINES_SOURCE = "features/repos/diff/hunk/hunk-lines";

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
    const kind = prefixedLine === "" ? "context" : lineKindOf(prefixedLine);
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

/**
 * The line's kind by its prefix. The patch comes from git through the daemon, so a prefix no kind
 * has is outside input: it is recorded and the line drawn as unchanged, which keeps it visible and
 * keeps both counters advancing.
 */
function lineKindOf(prefixedLine: string): DiffLineKind {
  const prefix = prefixedLine.slice(0, 1);
  const kind = LINE_KIND_BY_PREFIX[prefix];
  if (kind !== undefined) {
    return kind;
  }
  windowDiagnosticCapture.record({
    at: diagnosticStampAt(new RealClock()),
    severity: "warning",
    source: HUNK_LINES_SOURCE,
    kind: "unknown-hunk-prefix",
    detail:
      `a hunk body line carried the prefix ${JSON.stringify(prefix)}; ` +
      "drawn as an unchanged line",
  });
  return "context";
}
