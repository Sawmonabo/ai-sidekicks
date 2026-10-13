// The text a body draws, read through a handle rather than held as one string. A streaming lane's
// text lives once, in the rope's chunks; a stored body lives once, as packed UTF-8; a body that
// only reads ranges of either, its newest lines or the scan's new part keeps no whole copy in a
// render, a fiber or a hook dependency. A short settled string (a person's message, a summary) is
// read through the same handle, so one pipeline draws all of them.

/**
 * A read-only text a body is drawn from. A streaming one grows under the same handle, so a reader
 * memoizes on `revision`, never on the handle alone. Offsets are UTF-16 code units from the
 * start; a range is clamped to the text.
 */
export interface PublishedText {
  /** How many characters there are now. */
  readonly length: number;
  /**
   * Changes whenever the text does: the value a memo comparison or an effect dependency takes.
   * A settled text never changes, so its revision is fixed.
   */
  readonly revision: number;
  /** Whether the text holds an `ESCAPE` character, which every ANSI escape sequence opens with. */
  readonly holdsEscape: boolean;
  /** The characters from `start` up to `end` (the end by default), cut for a reader to let go. */
  slice(start: number, end?: number): string;
  /** Where one code unit next occurs at or after `from`, or -1. */
  indexOf(character: string, from: number): number;
  /**
   * The text as flat strings, in order, each made as it is reached: for a copy or a strip that
   * reads the whole text once and lets each string go before the next.
   */
  chunks(): Iterable<string>;
  /**
   * Whether the first `length` characters are still the ones the text held at `revision`: false
   * once a rewrite cut below them, or when it cannot be told.
   */
  keepsPrefix(revision: number, length: number): boolean;
}

/**
 * A body's text as the console stores it once read from the log: read like any published text,
 * and measured in UTF-8 bytes as it is held.
 */
export interface StoredText extends PublishedText {
  /** How many bytes the text takes as UTF-8. */
  readonly byteLength: number;
}

/** The one character every ANSI escape sequence opens with. */
export const ESCAPE = "\u001b";

/** A settled string read as a `PublishedText`. It holds the string itself, never a copy. */
export function publishedTextOf(text: string): PublishedText {
  return {
    length: text.length,
    revision: SETTLED_TEXT_REVISION,
    holdsEscape: text.includes(ESCAPE),
    slice: (start, end = text.length) => text.slice(Math.max(0, start), Math.max(0, end)),
    indexOf: (character, from) => text.indexOf(character, from),
    chunks: () => (text === "" ? NO_CHUNKS : [text]),
    keepsPrefix: (_revision, length) => length <= text.length,
  };
}

/** The revision of a text that never changes. */
const SETTLED_TEXT_REVISION = 0;

const NO_CHUNKS: readonly string[] = Object.freeze([]);
