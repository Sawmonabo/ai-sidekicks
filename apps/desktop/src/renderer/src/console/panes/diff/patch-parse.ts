// The producer half of the diff family: unified patch text in, `ConsoleDiffModel`
// out, plus the intraline word diff every changed line pair is segmented by.
//
// `Spec-023 §Console Libraries`' Diff viewer row splits this surface in two and
// this file is the half it says to ADOPT: `diff` 9.0.0 (jsdiff, BSD-3-Clause) for
// "parse and intraline compute", against an OWN-BUILT virtualized row renderer for
// the pane and the inline card. So `parsePatch` and `diffWordsWithSpace` are called
// here and nowhere else in the console, and `DiffRows` / `hunk-virtualization.ts`
// stay first-party — the row renderer is the half the row says to own, because no
// candidate was both headless and virtualized.
//
// WHY A PARSER EXISTS BEFORE ITS WIRE DOES. `diff-model.ts`'s header records the
// obligation this file discharges: the model's `segments` arrive PRE-COMPUTED, and
// the module that turns a unified patch into one "lands with the first caller that
// has patch bytes to give it, in the PR that adds that dependency". The dependency
// is added here. The caller that hands it daemon bytes is `gitflow.diffArtifactCreate`,
// a `Plan-023 §Console growth slate` row (`gitflow-actions`, owned by Spec-011) that
// no namespace serves yet — so today the callers are `diff-fixture.ts`, which builds
// the surfaces' and the endurance tier's subjects THROUGH this module rather than
// beside it, and this module's own tests. That ordering is the point: when the wire
// lands it calls a parser the tiers have already been exercising, rather than a
// second one written to match them.
//
// WHAT A PATCH CANNOT SAY, AND WHICH THIS FILE THEREFORE DOES NOT INVENT.
//
//   • `DiffHunk.precedingContext` — the hidden context a gap row reveals — has no
//     representation in a unified patch at all: a patch's context lines are INSIDE
//     its hunks. A parsed hunk therefore carries an empty `precedingContext`, and a
//     caller that has the surrounding file supplies it. Synthesising one from the
//     hunk's own leading context would move lines a reader can already see into a
//     collapsed gap and claim the gap had revealed them.
//   • `DiffLine.agentAttribution` comes from the `Agent-Run:` and `Co-authored-by:`
//     trailers `Spec-011 §Required Behavior` names, which live on the COMMIT and not
//     in the patch body. This module reads none and guesses none.
//   • The attribution mode and the compared refs are the create call's own answer
//     (`Spec-011 §Interfaces And Contracts`), so they are parameters here rather than
//     anything scraped out of the patch's headers.
//
// AND ONE THING THE LIBRARY DROPS, WHICH THIS FILE THEREFORE READS ITSELF.
// `StructuredPatchHunk` carries four numbers and the body lines — and nothing else.
// The `@@` line a patch actually declares carries more than those four numbers: git
// appends the enclosing function or section after the closing `@@`, and a one-line
// range is spelled `-10` rather than `-10,1`. A header rebuilt from the numbers
// therefore lost the section context a reader navigates by and restated the range in
// a spelling the patch never used, which is not the wire-verbatim header the row kind
// promises. So the raw `@@` lines are read off the patch text in order and handed to
// the hunks in that order, and nothing here composes a header out of parts.

import { diffWordsWithSpace, parsePatch, type StructuredPatch } from "diff";

import type {
  ConsoleDiffModel,
  DiffAttribution,
  DiffFile,
  DiffIntralineSegment,
  DiffLine,
  DiffLineKind,
} from "./diff-model.js";

/** The compared states a create call named, carried onto the parsed model verbatim. */
export interface ComparedStates {
  readonly baseRef: string;
  readonly headRef: string;
}

/**
 * What a unified patch's own headers name a side of a file when there is no file
 * on that side. Both `diff` and `git` spell it this way.
 */
const ABSENT_FILE_NAME = "/dev/null";

/** The git prefixes `diff --git` puts on a path, which are the tool's and not the path's. */
const GIT_PATH_PREFIXES = ["a/", "b/"] as const;

/**
 * Turn unified patch text into the model both diff surfaces render.
 *
 * `parsePatch` handles the multi-file case, the git extended headers v9 added
 * (create / delete / rename / mode), and the malformed-input rejection this console
 * would otherwise have had to write and get wrong — which is the row's whole point.
 * Everything after it is mapping, and the mapping is the part that has to be exact:
 * a line's two numbers advance on DIFFERENT sides, and a renderer handed a base
 * number on an inserted line would display a line that does not exist in the base.
 */
