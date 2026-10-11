// Markdown parsing with `mdast-util-from-markdown` and GFM. `parseSettledBlock` is memoized, and
// `holdSettledBlock` keeps a block's parse past the cache's cap while it is held; a volatile tail
// is mended with `remend` and parsed uncached, by the transcript's tail parser.
// Types derive from the library so they follow the pinned version. `micromark` is not a direct
// dependency: `fromMarkdown` brings it in and no module here imports it.

import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import remend from "remend";

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";

/**
 * Bytes of parsed-block cache retained across every card, charged against the source text and
 * an estimate of the tree it parsed to. Bounded in bytes, not entries, because block sizes span
 * four orders of magnitude.
 */
const MARKDOWN_BLOCK_CACHE_BYTE_CAP = 2_097_152;

/**
 * What one parsed node holds on the heap, in bytes. Measured: 171 KB of prose, code and lists
 * parsed block by block held 5.36 MB in 12,172 nodes, 440 bytes a node, mostly the position
 * objects. Charging the source alone would let a full cache hold thirty times its cap.
 */
const MDAST_NODE_BYTE_ESTIMATE = 440;

/** The document a parse produces. Derived from the parser, never restated. */
export type MarkdownRoot = ReturnType<typeof fromMarkdown>;

/**
 * The options `remend` is given for the volatile tail.
 *
 * `inlineKatex` stays off because a lone `$` is ambiguous with a currency symbol. `linkMode`
 * stays `"protocol"` so an unfinished link becomes the sentinel URL the mapper renders as
 * plain text; `"text-only"` would drop the link text mid-stream and bring it back later.
 */
const REMEND_OPTIONS = { inlineKatex: false, linkMode: "protocol" } as const;

/**
 * One markdown parser configuration, built per call: `gfm()` and `gfmFromMarkdown()` construct
 * extension objects, and holding them at module scope would be a mutable singleton. Uncached, for
 * a whole document read once, such as a reply being copied.
 */
