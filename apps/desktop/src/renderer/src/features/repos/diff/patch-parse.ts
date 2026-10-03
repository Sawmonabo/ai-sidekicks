// Unified patch text in, `DiffModel` out, plus the intraline word diff for one line pair
// (`diff` 9.0.0; `parsePatch` and `diffWordsWithSpace` are called only here). A parsed line
// carries one whole-line segment; the split is derived per row by `intraline-segment-cache.ts`.
// The compared refs are the caller's, and rename, copy, mode and binary facts are carried
// from `StructuredPatch` rather than inferred from an empty hunk list.

// Subpath imports, not the package root: this module is on the initial import graph and the
// package declares no side-effect flag, so the root would pull every differ (character,
// line, sentence, css, json, array) into every launch beside the one word differ used.
import { diffWordsWithSpace } from "diff/lib/diff/word.js";
import { parsePatch } from "diff/lib/patch/parse.js";
import type { StructuredPatch } from "diff/lib/types.js";

import { hunkLines } from "./hunk-lines.js";
import type { DiffModel, DiffFile, DiffIntralineSegment } from "./diff-model.js";
import { wholeLineSegments } from "./diff-model.js";

/** The compared states the caller names, carried onto the parsed model verbatim. */
export interface ComparedStates {
  readonly baseRef: string;
  readonly headRef: string;
}

/** The name a unified patch's headers give a side of a file when there is no file there. */
const ABSENT_FILE_NAME = "/dev/null";

/** The git prefixes `diff --git` puts on a path, which are the tool's and not the path's. */
const GIT_PATH_PREFIXES = ["a/", "b/"] as const;

/**
 * Turn unified patch text into the model both diff views render. `parsePatch` handles the
 * multi-file case, git extended headers and malformed-input rejection; the mapping after it
 * must be exact because a line's two numbers advance on different sides.
 */
export function parseUnifiedPatch(patchText: string, comparedStates: ComparedStates): DiffModel {
  const files: DiffFile[] = [];
  // Consumed in the order `parsePatch` returns hunks: the nth declared header belongs to the
  // nth parsed hunk across every file.
  const declaredHeaders = declaredHunkHeaders(patchText);
  const structuredPatches = parsePatch(patchText);
  let hunkOrdinal = 0;
  for (const structuredPatch of structuredPatches) {
    files.push({
      path: patchFilePath(structuredPatch),
      ...extendedHeaderChange(structuredPatch),
      hunks: structuredPatch.hunks.map((hunk) => {
        const header = declaredHeaders[hunkOrdinal];
        hunkOrdinal += 1;
        if (header === undefined) {
          // The parser reads every line that starts `@@` as a hunk, and the header scan only a
          // well-formed one, so the scan can fall short but never run over. A throw, not a
          // fallback: a header composed from the numbers would look like a declared one.
          throw new Error(
            `the patch declares fewer \`@@\` headers (${String(declaredHeaders.length)}) than it parsed hunks`,
          );
        }
        return {
          header,
          // Empty: a unified patch has no representation for hidden context.
          precedingContext: [],
          lines: hunkLines(hunk.lines, hunk.oldStart, hunk.newStart),
        };
      }),
    });
  }
  return {
    baseRef: comparedStates.baseRef,
    headRef: comparedStates.headRef,
    files,
  };
}

/**
 * How a unified patch spells a hunk header. Anchored at the line start, so a body line such
 * as `-@@ -1 +1 @@` (which starts with its prefix) never matches. Both line counts are
 * optional, since a one-line range omits them; the section context after `@@` is not matched.
 */
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * Where a patch's lines end, split exactly as the adopted parser splits them (`/\n/` only,
 * checked against `diff` 9.0.0's `patch/parse.js`). Headers are paired with hunks by ordinal
 * across two walks of one text, which is sound only if both walks agree line for line: a
 * lone `\r` inside a body line must not become a line break here that the parser lacks.
 */
const PATCH_LINE_BREAK_PATTERN = /\n/;

/** One line pair's two segmentations, which are two readings of one alignment. */
export interface IntralineSegmentPair {
  readonly deleted: readonly DiffIntralineSegment[];
  readonly inserted: readonly DiffIntralineSegment[];
}

/**
 * Segment one changed line pair at its word boundaries, for both sides from one comparison,
 * so the two highlights cannot disagree about which words survived. `diffWordsWithSpace`
 * keeps whitespace in the tokens, so an indentation change stays visible.
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

/**
 * One line's text without the carriage return a CRLF patch leaves on it, since the parser's
 * split leaves `\r` on every line and a header carrying one is not the declared header.
 */
function withoutTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Every `@@` header the patch text declares, in order, verbatim including the section
 * context after the closing `@@`. Read from the raw text because `StructuredPatchHunk` keeps
 * only four numbers and the body lines.
 */
function declaredHunkHeaders(patchText: string): readonly string[] {
  const headers: string[] = [];
  for (const line of patchText.split(PATCH_LINE_BREAK_PATTERN)) {
    if (HUNK_HEADER_PATTERN.test(line)) {
      headers.push(withoutTrailingCarriageReturn(line));
    }
  }
  return headers;
}

/**
 * The path a parsed file is rendered under. The new side wins (a rename's new name is where
 * the file is); the old side is used only for a deletion. The `a/` and `b/` prefixes are
 * stripped only on a git-style patch, since elsewhere `b/` is part of the path.
 */
function patchFilePath(structuredPatch: StructuredPatch): string {
  const newFileName = structuredPatch.newFileName ?? ABSENT_FILE_NAME;
  const named = newFileName === ABSENT_FILE_NAME ? structuredPatch.oldFileName : newFileName;
  return renderedPath(structuredPatch, named ?? ABSENT_FILE_NAME);
}

/**
 * One side's path as a diff view draws it. Shared by both sides because a rename renders the
 * old path too, and two copies of the strip rule could re-root one of them.
 */
function renderedPath(structuredPatch: StructuredPatch, path: string): string {
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

/** The extended-header members `DiffFile` carries, as a spreadable partial. */
type ExtendedHeaderChange = Pick<DiffFile, "renamedFrom" | "copiedFrom" | "modeChange" | "binary">;

/**
 * What a file's extended headers declared, read off the parsed structure. Members are spread
 * in rather than assigned `undefined`: under `exactOptionalPropertyTypes` that is a different
 * type from absent, and presence is the claim.
 *
 * A mode change needs both sides and a difference: `parsePatch` also fills one mode for a
 * created or deleted file, which did not change mode.
 */
function extendedHeaderChange(structuredPatch: StructuredPatch): ExtendedHeaderChange {
  const { oldFileName, oldMode, newMode } = structuredPatch;
  return {
    ...(structuredPatch.isRename === true && oldFileName !== undefined
      ? { renamedFrom: renderedPath(structuredPatch, oldFileName) }
      : {}),
    ...(structuredPatch.isCopy === true && oldFileName !== undefined
      ? { copiedFrom: renderedPath(structuredPatch, oldFileName) }
      : {}),
    ...(oldMode !== undefined && newMode !== undefined && oldMode !== newMode
      ? { modeChange: { from: oldMode, to: newMode } }
      : {}),
    ...(structuredPatch.isBinary === true ? { binary: true } : {}),
  };
}

/**
 * Fold neighboring segments with the same verdict into one, and drop empty values. Filtering
 * one side out of a word diff leaves runs separated only by the other side's tokens, and an
 * unchanged line must stay the single segment `diff-model.ts` promises.
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
