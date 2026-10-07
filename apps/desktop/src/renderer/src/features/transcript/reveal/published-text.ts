// The text a body draws, read through a handle rather than held as one string. A streaming lane's
// text lives once, in the rope's chunks; a body that only reads ranges of it, its newest lines or
// the scan's new part keeps no whole copy in a render, a fiber or a hook dependency. A settled
// string (a stored body, a user's summary) is read through the same handle, so one pipeline draws
// both.

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
  /** The characters from `start` up to `end` (the end by default), cut for a reader to let go. */
  slice(start: number, end?: number): string;
  /** Where one code unit next occurs at or after `from`, or -1. */
  indexOf(character: string, from: number): number;
  /**
   * Where one code unit first occurs, or -1. A streaming text answers from where it last looked,
   * so asking every frame costs the frame's growth.
   */
  firstIndexOf(character: string): number;
  /**
   * The text as the flat strings it is held in, in order, for drawing as separate text nodes:
   * a fiber holding them shares the text rather than owning a copy.
   */
  chunks(): readonly string[];
  /**
   * Whether the first `length` characters are still the ones the text held at `revision`: false
   * once a rewrite cut below them, or when it cannot be told.
   */
  keepsPrefix(revision: number, length: number): boolean;
}

/** A settled string read as a `PublishedText`. It holds the string itself, never a copy. */
export function publishedTextOf(text: string): PublishedText {
  return {
    length: text.length,
    revision: SETTLED_TEXT_REVISION,
    slice: (start, end = text.length) => text.slice(Math.max(0, start), Math.max(0, end)),
    indexOf: (character, from) => text.indexOf(character, from),
    firstIndexOf: (character) => text.indexOf(character),
    chunks: () => (text === "" ? NO_CHUNKS : [text]),
    keepsPrefix: (_revision, length) => length <= text.length,
  };
}

/** The revision of a text that never changes. */
const SETTLED_TEXT_REVISION = 0;

const NO_CHUNKS: readonly string[] = Object.freeze([]);
