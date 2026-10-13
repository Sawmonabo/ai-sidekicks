// One generation of a body's blocks: the text they are cut from, read through its handle and never
// copied whole; where each block sits and what its text may hold, recorded a slice at a time as a
// cut lands; what they define; the trees parsed on the page for the blocks mounted, kept only while
// they are; and the worker's trees, held for the blocks the page does not parse. A generation lasts
// while the body's text only grows. The blocks start past a byte order mark the text opens on,
// which is no part of its markdown, as a whole parse of the text drops it.

import {
  PAGE_PARSE_MAX_CHARACTERS,
  type ParsedMarkdown,
} from "#renderer/components/Markdown/parse/trees.js";
import { MARKDOWN_SETTLE_LAG_BLOCKS } from "#renderer/components/Markdown/parse/block-cut.js";
import { byteOrderMarkLengthOf } from "#renderer/components/Markdown/parse/byte-order-mark.js";
import { LINE_ENDING } from "#renderer/components/Markdown/parse/line-endings.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { publishedTextOf, type PublishedText } from "#renderer/lib/text/published.js";
import { BlockFlag, BlockRecords } from "../block-records.js";
import { BodyDefinitions } from "./definitions.js";

/** One block's worker tree as its body holds it. */
export interface HeldBlockTree {
  /** The definitions its newest ask was parsed against. */
  askedPreamble: string | undefined;
  /** The definitions its newest landed tree was parsed against, `undefined` before one lands. */
  landedPreamble: string | undefined;
  /** Its newest landed tree. */
  tree: ParsedMarkdown | undefined;
  /** Stops listening for its ask in flight. */
  stop: Unsubscribe;
  /** Lets go of its newest landed tree, held in the shared trees while this body holds it. */
  letLandedGo: Unsubscribe;
}

/** One generation of a body's blocks and what is read and held of them. */
export class BlockGeneration {
  /** Counts the generations a body has had: a new number means its text was replaced. */
  public readonly number: number;
  public readonly records: BlockRecords = new BlockRecords();
  public readonly definitions: BodyDefinitions = new BodyDefinitions(this.records);
  /** Each worker tree the body holds, by the block's index. */
  public readonly workerTrees: Map<number, HeldBlockTree> = new Map<number, HeldBlockTree>();
  /** Stops listening for each block's read for its definitions the worker is answering. */
  public readonly definitionReads: Map<number, Unsubscribe> = new Map<number, Unsubscribe>();
  /** Stops listening for the cut in flight, while one is. */
  public cutInFlight: Unsubscribe | undefined;
  /** Whether a cut of the body's text landed and is recorded, so a streaming tail cuts the rest. */
  public hasCut = false;
  /** Each mounted block's page tree, by the block's index. */
  readonly #pageTrees = new Map<number, PageTree>();
  #text: PublishedText = NO_TEXT;
  /** Where the first block starts: past the byte order mark the text opens on, once it has one. */
  #blocksStart = 0;
  /** The text's revision and length when last read. */
  #readRevision = 0;
  #readLength = 0;
  /** How long the text was when a cut of it as whole landed, while it still is. */
  #wholeLength: number | undefined;
  /** How many of the last blocks that cut settled that a cut of a growing text holds back. */
  #wholeEndCount = 0;
  /** The cut taken and not yet recorded whole, while one is. */
  #takenCut: TakenCut | undefined;

  public constructor(number: number) {
    this.number = number;
  }

  /** The text the blocks are cut from. */
  public get text(): PublishedText {
    return this.#text;
  }

  /** Where the blocks cut so far end: where the rest of the text starts. */
  public get cutEnd(): number {
    const count = this.records.count;
    return count === 0 ? this.#blocksStart : this.records.endOf(count - 1);
  }

  /** Whether the text was cut whole at `length`, so no block is left to cut. */
  public isCutWhole(length: number): boolean {
    return this.#wholeLength === length;
  }

  /** Whether the text was cut whole at a length it has since outgrown, or while it still grows. */
  public get hasWholeCut(): boolean {
    return this.#wholeLength !== undefined;
  }

  /** Whether a cut was taken and its blocks are not all recorded yet. */
  public get isRecordingCut(): boolean {
    return this.#takenCut !== undefined;
  }

