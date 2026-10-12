// One markdown body's blocks as one frame draws them, which the body's reader hands its renderer
// and its row's preparation, and where a block's text starts in the body's.

import type { FootnoteDefinition, RootContent } from "mdast";

import type { ParsedMarkdown } from "#renderer/components/Markdown/parse/trees.js";
import type { BlockRecords } from "../block-records.js";

/** One body's blocks for one frame. */
export interface MarkdownBodyBlocksSnapshot {
  /** Counts the times the body's text was replaced rather than extended. */
  readonly generation: number;
  /** The drawn generation's blocks, the first `settledCount` drawn on their own. */
  readonly records: BlockRecords;
  /** How many of `records`' blocks are drawn on their own, each from its tree. */
  readonly settledCount: number;
  /** Whether the body draws: it drew its first frame, or a replaced one is still on screen. */
  readonly isDrawn: boolean;
  /** The drawn blocks that define a footnote, ascending: the ones whose definitions register. */
  readonly definingBlocks: readonly number[];
  /** The text drawn after the drawn blocks: the volatile tail, with any block still moving out. */
  readonly volatileTail: string;
  /** The drawn tail's nodes, or `undefined` before the body's first draw. */
  readonly tailNodes: readonly RootContent[] | undefined;
  /** The tail's own footnote definitions, read from the tail alone; none in most frames. */
  readonly volatileTailDefinitions: readonly FootnoteDefinition[];
  /** Every identifier the body defines: the same set until one is added or removed. */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
  /** The preamble a block defining none of the body's first link definitions is parsed after. */
  readonly definitionPreamble: string;
  /** Drawn block `index`'s text, cut from the body's text for a reader that lets it go. */
  readonly readBlockSource: (index: number) => string;
  /**
   * Drawn block `index`'s tree, parsed on the page at once and kept while the block is mounted, or
   * the worker's newest landed tree. Throws for a block that is not drawn.
   */
  readonly readBlockTree: (index: number) => ParsedMarkdown;
  /** As `readBlockTree`, for a reader that lets the tree go: a page tree it parses is not kept. */
  readonly readTransientBlockTree: (index: number) => ParsedMarkdown;
  /**
   * The definitions the tree of drawn block `index`, or of the tail past the drawn blocks, is
   * parsed after: what every offset in that tree counts before the block's own text.
   */
  readonly readDefinitionPreamble: (index: number) => string;
  /** Lets go of the page trees of every drawn block but those `mounted` names. */
  readonly keepPageTreesOf: (mounted: Iterable<number>) => void;
}

/**
 * Where block `index` of a body starts in the body's text, in UTF-16 code units: a drawn block's
 * own start, or the tail's, which runs to the body's end.
 */
export function blockSourceStartOf(
  blocks: Pick<MarkdownBodyBlocksSnapshot, "records" | "settledCount" | "volatileTail">,
  bodyTextLength: number,
  index: number,
): number {
  return index < blocks.settledCount
    ? blocks.records.startOf(index)
    : bodyTextLength - blocks.volatileTail.length;
}
