// The line a hit shows: the line of a row's text its first match sits in, cut to a bound around
// that match, with the matched stretches inside it in UTF-16 code units.

import type { SearchMatchRange } from "@ai-sidekicks/contracts/session/methods";

// How much of the line before the first match a cut line keeps, so the match reads in context.
const LEADING_CONTEXT_LENGTH = 40;

/** One line of a hit's text and the matched stretches in it, at least one. */
export interface MarkedLine {
  readonly line: string;
  readonly matchRanges: SearchMatchRange[];
}

/**
 * The line of `text` holding the first of `ranges`, at most `maxLength` code units long, with the
 * ranges inside it; `ranges` run in order and never overlap.
 */
export function cutMarkedLine(
  text: string,
  ranges: readonly [SearchMatchRange, ...SearchMatchRange[]],
  maxLength: number,
): MarkedLine {
  const [firstRange] = ranges;
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

// A cut never starts on the second half of a surrogate pair.
function stepOffLowSurrogate(text: string, index: number): number {
  return index > 0 && isLowSurrogate(text.charCodeAt(index)) ? index - 1 : index;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
