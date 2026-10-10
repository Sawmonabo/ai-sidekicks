// One markdown body's blocks, as its renderer keys, windows and resolves them. Each settled block
// is read once, when it settles: a key from its place and a fingerprint of its text, and the
// footnote identifiers it defines, kept as strings. A block keeps where its text sits in the body's
// text, never a copy of it, so a long reply is held once; its text is cut again when it is drawn
// or parsed. No block's tree is held here. The volatile tail is parsed here only while it could
// define a footnote.

import type { FootnoteDefinition } from "mdast";

import { collectFootnoteDefinitions } from "#renderer/components/Markdown/footnotes/collection.js";
import { footnoteDefinitionPreamble, parseMarkdown } from "#renderer/components/Markdown/parse.js";
import {
  publishedTextOf,
  type PublishedText,
} from "#renderer/features/transcript/reveal/published-text.js";
import { type MarkdownBlockRange, type MarkdownSegmentation } from "./parse/block-segmenter.js";
import { VolatileTailParser } from "./parse/volatile-tail.js";

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
  /** The footnote identifiers it defines, read once when it settled. */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
}

/** One body's blocks for one frame. */
export interface MarkdownBodyBlocksSnapshot {
  /** Counts the times the body's text was replaced rather than extended. */
  readonly generation: number;
  /** The same array until a block settles or the generation changes. */
  readonly settledBlocks: readonly SettledMarkdownBlock[];
  /** The settled blocks that define a footnote: the ones whose definitions are registered. */
  readonly definingBlocks: readonly SettledMarkdownBlock[];
  readonly volatileTail: string;
  /** The tail's own footnote definitions, read from the tail alone; none in most frames. */
  readonly volatileTailDefinitions: readonly FootnoteDefinition[];
  /** Every identifier the body defines: the same set until one is added or removed. */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
  /** Those identifiers as the preamble every block is parsed after. */
  readonly definitionPreamble: string;
  /**
   * A settled block's text, cut from the body's text through its handle. The same function until
   * the generation changes, so a drawn block does not read its text again on a frame that only
   * grew the body; the cut is for a reader that lets it go, never one to keep.
   */
  readonly readBlockSource: (block: SettledMarkdownBlock) => string;
}

/**
 * Holds one body's per-block reading across frames. Within a generation a block is read when it
 * settles and never again, so a frame costs its new blocks and its tail, not the whole body.
 */
export class MarkdownBodyBlocks {
  /** Reads the tail alone, for the definitions it holds. */
  readonly #tailParser = new VolatileTailParser();
  #lastSegmentation: MarkdownSegmentation | undefined;
  #lastSnapshot: MarkdownBodyBlocksSnapshot | undefined;
  #generation = -1;
  /** The current generation's text, which its blocks are cut from. */
  #generationText: GenerationText;
  #settledBlocks: readonly SettledMarkdownBlock[] = NO_BLOCKS;
  #definingBlocks: readonly SettledMarkdownBlock[] = NO_BLOCKS;
  #settledIdentifiers: ReadonlySet<string> = NO_IDENTIFIERS;
  /** The last union with the tail's identifiers, and the two sets it was made from. */
  #tailUnion: TailIdentifierUnion | undefined;
  #definitionPreamble = "";
  #preambleIdentifiers: ReadonlySet<string> = NO_IDENTIFIERS;

  public constructor() {
    this.#generationText = new GenerationText();
  }

