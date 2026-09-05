// The producer half of the diff family: unified patch text in, `ConsoleDiffModel`
// out, plus the intraline word diff one changed line pair is segmented by.
//
// `Spec-023 §Console Libraries`' Diff viewer row splits this surface in two and
// this file is the half it says to ADOPT: `diff` 9.0.0 (jsdiff, BSD-3-Clause) for
// "parse and intraline compute", against an OWN-BUILT virtualized row renderer for
// the pane and the inline card. So `parsePatch` and `diffWordsWithSpace` are called
// here and nowhere else in the console, and `DiffRows` / `hunk-virtualization.ts`
// stay first-party — the row renderer is the half the row says to own, because no
// candidate was both headless and virtualized.
//
// PARSING COMPUTES NO INTRALINE SEGMENTATION, AND THAT IS A BOUND AND NOT AN OMISSION.
// This module used to walk every hunk and run `diffWordsWithSpace` over every
// delete/insert pair before it returned, unbounded — so a forty-file change set paid
// for five thousand word diffs before the virtualizer placed a row, and one long line
// paid more than the whole rest of the patch (a single 18,889-character pair inside a
// 5,000-line patch measured 831 ms on its own, 2026-09-02). A parsed line therefore
// carries ONE whole-line segment, which is its text; `intraline-segments.ts` derives
// the split when a row is materialised, memoised and size-bounded. `intralineSegments`
// below is still this module's, because it is the adopted library's seam and
// `Spec-023 §Console Libraries` puts "parse and intraline compute" on one side of it.
//
// WHY A PARSER EXISTS BEFORE ITS WIRE DOES. `diff-model.ts`'s header records the
// obligation this file discharges: the module that turns a unified patch into the
// model "lands with the first caller that has patch bytes to give it, in the PR that
// adds that dependency". The dependency is added here. The caller that hands it daemon bytes is `gitflow.diffArtifactCreate`,
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
// AND ONE THING THE LIBRARY KEEPS, WHICH THIS FILE USED TO THROW AWAY. A git patch
// states a rename, a copy, a mode change, and a binary change in the extended headers
// ABOVE the hunks, so a change that is only one of those parses into a file with no
// textual hunks at all. The mapping kept the selected path and `hunks` and nothing
// else, so such a file reached both surfaces as `+0 −0` under a bare path — the
// console reporting that nothing happened to a file something happened to, and, for a
// rename, losing the name a reader is looking for. `parsePatch` retains all four
// facts on `StructuredPatch` (`isRename`, `isCopy`, `oldMode` / `newMode`,
// `isBinary`, with `oldFileName` / `newFileName` overwritten from the `rename from` /
// `copy from` lines) — measured against `diff` 9.0.0, not assumed — so this needs no
// second pass over the raw text the way the `@@` headers below do. They are carried
// onto `DiffFile` and rendered; nothing here infers one from `hunks.length === 0`,
// which cannot say which of the four it was.
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

import { reportTripwire } from "../../core/index.js";
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
  const structuredPatches = parsePatch(patchText);
  const parsedHunkCount = structuredPatches.reduce(
    (total, structuredPatch) => total + structuredPatch.hunks.length,
    0,
  );
  // BOTH DIRECTIONS, BEFORE THE FIRST PAIRING. The pairing is by ordinal across two
  // independent walks of one text, so it is only sound while the two walks agree on
  // how many hunks there are. A guard on the SHORT side alone — which is what the
  // per-hunk lookup below can see — leaves the other direction silent: one extra `@@`
  // line found by this module's own scanner shifts every later hunk onto the previous
  // one's declared header, and every header still resolves, so nothing anywhere says
  // the rendering is wrong. The two counts are compared once, up front, and a
  // disagreement refuses the patch rather than rendering a mispaired one.
  if (declaredHeaders.length !== parsedHunkCount) {
    throw new Error(
      `the patch declares ${String(declaredHeaders.length)} \`@@\` headers and parsed into ${String(parsedHunkCount)} hunks, so no header can be paired with the hunk it declares`,
    );
  }
  let hunkOrdinal = 0;
  for (const structuredPatch of structuredPatches) {
    files.push({
      path: patchFilePath(structuredPatch),
      ...extendedHeaderChange(structuredPatch),
      hunks: structuredPatch.hunks.map((hunk) => {
        const header = declaredHeaders[hunkOrdinal];
        hunkOrdinal += 1;
        if (header === undefined) {
          // Unreachable, because the counts were compared before the walk began. A
          // throw rather than a fallback because the only fallback is the
          // reconstruction this function exists to stop making: a header composed
          // from the numbers would be indistinguishable on screen from one the patch
          // declared.
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
 * Where a patch's lines end, split EXACTLY as the adopted parser splits them.
 *
 * `parsePatch` splits on `/\n/` and on nothing else — measured against `diff` 9.0.0's
 * `libesm/patch/parse.js`, not assumed — so this scanner must too, and the reason is
 * the pairing below. Two walks of one text pair by ordinal, and that is sound only
 * while both walks agree line for line. This used to split on `\r\n` and on a bare
 * `\v`, `\f`, `\r`, or `\u0085`, which is strictly more separators than the library
 * recognises: a hunk body line carrying a lone carriage return — an ordinary line in a
 * file with old-Mac endings — was ONE line to the parser and TWO to this scanner, so a
 * `@@` header inside such a line was counted as declared with no hunk to pair it with,
 * and every later hunk took the previous one's header.
 *
 * The carriage return a Windows patch leaves on the end of a line is a different
 * question from where the line ends, and it is answered where the header is KEPT
 * rather than here.
 */
const PATCH_LINE_BREAK_PATTERN = /\n/;

/**
 * One line's text without the carriage return a Windows patch leaves on it.
 *
 * The split above is the parser's, which leaves a `\r` at the end of every line of a
 * CRLF patch. A header carrying a stray carriage return is not the header the patch
 * declared, so it is trimmed from what is kept — one character, from the end, and only
 * where it is there.
 */
function withoutTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

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
      headers.push(withoutTrailingCarriageReturn(line));
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
  return renderedPath(structuredPatch, named ?? ABSENT_FILE_NAME);
}

/**
 * One side's path as a surface draws it.
 *
 * The prefix strip lives here rather than inside `patchFilePath` because the OLD side
 * is rendered too — a rename names where the file came from — and two copies of this
 * rule would be two chances to re-root one of the two paths a reader compares.
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
 * What a file's extended headers declared, read off the parsed structure.
 *
 * SPREAD-IN RATHER THAN `: undefined`, on `hunkLines`' reason: under
 * `exactOptionalPropertyTypes` an optional member assigned `undefined` is a different
 * type from an absent one, and the model means the second — presence is the claim.
 *
 * A MODE CHANGE NEEDS BOTH SIDES AND A DIFFERENCE. `parsePatch` also fills one of the
 * two modes for a created or deleted file (`new file mode`, `deleted file mode`), and
 * a file that appeared did not have its mode changed — it did not have one before.
 * Requiring both, and requiring them to differ, is what keeps this member meaning
 * what it says.
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

/** What each prefix character in a hunk body means. Closed by the format itself. */
const LINE_KIND_BY_PREFIX: Readonly<Record<string, DiffLineKind>> = {
  " ": "context",
  "+": "insert",
  "-": "delete",
};

/** What a tripwire report from this module names as the site it fired at. */
const PATCH_PARSE_SITE = "console/repos/diff-pane/patch-parse.ts";

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
function hunkLines(
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
        PATCH_PARSE_SITE,
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