export function parseUnifiedPatch(
  patchText: string,
  attribution: DiffAttribution,
  comparedStates: ComparedStates,
): ConsoleDiffModel {
  const files: DiffFile[] = [];
  // Read once for the whole patch, and consumed in the order `parsePatch` hands the
  // hunks back — both walks read the same text top to bottom, so the nth declared
  // header belongs to the nth parsed hunk across every file.
  const declaredHeaders = declaredHunkHeaders(patchText);
  let hunkOrdinal = 0;
  for (const structuredPatch of parsePatch(patchText)) {
    files.push({
      path: patchFilePath(structuredPatch),
      hunks: structuredPatch.hunks.map((hunk) => {
        const header = declaredHeaders[hunkOrdinal];
        hunkOrdinal += 1;
        if (header === undefined) {
          // Unreachable for any patch `parsePatch` accepted, and a throw rather than
          // a fallback because the only fallback is the reconstruction this function
          // exists to stop making: a header composed from the numbers would be
          // indistinguishable on screen from one the patch declared.
          throw new Error(
            `the patch declares fewer \`@@\` headers (${String(declaredHeaders.length)}) than it parsed hunks`,
          );
        }
        return {
          header,
          // Empty by construction, not by omission — see the header.
          precedingContext: [],
          lines: hunkLines(hunk.lines, hunk.oldStart, hunk.newStart),
        };
      }),
    });
  }
  return {
    attribution,
    baseRef: comparedStates.baseRef,
    headRef: comparedStates.headRef,
    files,
  };
}

/**
 * How a unified patch spells a hunk header, and where its verbatim part ends.
 *
 * The two ranges are matched so a body line can never be mistaken for a header —
 * every body line carries a ` `, `+`, or `-` prefix, so a deleted line reading
 * `-@@ -1 +1 @@` starts with the prefix and not with `@@`. Both line counts are
 * optional because a one-line range omits them, which is precisely the spelling a
 * reconstruction from the numbers used to overwrite. Nothing after the closing `@@`
 * is described here: it is the section context, it is free text, and it is kept.
 */
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * The line endings a patch may use, matched exactly as `diff` matches them.
 *
 * One expression rather than a `\n` split, because a patch produced on Windows ends
 * its header line with `\r` and a header carrying a stray carriage return is not the
 * header the patch declared.
 */
const PATCH_LINE_BREAK_PATTERN = /\r\n|[\n\v\f\r\u0085]/;

/**
 * Every `@@` header the patch text declares, in the order it declares them.
 *
 * Read off the RAW TEXT rather than off the parsed structure because the parsed
 * structure does not have them: `diff`'s `StructuredPatchHunk` is four numbers and
 * the body lines, and the section context git appends after the closing `@@` is
 * discarded before a caller ever sees the hunk. The header is carried verbatim,
 * trailing context included, which is what `DiffHunkHeaderRow` means by
 * wire-verbatim.
 */
function declaredHunkHeaders(patchText: string): readonly string[] {
  const headers: string[] = [];
  for (const line of patchText.split(PATCH_LINE_BREAK_PATTERN)) {
    if (HUNK_HEADER_PATTERN.test(line)) {
      headers.push(line);
    }
  }
  return headers;
}

/**
 * Segment one changed line pair at its word boundaries, for both sides at once.
 *
 * Both sides from ONE comparison rather than two, because the two sides of an
 * intraline diff are two readings of the same alignment: computing them separately
 * would let the deleted line's highlight disagree with the inserted line's about
 * which words survived, which is exactly the misreading the highlight exists to
 * prevent. `diffWordsWithSpace` rather than `diffWords` because it keeps whitespace
 * as part of the tokens, so a change in indentation stays visible instead of being
 * silently treated as no change.
 */
export function intralineSegments(previousText: string, nextText: string): IntralineSegmentPair {
  const changes = diffWordsWithSpace(previousText, nextText);
  return {
    deleted: mergeAdjacent(
      changes
        .filter((change) => change.added !== true)
        .map((change) => ({ text: change.value, changed: change.removed === true })),
    ),
    inserted: mergeAdjacent(
      changes
        .filter((change) => change.removed !== true)
        .map((change) => ({ text: change.value, changed: change.added === true })),
    ),
  };
}

/** One line pair's two segmentations, which are two readings of one alignment. */
export interface IntralineSegmentPair {
  readonly deleted: readonly DiffIntralineSegment[];
  readonly inserted: readonly DiffIntralineSegment[];
}

/** A line with no intraline change: one unchanged segment, which every consumer handles. */
export function wholeLineSegments(text: string): readonly DiffIntralineSegment[] {
  return [{ text, changed: false }];
}

/**
 * The path a parsed file is rendered under.
 *
 * The new side wins, because a rename's new name is where the file now is and a
 * reader looking for it will look there; the old side is taken only where there is
 * no new side, which is a deletion. The `a/` and `b/` prefixes are stripped ONLY on
 * a patch that declared itself git-style, because on such a patch they are the
 * tool's own decoration — and on any other patch a leading `b/` is part of the path
 * and stripping it would re-root a file, which `diff-model.ts` forbids outright.
 */