  /** The body's blocks for one segmentation; the last snapshot again for the same one. */
  public read(segmentation: MarkdownSegmentation): MarkdownBodyBlocksSnapshot {
    if (segmentation === this.#lastSegmentation && this.#lastSnapshot !== undefined) {
      return this.#lastSnapshot;
    }
    this.#settle(segmentation);
    this.#generationText.update(segmentation.source);
    const volatileTailDefinitions = segmentation.volatileTail.includes(FOOTNOTE_OPENER)
      ? collectFootnoteDefinitions(this.#tailParser.parse(segmentation.volatileTail, "").children)
          .definitions
      : NO_DEFINITIONS;
    const definedFootnoteIdentifiers = this.#unionWith(volatileTailDefinitions);
    if (definedFootnoteIdentifiers !== this.#preambleIdentifiers) {
      this.#preambleIdentifiers = definedFootnoteIdentifiers;
      this.#definitionPreamble = footnoteDefinitionPreamble(definedFootnoteIdentifiers);
    }
    const snapshot: MarkdownBodyBlocksSnapshot = {
      generation: this.#generation,
      settledBlocks: this.#settledBlocks,
      definingBlocks: this.#definingBlocks,
      volatileTail: segmentation.volatileTail,
      volatileTailDefinitions,
      definedFootnoteIdentifiers,
      definitionPreamble: this.#definitionPreamble,
      readBlockSource: this.#generationText.readBlockSource,
    };
    this.#lastSegmentation = segmentation;
    this.#lastSnapshot = snapshot;
    return snapshot;
  }

  /** Brings the settled blocks up to the segmentation, reading only the ones not read before. */
  #settle(segmentation: MarkdownSegmentation): void {
    const ranges = segmentation.settledBlocks;
    if (segmentation.generation !== this.#generation) {
      this.#generation = segmentation.generation;
      // A new reader, so no block of the last generation is cut from this one's text.
      this.#generationText = new GenerationText();
      this.#settledBlocks = NO_BLOCKS;
      this.#definingBlocks = NO_BLOCKS;
      this.#settledIdentifiers = NO_IDENTIFIERS;
    }
    const heldCount = this.#settledBlocks.length;
    if (ranges.length === heldCount) {
      return;
    }
    if (ranges.length < heldCount) {
      // A body marked finished and then streaming again holds its last blocks back once more.
      this.#settledBlocks = this.#settledBlocks.slice(0, ranges.length);
      this.#definingBlocks = this.#settledBlocks.filter(
        (block) => block.definedFootnoteIdentifiers.size > 0,
      );
      this.#settledIdentifiers = identifiersOf(this.#definingBlocks);
      return;
    }
    const settledBlocks = [...this.#settledBlocks];
    const definingBlocks = [...this.#definingBlocks];
    for (const [offset, range] of ranges.slice(heldCount).entries()) {
      const block = readSettledBlock(segmentation.source, range, heldCount + offset);
      settledBlocks.push(block);
      if (block.definedFootnoteIdentifiers.size > 0) {
        definingBlocks.push(block);
      }
    }
    if (definingBlocks.length !== this.#definingBlocks.length) {
      this.#definingBlocks = definingBlocks;
      this.#settledIdentifiers = identifiersOf(definingBlocks);
    }
    this.#settledBlocks = settledBlocks;
  }

  /**
   * The settled identifiers with the tail's, as the same set while neither changed: the set's
   * identity is what keeps every drawn block from re-rendering on a frame that added none.
   */
  #unionWith(tailDefinitions: readonly FootnoteDefinition[]): ReadonlySet<string> {
    const settled = this.#settledIdentifiers;
    const tailOnly = [
      ...new Set(tailDefinitions.map((definition) => definition.identifier)),
    ].filter((identifier) => !settled.has(identifier));
    if (tailOnly.length === 0) {
      this.#tailUnion = undefined;
      return settled;
    }
    const tailOnlyKey = tailOnly.sort().join(IDENTIFIER_SEPARATOR);
    const held = this.#tailUnion;
    if (held?.settled === settled && held.tailOnly === tailOnlyKey) {
      return held.identifiers;
    }
    const identifiers = new Set([...settled, ...tailOnly]);
    this.#tailUnion = { settled, tailOnly: tailOnlyKey, identifiers };
    return identifiers;
  }
}

/**
 * A text's fingerprint read a part at a time, for text read in slices: its value is the one
 * `fingerprintOf` gives the parts joined.
 */
