// One generation of a body's blocks as compact records, in typed arrays that grow by doubling and
// are never copied per frame, filled from where the cut says each block ends: where each block
// starts, its text's hash, what its text may hold, its lines' lengths, which the window's
// estimates read, and the keys of the labels it may reference a definition by. A block's text is
// read once, as it is appended, and never kept; a key, a fingerprint or a flag is read from the
// arrays on demand.

import { readReferenceKeys } from "#renderer/components/Markdown/parse/definition-preamble.js";
import { hashOf } from "#renderer/lib/text/hash.js";
import { FENCE_OPENER, measureLineLengths } from "./block-window/estimate.js";
import {
  DEFERRED_FENCE_OPENER,
  fingerprintFrom,
  mayDefineFootnote,
  mayDefineLink,
} from "./settled-block.js";
import { mayHoldLongTable } from "./table-window/long-tables.js";

/**
 * What a block's text may hold, one bit each, set once as it is appended: each a cheap test of the
 * text that can match more than the block holds, never less.
 */
export const BlockFlag = {
  /** It opens on a code fence, which the window estimates by its source lines. */
  Fence: 1,
  /** A line could open a footnote definition. */
  MayDefineFootnote: 2,
  /** A line could open a link reference definition. */
  MayDefineLink: 4,
  /** A fence could open a formula or a diagram. */
  MayOpenDeferredFence: 8,
  /** It holds a dollar, which may open a formula. */
  HoldsDollar: 16,
  /** It holds enough cell dividers to hold a long table. */
  MayHoldLongTable: 32,
} as const;

/** One of `BlockFlag`'s bits. */
export type BlockFlag = (typeof BlockFlag)[keyof typeof BlockFlag];

/**
 * One generation's blocks, in order, each touching the next: block `i` runs from `startOf(i)` to
 * `endOf(i)` in UTF-16 code units of the text it was cut from. A generation replaced while its
 * blocks are still drawn is marked so, and its blocks take the window's keys for a replaced one.
 */
export class BlockRecords {
  #count = 0;
  /** Each block's start, and after the last the last one's end. */
  #starts = new Uint32Array(INITIAL_BLOCK_CAPACITY + 1);
  #hashes = new Uint32Array(INITIAL_BLOCK_CAPACITY);
  #flags = new Uint8Array(INITIAL_BLOCK_CAPACITY);
  /** Where each block's line lengths start in `#lineLengths`, and after the last where they end. */
  #lineStarts = new Uint32Array(INITIAL_BLOCK_CAPACITY + 1);
  /** Every block's line lengths, one after another; 32-bit, since a line can pass 65,535. */
  #lineLengths = new Uint32Array(INITIAL_LINE_CAPACITY);
  /** Where each block's reference keys start in `#referenceKeys`, and after the last their end. */
  #referenceStarts = new Uint32Array(INITIAL_BLOCK_CAPACITY + 1);
  /** Every block's reference keys, one after another, as `readReferenceKeys` reads them. */
  #referenceKeys = new Uint32Array(INITIAL_REFERENCE_CAPACITY);
  #isReplaced = false;

  /** How many blocks are recorded. */
  public get count(): number {
    return this.#count;
  }

  /** Where block `index` starts in its text. */
  public startOf(index: number): number {
    return this.#starts[index] ?? 0;
  }

  /** Where block `index` ends in its text, exclusive: where the next one starts. */
  public endOf(index: number): number {
    return this.#starts[index + 1] ?? 0;
  }

  /** Block `index`'s text's FNV-1a hash, as `hashOf` reads it. */
  public hashAt(index: number): number {
    return this.#hashes[index] ?? 0;
  }

  /** Block `index`'s `BlockFlag` bits. */
  public flagsAt(index: number): number {
    return this.#flags[index] ?? 0;
  }

  /** Whether block `index` carries `flag`. */
  public hasFlag(index: number, flag: BlockFlag): boolean {
    return (this.flagsAt(index) & flag) !== 0;
  }

  /** Block `index`'s text's fingerprint, the same string `fingerprintOf` makes of its text. */
  public fingerprintAt(index: number): string {
    return fingerprintFrom(this.endOf(index) - this.startOf(index), this.hashAt(index));
  }

