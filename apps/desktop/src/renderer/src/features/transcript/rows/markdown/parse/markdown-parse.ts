// Markdown parsing with `mdast-util-from-markdown` and GFM. `parseSettledBlock` is memoized;
// `parseVolatileTail` is not, and closes unterminated constructs with `remend` first.
// Types derive from the library so they follow the pinned version. `micromark` is not a direct
// dependency: `fromMarkdown` brings it in and no module here imports it.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import remend from "remend";

import { ByteBoundedCache } from "./byte-bounded-cache.js";

/** The document a parse produces. Derived from the parser, never restated. */
export type MarkdownRoot = ReturnType<typeof fromMarkdown>;

/** One top-level node. Derived from the root, so the union follows the pin. */
export type MarkdownBlockNode = MarkdownRoot["children"][number];

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
 * extension objects, and holding them at module scope would be a mutable singleton.
 */
function parseMarkdown(source: string): MarkdownRoot {
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

const settledBlockCache: ByteBoundedCache<MarkdownRoot> = new ByteBoundedCache<MarkdownRoot>(
  MARKDOWN_BLOCK_CACHE_BYTE_CAP,
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
 * tree under a different definition set.
 */
export function parseSettledBlock(blockSource: string, definitionPreamble = ""): MarkdownRoot {
  const cacheKey = settledBlockCacheKey(blockSource, definitionPreamble);
  const cached = settledBlockCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseAgainstDefinitions(blockSource, definitionPreamble);
  settledBlockCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * Parse the volatile tail, closing its unterminated constructs first.
 *
 * `remend` runs on the tail only: on a settled block it would rewrite finished text, and on the
 * whole message it would rewrite the committed prefix every frame. It runs before the preamble
 * is prepended so the synthetic definitions are never inspected or closed.
 */
export function parseVolatileTail(tailSource: string, definitionPreamble = ""): MarkdownRoot {
  return parseAgainstDefinitions(remend(tailSource, REMEND_OPTIONS), definitionPreamble);
}

/** The settled-block cache's size and cap, for the budget test. */
export function settledBlockCacheStats(): ReturnType<ByteBoundedCache<MarkdownRoot>["stats"]> {
  return settledBlockCache.stats();
}

/** The cache key, built in one place so store and lookup agree; no preamble keys on the source. */
function settledBlockCacheKey(blockSource: string, definitionPreamble: string): string {
  return definitionPreamble === ""
    ? blockSource
    : definitionPreamble + SETTLED_KEY_SEPARATOR + blockSource;
}

/**
 * Parse a block with the body's definitions in scope and return only the block's own nodes.
 *
 * The synthetic definitions are dropped by source offset, not identity: a block's real
 * `[^1]: …` has the same identifier as the synthetic one and must survive. Filtering runs
 * inside the memoized path so the array is stable and `SettledBlock`'s pointer comparison
 * still skips the subtree.
 */
function parseAgainstDefinitions(blockSource: string, definitionPreamble: string): MarkdownRoot {
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
import { MARKDOWN_BLOCK_CACHE_BYTE_CAP } from "../../../cards/card-caps.js";
