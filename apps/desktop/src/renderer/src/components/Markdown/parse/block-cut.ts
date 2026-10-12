// Where a body's text is cut into the blocks the screen draws apart: where the parser's own
// top-level children start, so every block parses alone as it does inside the whole text. A text is
// read a window of whole lines at a time; every child but the last few of a window is kept, since
// text after a window's end can still change what they are, and the next window starts at the
// first one held back. A block starts at the start of its child's first line, which the parser's
// own start skips the indentation of, and runs to where the next block starts, so the blocks cover
// the text with no gap. A streaming tail is cut the same way from its own parse.

/**
 * Top-level children held back at the end of a text that can still grow, behind which a child is
 * final. Two, because a child is not final when first seen: a setext underline turns the paragraph
 * above it into a heading, and a later item turns the blank line before it into the inside of a
 * loose list. One child of lag closes the setext case, two close both.
 */
export const MARKDOWN_SETTLE_LAG_BLOCKS = 2;

/** Where each top-level child of a parsed text starts and ends, in UTF-16 code units of it. */
export interface TopLevelChildren {
  readonly starts: ArrayLike<number>;
  readonly ends: ArrayLike<number>;
}

/**
 * One text cut into blocks a window at a time, so a caller can let its thread turn between
 * windows: the parser frees what a parse held only once it does. `readChildren` parses a window;
 * the body's cut holds back `MARKDOWN_SETTLE_LAG_BLOCKS` children.
 */
export class BlockCut {
  readonly #source: string;
  readonly #isFinal: boolean;
  readonly #lagBlocks: number;
  readonly #readChildren: (window: string) => TopLevelChildren;
  /** Where each block cut so far ends, which is where the next one starts. */
  readonly #blockEnds: number[] = [];
  /** Where the next window starts: the start of the first child held back. */
  #from = 0;
  #windowCharacters = CUT_WINDOW_CHARACTERS;
  #isDone = false;

  /**
   * `isFinal` says the text is whole, so its last window keeps every child; every other window
   * keeps back its last `lagBlocks`.
   */
  public constructor(
    source: string,
    isFinal: boolean,
    lagBlocks: number,
    readChildren: (window: string) => TopLevelChildren,
  ) {
    this.#source = source;
    this.#isFinal = isFinal;
    this.#lagBlocks = lagBlocks;
    this.#readChildren = readChildren;
  }

  /** Where each block cut ends in the text, ascending: the first starts at the text's start. */
  public get blockEnds(): Uint32Array {
    return Uint32Array.from(this.#blockEnds);
  }

  /**
   * Cuts every window left on this turn and answers where the blocks end, for a caller whose text
   * is short enough that letting its thread turn between windows frees nothing worth the wait.
   */
  public cutWhole(): Uint32Array {
    let isDone = false;
    while (!isDone) {
      isDone = this.cutWindow();
    }
    return this.blockEnds;
  }

  /**
   * Cuts the next window, answering whether the cut is done. A window holding too few children to
   * keep one is parsed again twice as long.
   */
  public cutWindow(): boolean {
    const source = this.#source;
    if (this.#isDone || this.#from >= source.length) {
      this.#isDone = true;
      return true;
    }
    const from = this.#from;
    let to = Math.min(source.length, from + this.#windowCharacters);
    if (to < source.length) {
      // Whole lines: a line longer than the window is cut inside the last child, which is held.
      const lastLineEnd = source.lastIndexOf("\n", to - 1);
      to = lastLineEnd >= from ? lastLineEnd + 1 : to;
    }
    const isLast = to === source.length;
    const window = source.slice(from, to);
    const children = this.#readChildren(window);
    const keptCount =
      isLast && this.#isFinal ? children.starts.length : children.starts.length - this.#lagBlocks;
    if (keptCount <= 0) {
      if (isLast) {
        this.#isDone = true;
        return true;
      }
      this.#windowCharacters *= 2;
      return false;
    }
    for (let index = 1; index < keptCount; index += 1) {
      this.#blockEnds.push(from + lineStartOf(window, children.starts[index] ?? 0));
    }
    const end =
      keptCount === children.starts.length
        ? source.length
        : from + lineStartOf(window, children.starts[keptCount] ?? 0);
    this.#blockEnds.push(end);
    this.#from = end;
    this.#windowCharacters = CUT_WINDOW_CHARACTERS;
    this.#isDone = isLast;
    return isLast;
  }
}

/**
 * Where each block a streaming tail's parse settles ends in the tail, ascending; the first starts
 * at the tail's start. Every child but the last `MARKDOWN_SETTLE_LAG_BLOCKS` settles, up to the
 * first one that reaches past `unchangedLength`: the tail was parsed with its open constructs
 * closed, which may rewrite its end as well as add to it, and a child reaching into what was
 * rewritten is not the tail's own.
 */
export function settledBlockEndsOf(
  children: TopLevelChildren,
  tail: string,
  unchangedLength: number,
): number[] {
  const keptCount = children.starts.length - MARKDOWN_SETTLE_LAG_BLOCKS;
  const blockEnds: number[] = [];
  for (let index = 1; index <= keptCount; index += 1) {
    const end = lineStartOf(tail, children.starts[index] ?? 0);
    if ((children.ends[index - 1] ?? 0) > unchangedLength || end > unchangedLength) {
      break;
    }
    blockEnds.push(end);
  }
  return blockEnds;
}

/**
 * The characters of a body's text one window parses first, cut back to whole lines. Measured on
 * 8 MiB replies, windows this long cut a reply as fast as larger ones while the parser's memory
 * grows by a few mebibytes, where one parse of the whole reply grows it by up to 190.
 */
const CUT_WINDOW_CHARACTERS = 65_536;

/** Where the line holding `offset` starts in `text`. */
function lineStartOf(text: string, offset: number): number {
  return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}
