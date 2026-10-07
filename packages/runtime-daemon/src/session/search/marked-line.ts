// Reads the full-text index's highlighted text: the line the first match sits in, cut to a bound
// around it, and the matched stretches inside that line in UTF-16 code units.

import type { SearchMatchRange } from "@ai-sidekicks/contracts/session/methods";

/**
 * The marks `highlight()` puts around each match: noncharacter pairs, which Unicode reserves for
 * a program's own use, so text people or tools write does not carry them.
 */
export const MATCH_OPEN_MARK = "﷐﷑";
/** The mark `highlight()` puts after each match; see {@link MATCH_OPEN_MARK}. */
export const MATCH_CLOSE_MARK = "﷑﷐";

// How much of the line before the first match a cut line keeps, so the match reads in context.
const LEADING_CONTEXT_LENGTH = 40;

/** One line of a hit's text and the matched stretches in it, at least one. */
export interface MarkedLine {
  readonly line: string;
  readonly matchRanges: SearchMatchRange[];
}

interface UnmarkedText {
  readonly text: string;
  readonly ranges: readonly SearchMatchRange[];
}

/**
 * The line holding the first match of `markedText`, at most `maxLength` code units long, with the
 * matches inside it; `undefined` when the text carries no match.
 */
export function readMarkedLine(markedText: string, maxLength: number): MarkedLine | undefined {
  const { text, ranges } = removeMarks(markedText);
  const firstRange = ranges[0];
  if (firstRange === undefined) {
    return undefined;
  }
  const lineStart = text.lastIndexOf("\n", firstRange.start - 1) + 1;
  const newlineIndex = text.indexOf("\n", firstRange.start);
  let lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
  if (text[lineEnd - 1] === "\r") {
    lineEnd -= 1;
  }
  let cutStart = lineStart;
  if (lineEnd - lineStart > maxLength) {
    cutStart = Math.max(lineStart, firstRange.start - LEADING_CONTEXT_LENGTH);
    cutStart = Math.min(cutStart, lineEnd - maxLength);
  }
  cutStart = stepOffLowSurrogate(text, cutStart);
  let cutEnd = Math.min(lineEnd, cutStart + maxLength);
  if (cutEnd < lineEnd && isLowSurrogate(text.charCodeAt(cutEnd))) {
    cutEnd -= 1;
  }
  const matchRanges: SearchMatchRange[] = [];
  for (const range of ranges) {
    const start = Math.max(range.start, cutStart);
    const end = Math.min(range.end, cutEnd);
    if (end > start) {
      matchRanges.push({ start: start - cutStart, end: end - cutStart });
    }
  }
  return { line: text.slice(cutStart, cutEnd), matchRanges };
}

/** How many matches `markedText` carries, across all its lines. */
export function countMarkedMatches(markedText: string): number {
  return markedText.split(MATCH_OPEN_MARK).length - 1;
}

function removeMarks(markedText: string): UnmarkedText {
  const ranges: SearchMatchRange[] = [];
  let text = "";
  let cursor = 0;
  for (;;) {
    const openIndex = markedText.indexOf(MATCH_OPEN_MARK, cursor);
    if (openIndex === -1) {
      return { text: text + markedText.slice(cursor), ranges };
    }
    const closeIndex = markedText.indexOf(MATCH_CLOSE_MARK, openIndex);
    text += markedText.slice(cursor, openIndex);
    const start = text.length;
    text += markedText.slice(openIndex + MATCH_OPEN_MARK.length, closeIndex);
    if (text.length > start) {
      ranges.push({ start, end: text.length });
    }
    cursor = closeIndex + MATCH_CLOSE_MARK.length;
  }
}

// A cut never starts on the second half of a surrogate pair.
function stepOffLowSurrogate(text: string, index: number): number {
  return index > 0 && isLowSurrogate(text.charCodeAt(index)) ? index - 1 : index;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