export class TextFingerprint {
  #hash = FINGERPRINT_OFFSET_BASIS;
  #length = 0;

  /** The fingerprint of the text read so far. */
  public get value(): string {
    return `${this.#length.toString(36)}.${(this.#hash >>> 0).toString(36)}`;
  }

  /** Reads `text` after what was read before. */
  public read(text: string): void {
    let hash = this.#hash;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), FINGERPRINT_PRIME);
    }
    this.#hash = hash;
    this.#length += text.length;
  }
}

/** A text's length and FNV-1a hash, in base 36: equal for equal texts, short for any. */
export function fingerprintOf(text: string): string {
  const fingerprint = new TextFingerprint();
  fingerprint.read(text);
  return fingerprint.value;
}

/**
 * Where block `index` of a body starts in the body's text, in UTF-16 code units: a settled block's
 * own start, or the tail's, which runs to the body's end.
 */
export function blockSourceStartOf(
  blocks: Pick<MarkdownBodyBlocksSnapshot, "settledBlocks" | "volatileTail">,
  bodyTextLength: number,
  index: number,
): number {
  return blocks.settledBlocks[index]?.start ?? bodyTextLength - blocks.volatileTail.length;
}

/** One generation's text, as the handle it is read through: every block of it is cut from this. */
class GenerationText {
  #text: PublishedText = NO_TEXT;

  /** A block's text, cut from the generation's text, which only ever grew. */
  public readonly readBlockSource = (block: SettledMarkdownBlock): string =>
    this.#text.slice(block.start, block.end);

  public update(text: PublishedText): void {
    this.#text = text;
  }
}

/** The tail's identifiers the settled blocks do not define, with the union they made. */
interface TailIdentifierUnion {
  readonly settled: ReadonlySet<string>;
  /** The tail-only identifiers, sorted and joined. */
  readonly tailOnly: string;
  readonly identifiers: ReadonlySet<string>;
}

/** A run that every footnote reference and definition begins with. */
const FOOTNOTE_OPENER = "[^";

/**
 * What joins identifiers into one comparison key. NUL, because commonmark replaces a literal NUL
 * in a label with U+FFFD, so no identifier holds one.
 */
const IDENTIFIER_SEPARATOR = "\u0000";

/** FNV-1a's 32-bit offset basis and prime. */
const FINGERPRINT_OFFSET_BASIS = 0x811c9dc5;
const FINGERPRINT_PRIME = 0x01000193;

const NO_BLOCKS: readonly SettledMarkdownBlock[] = Object.freeze([]);
const NO_DEFINITIONS: readonly FootnoteDefinition[] = Object.freeze([]);
const NO_IDENTIFIERS: ReadonlySet<string> = new Set<string>();
const NO_TEXT: PublishedText = publishedTextOf("");

/** One block read as it settles: its key and fingerprint, and the identifiers it defines. */
function readSettledBlock(
  bodyText: PublishedText,
  range: MarkdownBlockRange,
  index: number,
): SettledMarkdownBlock {
  // Read here and let go: the record keeps only the range.
  const text = bodyText.slice(range.start, range.end);
  const fingerprint = fingerprintOf(text);
  return {
    key: `${String(index)}:${fingerprint}`,
    fingerprint,
    start: range.start,
    end: range.end,
    // Parsed alone and let go: only a block that could define a footnote is parsed at all.
    definedFootnoteIdentifiers: text.includes(FOOTNOTE_OPENER)
      ? collectFootnoteDefinitions(parseMarkdown(text).children).definedIdentifiers
      : NO_IDENTIFIERS,
  };
}

/** Every identifier these blocks define. */
function identifiersOf(blocks: readonly SettledMarkdownBlock[]): ReadonlySet<string> {
  return blocks.length === 0
    ? NO_IDENTIFIERS
    : new Set(blocks.flatMap((block) => [...block.definedFootnoteIdentifiers]));
}
