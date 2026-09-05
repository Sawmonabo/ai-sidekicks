// One hunk's body, read line by line: what each prefix means, where the numbering
// lands, and the one annotation the format reserves.
//
// A SECOND LEVEL OF THE SAME READER, AND THAT IS THE SEAM. `patch-parse.ts` reads a
// patch's STRUCTURE — which files it touches, what each one's compared states are,
// where its hunks start. This module reads what is INSIDE one hunk, which is a
// different question with its own vocabulary: prefix characters, two independent line
// counters, and `\ No newline at end of file`. The two levels were one module and the
// file was the family's longest; nothing but length said they were one subject.
//
// IT STAYS ON THE PARSE SIDE OF `Spec-023 §Console Libraries`' seam. The library's
// `parsePatch` hands over hunk bodies as prefixed strings and this is what reads them,
// so no library boundary is crossed here — the split is inside the parse half.

import { reportTripwire } from "../../core/index.js";
import type { DiffLine, DiffLineKind } from "./diff-model.js";
import { wholeLineSegments } from "./diff-model.js";

/** What each prefix character in a hunk body means. Closed by the format itself. */
const LINE_KIND_BY_PREFIX: Readonly<Record<string, DiffLineKind>> = {
  " ": "context",
  "+": "insert",
  "-": "delete",
};

/** What a tripwire report from this module names as the site it fired at. */
const HUNK_LINES_SITE = "console/repos/diff-pane/hunk-lines.ts";

/**
 * The prefix the unified format reserves for its one annotation.
 *
 * `\ No newline at end of file` is the only thing a `\` line has ever meant in a
 * unified patch, so the PREFIX is what this reads rather than the sentence after it:
 * the text is a producer's, it is localised by some of them, and a console matching
 * on English words would drop the annotation for exactly the patches it did not
 * write. Anything else the prefix could later carry is still an annotation of the
 * line above it, which is the fact this file records.
 */
const NO_NEWLINE_MARKER_PREFIX = "\\";

/**
 * Map one hunk's prefixed lines onto the model, numbering both sides as it goes.
 *
 * The two counters advance independently — an inserted line consumes a head number
 * and no base number, a deleted line the reverse — which is the arithmetic a
 * hand-built fixture is most likely to get wrong by advancing both in lockstep.
 *
 * A `\ No newline at end of file` marker is still not a row — it annotates the line
 * above it, and a row drawn for it would be a row the file does not have — but it is
 * no longer DISCARDED. It was, and that lost the whole content of one class of change:
 * a patch that only adds or removes a terminating newline spells it as a deletion and
 * an insertion whose text is identical, so both surfaces drew two indistinguishable
 * lines and the marker that said which was which had been thrown away. It is carried
 * onto the line it annotates, which is the one immediately before it.
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
      // Onto the line above, and onto nothing at all where the marker opens a hunk —
      // which no producer writes, and which a console must not read as an annotation
      // of whatever line comes next.
      const annotated = lines.at(-1);
      if (annotated !== undefined) {
        lines[lines.length - 1] = { ...annotated, noNewlineAtEnd: true };
      }
      continue;
    }
    // AN EMPTY LINE IS A CONTEXT LINE WHOSE TEXT IS EMPTY, and it is the one body
    // line that carries no prefix at all: many producers write a blank context line
    // bare, and `parsePatch` infers it as context and pushes it RAW (`""`). Read
    // through the prefix table that is `undefined`, and the `continue` below dropped
    // it — so the blank vanished from the rendering AND both counters stopped
    // advancing, putting every later gutter number in that hunk one too low. A number
    // beside the wrong line is the misreported figure, not the missing row.
    const kind = prefixedLine === "" ? "context" : LINE_KIND_BY_PREFIX[prefixedLine.slice(0, 1)];
    if (kind === undefined) {
      // LOUD, NOT SWALLOWED. Every prefix the format defines is handled above, so
      // reaching here means the body carried something this parser cannot place — and
      // dropping it silently costs the same two counters the empty line used to, with
      // a shorter hunk on screen and nothing anywhere saying why. Under the figure
      // kind on `attachment-ingest-acknowledgement.ts`'s precedent: what breaks is
      // every line number after this one, not the render.
      reportTripwire(
        "wire-figure-formatting",
        HUNK_LINES_SITE,
        `a hunk body line carried the unrecognised prefix ${JSON.stringify(prefixedLine.slice(0, 1))}; it is not rendered and both line counters stop advancing at it, so every later number in this hunk is low`,
      );
      continue;
    }
    const text = prefixedLine === "" ? "" : prefixedLine.slice(1);
    // Spread-in rather than `: undefined`, for `diff-fixture.ts`'s reason: under
    // `exactOptionalPropertyTypes` an optional member assigned `undefined` is a
    // different type from an absent one, and the model means the second.
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
