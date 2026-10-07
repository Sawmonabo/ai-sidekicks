// Reads the full-text index's highlighted text: the matched stretches in UTF-16 code units, and
// the line the first match sits in, cut to a bound around it. The marks `highlight()` puts around
// a match are two noncharacters, and the index's own text never carries either, since every
// trigger writes it through `markFreeTextSql`; so each mark in a highlight is one the index put.

import type { SearchMatchRange } from "@ai-sidekicks/contracts/session/methods";

/** The mark `highlight()` puts before a match: a noncharacter, which Unicode leaves to programs. */
export const MATCH_OPEN_MARK = "﷐";
/** The mark `highlight()` puts after each match; see {@link MATCH_OPEN_MARK}. */
export const MATCH_CLOSE_MARK = "﷑";

// How much of the line before the first match a cut line keeps, so the match reads in context.
const LEADING_CONTEXT_LENGTH = 40;

/** One line of a hit's text and the matched stretches in it, at least one. */
export interface MarkedLine {
  readonly line: string;
  readonly matchRanges: SearchMatchRange[];
}

/** A highlight read back: the text without its marks, and every matched stretch in it. */
export interface MarkedText {
  readonly text: string;
  readonly ranges: readonly SearchMatchRange[];
}

/**
 * The SQL for `textSql` as the index keeps it: each mark character becomes a space, which the
 * tokenizer already reads as a separator, so the words indexed are the same.
 */
export function markFreeTextSql(textSql: string): string {
  let sql = textSql;
  for (const mark of [MATCH_OPEN_MARK, MATCH_CLOSE_MARK]) {
    sql = `replace(${sql}, char(${String(mark.codePointAt(0))}), ' ')`;
  }
  return sql;
}

/** Reads a highlight back in one pass over it; an open mark left unclosed runs to the end. */
export function readMarks(markedText: string): MarkedText {
  const ranges: SearchMatchRange[] = [];
  let text = "";
  let rangeStart: number | undefined;
  let segmentStart = 0;
  for (let index = 0; index < markedText.length; index += 1) {
    const character = markedText[index];
    if (character !== MATCH_OPEN_MARK && character !== MATCH_CLOSE_MARK) {
      continue;
    }
    text += markedText.slice(segmentStart, index);
    segmentStart = index + 1;
    if (character === MATCH_OPEN_MARK) {
      rangeStart ??= text.length;
    } else if (rangeStart !== undefined) {
      pushRange(ranges, rangeStart, text.length);
      rangeStart = undefined;
    }
  }
  text += markedText.slice(segmentStart);
  if (rangeStart !== undefined) {
    pushRange(ranges, rangeStart, text.length);
  }
  return { text, ranges };
}

/**
 * The line holding the first match, at most `maxLength` code units long, with the matches inside
 * it. Throws when the text carries no match: a row the index matched always carries one, so none
 * means the index is broken.
 */
export function cutMarkedLine(marked: MarkedText, maxLength: number): MarkedLine {
  const { text, ranges } = marked;
  const firstRange = ranges[0];
  if (firstRange === undefined) {
    throw new Error("A row the full-text index matched carries no match to mark.");
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

function pushRange(ranges: SearchMatchRange[], start: number, end: number): void {
  if (end > start) {
    ranges.push({ start, end });
  }
}

// A cut never starts on the second half of a surrogate pair.
function stepOffLowSurrogate(text: string, index: number): number {
  return index > 0 && isLowSurrogate(text.charCodeAt(index)) ? index - 1 : index;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
