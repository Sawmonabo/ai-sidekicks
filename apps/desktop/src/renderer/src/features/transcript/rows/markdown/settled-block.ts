// What reading one settled block's text takes: its hash and fingerprint, and the lines that tell
// whether it could define a footnote or a link, or open a formula or a diagram.

import { DEFERRED_FENCE_KINDS } from "#renderer/components/Markdown/rules.js";

/** The container markers a definition line may open after: block quote and list markers. */
const CONTAINER_MARKERS = String.raw`(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*`;

/**
 * A line that could open a footnote definition: `[^label]:` after any indentation, block quote
 * markers and list markers. It can match more than defines one, which only asks for a parse that
 * finds nothing; it never misses one, which would leave the body's references unresolved.
 */
export const FOOTNOTE_DEFINITION_LINE: RegExp = new RegExp(
  String.raw`^${CONTAINER_MARKERS}\[\^(?:\\.|[^\\\]\n])+\]:`,
  "mu",
);

/**
 * A line that could open a link reference definition: `[label]:` after any indentation, block
 * quote markers and list markers, its label any escaped character or anything but `]`, running on
 * over a line ending that does not start a blank line, as a label may. It matches footnote
 * definitions too, and more than defines a link, which only asks for a parse that finds nothing;
 * it never misses one, which would leave another block's references drawn as their text.
 */
export const LINK_DEFINITION_LINE: RegExp = new RegExp(
  String.raw`^${CONTAINER_MARKERS}\[(?:\\.|[^\\\]\n]|\n(?![ \t]*(?:\n|$)))+\]:`,
  "mu",
);

/**
 * A fence that opens a formula or a diagram: what a block must hold, or else a dollar, before it is
 * parsed for one. Read loosely, so it may match a fence the parse then reads as code.
 */
export const DEFERRED_FENCE_OPENER: RegExp = new RegExp(
  `(?:\`{3,}|~{3,})[ \\t]*(${Object.keys(DEFERRED_FENCE_KINDS).join("|")})(?![^\\s])`,
  "iu",
);

/** A text's FNV-1a hash over its UTF-16 code units, as an unsigned 32-bit number. */
export function hashOf(text: string): number {
  let hash = FINGERPRINT_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FINGERPRINT_PRIME);
  }
  return hash >>> 0;
}

/** A text's fingerprint from its length and `hashOf` hash: equal for equal texts, short for any. */
export function fingerprintFrom(length: number, hash: number): string {
  return `${length.toString(36)}.${hash.toString(36)}`;
}

/** A text's length and FNV-1a hash, in base 36: equal for equal texts, short for any. */
export function fingerprintOf(text: string): string {
  return fingerprintFrom(text.length, hashOf(text));
}

/** FNV-1a's 32-bit offset basis and prime. */
const FINGERPRINT_OFFSET_BASIS = 0x811c9dc5;
const FINGERPRINT_PRIME = 0x01000193;
