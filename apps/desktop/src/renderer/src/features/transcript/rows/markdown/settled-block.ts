// A settled block's record as its body keeps it, and what reading one settled block takes: its
// text's fingerprint, and whether a line of it could open a footnote definition.

/** One settled block, as its body keys, windows and resolves it. */
export interface SettledMarkdownBlock {
  /**
   * Its React key: its place in the body and its fingerprint. Never its text, which can run to
   * tens of kilobytes; a rebase that changes the text at a place changes the key and remounts.
   */
  readonly key: string;
  /** Its text's length and hash: the same for the same text in any body or place. */
  readonly fingerprint: string;
  /** Where its text starts in the body's text, in UTF-16 code units. */
  readonly start: number;
  /** Where its text ends in the body's text, exclusive. */
  readonly end: number;
  /** The footnote identifiers it defines, none until its own parse has landed. */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
}

/**
 * A line that could open a footnote definition: `[^label]:` after any indentation, block quote
 * markers and list markers. It can match more than defines one, which only asks for a parse that
 * finds nothing; it never misses one, which would leave the body's references unresolved.
 */
export const FOOTNOTE_DEFINITION_LINE: RegExp =
  /^(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*\[\^(?:\\.|[^\\\]\n])+\]:/mu;

/** A text's length and FNV-1a hash, in base 36: equal for equal texts, short for any. */
export function fingerprintOf(text: string): string {
  let hash = FINGERPRINT_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FINGERPRINT_PRIME);
  }
  return `${text.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

/** FNV-1a's 32-bit offset basis and prime. */
const FINGERPRINT_OFFSET_BASIS = 0x811c9dc5;
const FINGERPRINT_PRIME = 0x01000193;