function patchFilePath(structuredPatch: StructuredPatch): string {
  const newFileName = structuredPatch.newFileName ?? ABSENT_FILE_NAME;
  const named = newFileName === ABSENT_FILE_NAME ? structuredPatch.oldFileName : newFileName;
  const path = named ?? ABSENT_FILE_NAME;
  if (structuredPatch.isGit !== true) {
    return path;
  }
  for (const prefix of GIT_PATH_PREFIXES) {
    if (path.startsWith(prefix)) {
      return path.slice(prefix.length);
    }
  }
  return path;
}

/** What each prefix character in a hunk body means. Closed by the format itself. */
const LINE_KIND_BY_PREFIX: Readonly<Record<string, DiffLineKind>> = {
  " ": "context",
  "+": "insert",
  "-": "delete",
};

/**
 * Map one hunk's prefixed lines onto the model, numbering both sides as it goes.
 *
 * The two counters advance independently — an inserted line consumes a head number
 * and no base number, a deleted line the reverse — which is the arithmetic a
 * hand-built fixture is most likely to get wrong by advancing both in lockstep.
 *
 * A `\ No newline at end of file` marker carries no prefix this map knows and is
 * skipped: it annotates the line above it rather than being a line of its own, and
 * a row drawn for it would be a row the file does not have.
 */
function hunkLines(
  prefixedLines: readonly string[],
  oldStart: number,
  newStart: number,
): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  let baseLineNumber = oldStart;
  let headLineNumber = newStart;
  for (const prefixedLine of prefixedLines) {
    const kind = LINE_KIND_BY_PREFIX[prefixedLine.slice(0, 1)];
    if (kind === undefined) {
      continue;
    }
    const text = prefixedLine.slice(1);
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
  return segmentChangedRuns(lines);
}

/**
 * Give every deleted line that has an inserted counterpart its word-level segments.
 *
 * A unified patch expresses a modified line as a delete run immediately followed by
 * an insert run, so the counterpart of the nth deletion is the nth insertion of the
 * run that follows it. Pairing by ORDINAL WITHIN THE RUN rather than by content
 * similarity is deliberate: similarity scoring would re-pair lines the producer had
 * already paired, and a diff whose highlight disagreed with its own line order is
 * harder to read than one with no highlight at all. Where the runs are unequal
 * lengths the surplus lines keep their whole-line segment, which reads as a plain
 * addition or removal — which is what an unpaired line is.
 */
function segmentChangedRuns(lines: readonly DiffLine[]): readonly DiffLine[] {
  const segmented = [...lines];
  let index = 0;
  while (index < segmented.length) {
    const deleteRunStart = index;
    while (segmented[index]?.kind === "delete") {
      index += 1;
    }
    const deleteRunLength = index - deleteRunStart;
    const insertRunStart = index;
    while (segmented[index]?.kind === "insert") {
      index += 1;
    }
    const insertRunLength = index - insertRunStart;
    if (deleteRunLength === 0 || insertRunLength === 0) {
      // No pair here. Advance past whatever this line was, or the loop stands still
      // on a context line forever.
      index = Math.max(index, deleteRunStart + 1);
      continue;
    }
    const pairCount = Math.min(deleteRunLength, insertRunLength);
    for (let pair = 0; pair < pairCount; pair += 1) {
      const deletedLine = segmented[deleteRunStart + pair];
      const insertedLine = segmented[insertRunStart + pair];
      if (deletedLine === undefined || insertedLine === undefined) {
        continue;
      }
      const pairSegments = intralineSegments(lineText(deletedLine), lineText(insertedLine));
      segmented[deleteRunStart + pair] = { ...deletedLine, segments: pairSegments.deleted };
      segmented[insertRunStart + pair] = { ...insertedLine, segments: pairSegments.inserted };
    }
  }
  return segmented;
}

/** One line's text as this module built it: one whole-line segment, before pairing. */
function lineText(line: DiffLine): string {
  return line.segments.map((segment) => segment.text).join("");
}

/**
 * Fold neighbouring segments that carry the same verdict into one.
 *
 * Filtering one side out of a word diff leaves runs that were separated only by the
 * other side's tokens, and a model that carried them separately would make an
 * unchanged line a list of segments rather than the single one `diff-model.ts` says
 * every consumer may rely on. Empty values are dropped for the same reason: a
 * zero-length segment is a span a renderer would open and close around nothing.
 */
function mergeAdjacent(segments: readonly DiffIntralineSegment[]): readonly DiffIntralineSegment[] {
  const merged: DiffIntralineSegment[] = [];
  for (const segment of segments) {
    if (segment.text === "") {
      continue;
    }
    const previous = merged.at(-1);
    if (previous !== undefined && previous.changed === segment.changed) {
      merged[merged.length - 1] = { text: previous.text + segment.text, changed: previous.changed };
      continue;
    }
    merged.push(segment);
  }
  return merged.length === 0 ? wholeLineSegments("") : merged;
}