  /**
   * Block `index`'s React key: its place and its fingerprint, so a rebase that changes the text at
   * a place remounts it. Built only for a block that is drawn.
   */
  public reactKeyAt(index: number): string {
    return `${String(index)}:${this.fingerprintAt(index)}`;
  }

  /**
   * The number a body's window keys block `index` under: the index itself, or, once the generation
   * is replaced, `-(index + 2)`, so the window never reads a replaced block's size as a new one's.
   * `-1` is the streaming tail's.
   */
  public itemKeyAt(index: number): number {
    return this.#isReplaced ? -(index + 2) : index;
  }

  /** Block `index`'s line lengths, as a view of the records' own array. */
  public lineLengthsOf(index: number): Uint32Array {
    return this.#lineLengths.subarray(
      this.#lineStarts[index] ?? 0,
      this.#lineStarts[index + 1] ?? 0,
    );
  }

  /**
   * The keys of the labels block `index` may reference a definition by, as `readReferenceKeys`
   * reads them, as a view of the records' own array.
   */
  public referenceKeysOf(index: number): Uint32Array {
    return this.#referenceKeys.subarray(
      this.#referenceStarts[index] ?? 0,
      this.#referenceStarts[index + 1] ?? 0,
    );
  }

  /** Records the block cut from `start` to `end`, whose text is `text`, after the last one. */
  public append(start: number, end: number, text: string): void {
    const index = this.#count;
    if (index === this.#hashes.length) {
      this.#growBlocks();
    }
    this.#starts[index] = start;
    this.#starts[index + 1] = end;
    this.#hashes[index] = hashOf(text);
    this.#flags[index] = flagsOf(text);
    let lineEnd = this.#lineStarts[index] ?? 0;
    measureLineLengths(text, (length) => {
      if (lineEnd === this.#lineLengths.length) {
        this.#lineLengths = grown(this.#lineLengths);
      }
      this.#lineLengths[lineEnd] = length;
      lineEnd += 1;
    });
    this.#lineStarts[index + 1] = lineEnd;
    let referenceEnd = this.#referenceStarts[index] ?? 0;
    readReferenceKeys(text, (key) => {
      if (referenceEnd === this.#referenceKeys.length) {
        this.#referenceKeys = grown(this.#referenceKeys);
      }
      this.#referenceKeys[referenceEnd] = key;
      referenceEnd += 1;
    });
    this.#referenceStarts[index + 1] = referenceEnd;
    this.#count = index + 1;
  }

  /** Forgets every block from `count` on, as the cut gives them back to the tail. */
  public truncate(count: number): void {
    this.#count = Math.min(this.#count, count);
  }

  /** Marks the generation replaced: its blocks take a replaced generation's window keys. */
  public markReplaced(): void {
    this.#isReplaced = true;
  }

  #growBlocks(): void {
    this.#starts = grown(this.#starts);
    this.#hashes = grown(this.#hashes);
    this.#flags = grown(this.#flags);
    this.#lineStarts = grown(this.#lineStarts);
    this.#referenceStarts = grown(this.#referenceStarts);
  }
}

/** How many blocks, lines and reference keys the records hold room for before they first grow. */
const INITIAL_BLOCK_CAPACITY = 16;
const INITIAL_LINE_CAPACITY = 64;
const INITIAL_REFERENCE_CAPACITY = 16;

/** `array` copied into one twice its length. */
function grown<TArray extends Uint8Array | Uint32Array>(array: TArray): TArray {
  const larger = new (array.constructor as new (length: number) => TArray)(array.length * 2);
  larger.set(array);
  return larger;
}

/** The `BlockFlag` bits of a block's text. */
function flagsOf(text: string): number {
  let flags = 0;
  if (FENCE_OPENER.test(text)) {
    flags |= BlockFlag.Fence;
  }
  if (mayDefineFootnote(text)) {
    flags |= BlockFlag.MayDefineFootnote;
  }
  if (mayDefineLink(text)) {
    flags |= BlockFlag.MayDefineLink;
  }
  if (DEFERRED_FENCE_OPENER.test(text)) {
    flags |= BlockFlag.MayOpenDeferredFence;
  }
  if (text.includes("$")) {
    flags |= BlockFlag.HoldsDollar;
  }
  if (mayHoldLongTable(text)) {
    flags |= BlockFlag.MayHoldLongTable;
  }
  return flags;
}