  /**
   * Whether `text` begins with everything this generation read: the same handle answers from its
   * revision; another is compared with it a window at a time, so a body handed a stored text that
   * extends its streamed one keeps its blocks.
   */
  public isExtendedBy(text: PublishedText): boolean {
    const read = this.#text;
    if (text === read) {
      return text.keepsPrefix(this.#readRevision, this.#readLength);
    }
    return (
      text.length >= this.#readLength &&
      read.keepsPrefix(this.#readRevision, this.#readLength) &&
      readsTheSame(text, read, this.#readLength)
    );
  }

  /** Takes the text as it stands now, which extends what was read. */
  public take(text: PublishedText): void {
    if (this.#readLength === 0 && text.length > 0) {
      this.#blocksStart = byteOrderMarkLengthOf(text.slice(0, 1));
    }
    this.#text = text;
    this.#readRevision = text.revision;
    this.#readLength = text.length;
  }

  /**
   * The text from `start`, as a tail is drawn: never before the first block's start, and without
   * its leading blank lines.
   */
  public tailFrom(start: number): string {
    // A copy, not a cut of the text: a tail parser keeps what it read across frames, and a cut
    // would keep alive the text it was cut from.
    return structuredClone(
      withoutLeadingBlankLines(this.#text.slice(Math.max(start, this.#blocksStart))),
    );
  }

  /** Block `index`'s text, cut from the generation's text for a reader that lets it go. */
  public readBlockSource(index: number): string {
    return this.#text.slice(this.records.startOf(index), this.records.endOf(index));
  }

  /** Whether block `index` is too long for the page to parse, so the worker parses it. */
  public isOverPageCap(index: number): boolean {
    return this.records.endOf(index) - this.records.startOf(index) > PAGE_PARSE_MAX_CHARACTERS;
  }

  /**
   * Takes the blocks a cut settled, from where the last one ends, each ending `offset` past the
   * next of `blockEnds`, for `recordCut` to record; `wholeLength` says the cut took the text as
   * whole at that length. The text must not be cut again until they are recorded.
   */
  public takeCut(
    offset: number,
    blockEnds: ArrayLike<number>,
    wholeLength: number | undefined,
  ): void {
    this.#takenCut = {
      offset,
      blockEnds,
      wholeLength,
      firstIndex: this.records.count,
      recordedCount: 0,
    };
  }

  /**
   * Records the taken cut's next block, then more while `hasTime` answers true, each as one pass
   * over the cut would; answers whether every block is recorded. The cut counts as landed only
   * then: until it does, the text is still being cut.
   */
  public recordCut(hasTime: () => boolean): boolean {
    const cut = this.#takenCut;
    if (cut === undefined) {
      return true;
    }
    const { offset, blockEnds } = cut;
    while (cut.recordedCount < blockEnds.length) {
      const start = this.cutEnd;
      const end = offset + (blockEnds[cut.recordedCount] ?? 0);
      this.records.append(start, end, this.#text.slice(start, end));
      const index = this.records.count - 1;
      if (this.records.flagsAt(index) & DEFINING_FLAGS) {
        this.definitions.markUnread(index);
      }
      cut.recordedCount += 1;
      if (cut.recordedCount < blockEnds.length && !hasTime()) {
        return false;
      }
    }
    this.#takenCut = undefined;
    if (cut.wholeLength === undefined) {
      this.hasCut = true;
    } else {
      this.#wholeLength = cut.wholeLength;
      this.#wholeEndCount = Math.min(MARKDOWN_SETTLE_LAG_BLOCKS, blockEnds.length);
    }
    return true;
  }

  /**
   * Gives back to the tail the last blocks a whole cut settled that a growing text holds back, as
   * the text grew past it or goes on streaming; answers how many blocks are left.
   */
  public reopenWholeCut(): number {
    const count = this.records.count - this.#wholeEndCount;
    this.#wholeLength = undefined;
    this.#wholeEndCount = 0;
    this.#forgetBlocksFrom(count);
    return count;
  }

  /** Block `index`'s page tree against `preamble`, if one is kept for its text now. */
  public pageTreeOf(index: number, preamble: string): ParsedMarkdown | undefined {
    const kept = this.#pageTrees.get(index);
    return kept?.hash === this.records.hashAt(index) && kept.preamble === preamble
      ? kept.tree
      : undefined;
  }

  /** Keeps block `index`'s page tree, parsed against `preamble`, while it is mounted. */
  public keepPageTree(index: number, preamble: string, tree: ParsedMarkdown): void {
    this.#pageTrees.set(index, { hash: this.records.hashAt(index), preamble, tree });
  }

  /** Lets go of every page tree but those of the blocks `mounted` names. */
  public keepPageTreesOf(mounted: Iterable<number>): void {
    const isMounted = new Set(mounted);
    for (const index of [...this.#pageTrees.keys()]) {
      if (!isMounted.has(index)) {
        this.#pageTrees.delete(index);
      }
    }
  }

  /** Lets go of every page tree, as the body leaves the screen. */
  public letPageTreesGo(): void {
    this.#pageTrees.clear();
  }

  /**
   * Stops listening for every read in flight and lets go of the trees held in the shared trees,
   * keeping each landed one here, so a body read again draws it and asks only for the rest. A cut
   * not yet recorded whole is forgotten with the blocks recorded of it, so it is asked for again.
   */
  public stopAsks(): void {
    this.cutInFlight?.();
    this.cutInFlight = undefined;
    const taken = this.#takenCut;
    if (taken !== undefined) {
      this.#takenCut = undefined;
      this.#forgetBlocksFrom(taken.firstIndex);
    }
    for (const stop of this.definitionReads.values()) {
      stop();
    }
    this.definitionReads.clear();
    for (const [index, held] of this.workerTrees) {
      held.stop();
      held.letLandedGo();
      held.letLandedGo = NO_STOP;
      if (held.tree === undefined) {
        this.workerTrees.delete(index);
      } else {
        held.askedPreamble = held.landedPreamble;
        held.stop = NO_STOP;
      }
    }
  }

  /** Lets go of everything the generation holds, as nothing draws it any more. */
  public letGo(): void {
    this.stopAsks();
    this.workerTrees.clear();
    this.#pageTrees.clear();
  }

  /** Forgets every block from `count` on, and lets go of what was read and held for them. */
  #forgetBlocksFrom(count: number): void {
    this.records.truncate(count);
    this.definitions.dropFrom(count);
    for (const [index, held] of this.workerTrees) {
      if (index >= count) {
        held.stop();
        held.letLandedGo();
        this.workerTrees.delete(index);
      }
    }
    for (const [index, stop] of this.definitionReads) {
      if (index >= count) {
        stop();
        this.definitionReads.delete(index);
      }
    }
    for (const index of [...this.#pageTrees.keys()]) {
      if (index >= count) {
        this.#pageTrees.delete(index);
      }
    }
  }
}

/** Lets go of nothing. */
export const NO_STOP: Unsubscribe = () => undefined;

/**
 * `tail` without the blank separator lines ahead of its first content line, and nothing more.
 * Trimming all leading whitespace would take that line's indentation, which is syntax: four spaces
 * open an indented code block. `[ \t]` rather than `\s`, which would match the newline itself.
 */
export function withoutLeadingBlankLines(tail: string): string {
  return tail.replace(LEADING_BLANK_LINES, "");
}

/** The blank lines a tail opens on, each ended by any line ending. */
const LEADING_BLANK_LINES = new RegExp(`^(?:[ \\t]*(?:${LINE_ENDING.source}))+`, "u");

/** A cut taken to record: where its blocks end, how many are recorded, and where they began. */
interface TakenCut {
  readonly offset: number;
  readonly blockEnds: ArrayLike<number>;
  readonly wholeLength: number | undefined;
  /** The index its first block is recorded at. */
  readonly firstIndex: number;
  recordedCount: number;
}

/** A mounted block's tree as the page parsed it, and the text and preamble it was parsed from. */
interface PageTree {
  readonly hash: number;
  readonly preamble: string;
  readonly tree: ParsedMarkdown;
}

/** The flags of a block that could define a footnote or a link. */
const DEFINING_FLAGS = BlockFlag.MayDefineFootnote | BlockFlag.MayDefineLink;

/**
 * Characters compared at a time when a body's text is replaced by another handle, so neither text
 * is read whole to tell whether one extends the other.
 */
const COMPARISON_WINDOW_CHARACTERS = 4_096;

const NO_TEXT: PublishedText = publishedTextOf("");

/** Whether two texts agree on their first `length` characters, read a window at a time. */
function readsTheSame(first: PublishedText, second: PublishedText, length: number): boolean {
  for (let start = 0; start < length; start += COMPARISON_WINDOW_CHARACTERS) {
    const end = Math.min(length, start + COMPARISON_WINDOW_CHARACTERS);
    if (first.slice(start, end) !== second.slice(start, end)) {
      return false;
    }
  }
  return true;
}
