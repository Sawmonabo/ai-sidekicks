// What reading one settled block's text takes: its fingerprint, and the lines that tell whether it
// could define a footnote or a link, or open a formula or a diagram. A definition line is found in
// one pass over the text, however many lines open on a bracket.

import { CARRIAGE_RETURN, LINE_FEED } from "#renderer/components/Markdown/parse/line-endings.js";
import { DEFERRED_FENCE_KINDS } from "#renderer/components/Markdown/rules.js";
import { hashOf } from "#renderer/lib/text/hash.js";

/**
 * Whether a line of `text` could open a footnote definition: `[^label]:` after any indentation,
 * block quote markers and list markers. It can answer yes for more than defines one, which only
 * asks for a parse that finds nothing; it never misses one, which would leave the body's
 * references unresolved.
 */
export function mayDefineFootnote(text: string): boolean {
  return holdsDefinitionLine(text, true);
}

/**
 * Whether a line of `text` could open a link reference definition: `[label]:` after any
 * indentation, block quote markers and list markers, its label any escaped character or anything
 * but `]`, running on over a line ending that does not start a blank line, as a label may. It
 * answers yes for footnote definitions too, and for more than defines a link, which only asks for
 * a parse that finds nothing; it never misses one, which would leave another block's references
 * drawn as their text.
 */
export function mayDefineLink(text: string): boolean {
  return holdsDefinitionLine(text, false);
}

/**
 * A fence that opens a formula or a diagram: what a block must hold, or else a dollar, before it is
 * parsed for one. Read loosely, so it may match a fence the parse then reads as code.
 */
export const DEFERRED_FENCE_OPENER: RegExp = new RegExp(
  `(?:\`{3,}|~{3,})[ \\t]*(${Object.keys(DEFERRED_FENCE_KINDS).join("|")})(?![^\\s])`,
  "iu",
);

/** A text's fingerprint from its length and `hashOf` hash: equal for equal texts, short for any. */
export function fingerprintFrom(length: number, hash: number): string {
  return `${length.toString(36)}.${hash.toString(36)}`;
}

/** A text's length and FNV-1a hash, in base 36: equal for equal texts, short for any. */
export function fingerprintOf(text: string): string {
  return fingerprintFrom(text.length, hashOf(text));
}

/**
 * Whether a line opens on a definition's label and `]:`. A label that runs past later line starts
 * ends where theirs would, since each of its characters is read one way whatever line it is read
 * from, so those lines are not read again: the text is read once.
 */
function holdsDefinitionLine(text: string, isFootnote: boolean): boolean {
  let lineStart = 0;
  for (;;) {
    const labelOpen = containerMarkersEnd(text, lineStart);
    let readEnd = lineStart;
    if (
      text.charCodeAt(labelOpen) === OPEN_BRACKET &&
      (!isFootnote || text.charCodeAt(labelOpen + 1) === CARET)
    ) {
      const labelStart = labelOpen + (isFootnote ? 2 : 1);
      const labelEnd = labelEndOf(text, labelStart, isFootnote);
      if (labelEnd > labelStart && text.startsWith("]:", labelEnd)) {
        return true;
      }
      readEnd = labelEnd;
    }
    const lineEnd = lineTerminatorFrom(text, readEnd);
    if (lineEnd === -1) {
      return false;
    }
    lineStart = lineEnd + 1;
  }
}

/**
 * Where the container markers a line opens on end: indentation, block quote markers, and list
 * markers (`-`, `+`, `*`, or one to nine digits and `.` or `)`) followed by a space or a tab.
 */
function containerMarkersEnd(text: string, lineStart: number): number {
  let index = lineStart;
  for (;;) {
    const unit = text.charCodeAt(index);
    if (unit === SPACE || unit === TAB || unit === GREATER_THAN) {
      index += 1;
      continue;
    }
    if (
      (unit === HYPHEN || unit === PLUS || unit === ASTERISK) &&
      isSpaceOrTab(text.charCodeAt(index + 1))
    ) {
      index += 1;
      continue;
    }
    if (isDigit(unit)) {
      let digitsEnd = index + 1;
      while (isDigit(text.charCodeAt(digitsEnd))) {
        digitsEnd += 1;
      }
      const delimiter = text.charCodeAt(digitsEnd);
      if (
        digitsEnd - index <= MAX_LIST_NUMBER_DIGITS &&
        (delimiter === PERIOD || delimiter === CLOSE_PARENTHESIS) &&
        isSpaceOrTab(text.charCodeAt(digitsEnd + 1))
      ) {
        index = digitsEnd + 1;
        continue;
      }
    }
    return index;
  }
}

/**
 * Where a label starting at `labelStart` ends: at its first `]` not escaped, at a backslash that
 * escapes nothing, or at a line ending, which a footnote's label never crosses and a link's crosses
 * unless a blank line or the text's end follows it.
 */
function labelEndOf(text: string, labelStart: number, isFootnote: boolean): number {
  let index = labelStart;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    if (unit === BACKSLASH) {
      if (index + 1 === text.length || isLineTerminator(text.charCodeAt(index + 1))) {
        return index;
      }
      index += 2;
    } else if (unit === CLOSE_BRACKET) {
      return index;
    } else if (unit === LINE_FEED) {
      if (isFootnote) {
        return index;
      }
      let next = index + 1;
      while (isSpaceOrTab(text.charCodeAt(next))) {
        next += 1;
      }
      if (next === text.length || isLineTerminator(text.charCodeAt(next))) {
        return index;
      }
      index = next;
    } else {
      index += 1;
    }
  }
  return index;
}

/** Where the first line terminator at or after `from` is, or -1. */
function lineTerminatorFrom(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (isLineTerminator(text.charCodeAt(index))) {
      return index;
    }
  }
  return -1;
}

/** Whether a code unit ends a line, as a regular expression's `^` and `$` read one. */
function isLineTerminator(unit: number): boolean {
  return unit === LINE_FEED || unit === CARRIAGE_RETURN || unit === 0x2028 || unit === 0x2029;
}

function isSpaceOrTab(unit: number): boolean {
  return unit === SPACE || unit === TAB;
}

function isDigit(unit: number): boolean {
  return unit >= DIGIT_ZERO && unit <= DIGIT_NINE;
}

/** The most digits a list item's number may have. */
const MAX_LIST_NUMBER_DIGITS = 9;

const TAB = 0x09;
const SPACE = 0x20;
const ASTERISK = 0x2a;
const PLUS = 0x2b;
const HYPHEN = 0x2d;
const PERIOD = 0x2e;
const CLOSE_PARENTHESIS = 0x29;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const GREATER_THAN = 0x3e;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;
const CARET = 0x5e;