export function parseMarkdown(source: string): MarkdownRoot {
  return fromMarkdown(source, {
    // A single tilde is never strikethrough, so a figure like `~240MB` or a path under `~`
    // stays the text the agent wrote; the library reads one tilde as strikethrough by default.
    extensions: [gfm({ singleTilde: false })],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

const settledBlockCache: ByteBoundedCache<MarkdownRoot> = new ByteBoundedCache<MarkdownRoot>(
  MARKDOWN_BLOCK_CACHE_BYTE_CAP,
  (root) => countNodes(root) * MDAST_NODE_BYTE_ESTIMATE,
);

/**
 * What separates the synthetic definitions from the block's own text.
 *
 * A blank line is not enough: a footnote definition takes indented lines after a blank one as
 * its continuation, so it would swallow a block that opens on indented code. An HTML comment
 * at column zero ends the definition and is dropped with the preamble.
 */
const FOOTNOTE_PREAMBLE_TERMINATOR = "\n<!---->\n\n";

/**
 * What joins the two halves of a settled block's cache key. NUL occurs in neither half
 * (commonmark replaces a literal NUL with U+FFFD before parsing), so two different pairs never
 * concatenate to one key.
 */
const SETTLED_KEY_SEPARATOR = "\u0000";

/**
 * One settled block's parse, held in the cache whatever its size until `release`, so the body that
 * draws the block next parses it no second time: `parseSettledBlock` answers this tree.
 */
export interface HeldSettledBlock {
  readonly root: MarkdownRoot;
  /** Lets the tree go; a second call does nothing, so no holder frees another's hold. */
  readonly release: () => void;
}

/** What one block of a body was parsed from: its text, and the definitions it was parsed after. */
export interface BlockParseSource {
  readonly source: string;
  readonly definitionPreamble: string;
  /** Whether it is the body's streaming tail, which is mended before it is parsed. */
  readonly isVolatileTail: boolean;
}

/**
 * The definitions a block is parsed against, as a minimal document preamble.
 *
 * GFM resolves `[^1]` only against definitions in its own document, and a lone reference
 * becomes literal text no later pass can upgrade. Every identifier the whole body declares is
 * therefore restated, body-less, ahead of each block. Sorted so the same set yields the same
 * bytes and cache key; a body with no footnotes gets `""`, leaving its key unchanged.
 */
export function footnoteDefinitionPreamble(definedIdentifiers: ReadonlySet<string>): string {
  if (definedIdentifiers.size === 0) {
    return "";
  }
  const definitionLines = [...definedIdentifiers]
    .sort()
    .map((identifier) => `[^${identifier}]:\n`)
    .join("");
  return definitionLines + FOOTNOTE_PREAMBLE_TERMINATOR;
}

/**
 * Parse one settled block against the definitions the whole body declared.
 *
 * Memoized on the text and the preamble together, since the same text parses to a different
 * tree under a different definition set. The cache keeps a copy of the text, never the caller's
 * string, which may be a cut of a much longer one.
 */
export function parseSettledBlock(blockSource: string, definitionPreamble = ""): MarkdownRoot {
  const cached = settledBlockCache.get(settledBlockCacheKey(blockSource, definitionPreamble));
  if (cached !== undefined) {
    return cached;
  }
  // The tree's text values are cuts of what it was parsed from, and the key outlives the call:
  // both would keep a cut's whole parent string alive, so both read the cache's own copy.
  const ownSource = structuredClone(blockSource);
  const parsed = parseAgainstDefinitions(ownSource, definitionPreamble);
  settledBlockCache.set(settledBlockCacheKey(ownSource, definitionPreamble), parsed);
  return parsed;
}

/**
 * Parse one settled block as `parseSettledBlock` does, and hold its tree in the cache until the
 * hold is released. What bounds the held trees is their holders: the rows being prepared or
 * listed, each releasing its hold when the window lets the row go.
 */
export function holdSettledBlock(blockSource: string, definitionPreamble = ""): HeldSettledBlock {
  const key = settledBlockCacheKey(blockSource, definitionPreamble);
  let root = settledBlockCache.get(key);
  if (root === undefined || !settledBlockCache.hold(key)) {
    const ownSource = structuredClone(blockSource);
    root = parseAgainstDefinitions(ownSource, definitionPreamble);
    settledBlockCache.setHeld(settledBlockCacheKey(ownSource, definitionPreamble), root);
  }
  let isReleased = false;
  return {
    root,
    release: () => {
      if (!isReleased) {
        isReleased = true;
        settledBlockCache.release(key);
      }
    },
  };
}

/**
 * The volatile tail with its unterminated constructs closed, ready to parse.
 *
 * `remend` runs on the tail only: on a settled block it would rewrite finished text, and on the
 * whole message it would rewrite the committed prefix every frame. It runs before any preamble
 * is prepended so the synthetic definitions are never inspected or closed.
 */
export function mendVolatileTail(tailSource: string): string {
  return remend(tailSource, REMEND_OPTIONS);
}

/**
 * Parse a block with the body's definitions in scope and return only the block's own nodes.
 *
 * The synthetic definitions are dropped by source offset, not identity: a block's real
 * `[^1]: …` has the same identifier as the synthetic one and must survive. Every offset in the
 * result counts the preamble, so a node's start offset minus the preamble's length is where it
 * starts in the block. Filtering runs inside the memoized path so the array is stable and
 * `SettledBlock`'s pointer comparison still skips the subtree.
 */
export function parseAgainstDefinitions(
  blockSource: string,
  definitionPreamble: string,
): MarkdownRoot {
  if (definitionPreamble === "") {
    return parseMarkdown(blockSource);
  }
  const parsed = parseMarkdown(definitionPreamble + blockSource);
  return {
    ...parsed,
    children: parsed.children.filter(
      (child) => (child.position?.start.offset ?? 0) >= definitionPreamble.length,
    ),
  };
}

/**
 * The tree a block's parse made, made again from what it was parsed from: the same nodes, offsets
 * included, as the screen drew from it. Uncached, for a reader that needs it once.
 */
export function parseBlockAgain(parseSource: BlockParseSource): MarkdownRoot {
  return parseAgainstDefinitions(
    parseSource.isVolatileTail ? mendVolatileTail(parseSource.source) : parseSource.source,
    parseSource.definitionPreamble,
  );
}

/** The cache key, built in one place so store and lookup agree; no preamble keys on the source. */
function settledBlockCacheKey(blockSource: string, definitionPreamble: string): string {
  return definitionPreamble === ""
    ? blockSource
    : definitionPreamble + SETTLED_KEY_SEPARATOR + blockSource;
}

/** How many nodes a tree holds, itself included: what its heap charge is counted in. */
function countNodes(node: Nodes): number {
  if (!("children" in node)) {
    return 1;
  }
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}
