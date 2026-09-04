// The parse — micromark through `mdast-util-from-markdown`, with GFM, once per block.
//
// `Spec-023 §Console Libraries`, streaming-markdown row: "ADOPT micromark +
// `mdast-util-from-markdown` with GFM; ADOPT-with-constraints remend (tail only)". The
// GFM extensions are the pair that row names — `micromark-extension-gfm` for the syntax
// and `mdast-util-gfm` for the tree — and they are what make footnotes, tables,
// strikethrough, task list items, and autolinks reachable at all.
//
// `micromark` itself is not a direct dependency of this package. It is the engine
// `fromMarkdown` runs and arrives as that package's own dependency; adding it beside
// them would be a manifest entry no module imports, which the dead-code gate reports as
// an unused dependency and `apps/desktop/AGENTS.md` refuses to exempt.
//
// TWO ENTRY POINTS, AND THE DIFFERENCE IS THE WHOLE DESIGN.
//
//   • `parseSettledBlock` is memoised. A settled block's text never changes again, so
//     its tree is computed once and kept until the byte cap evicts it. This is the half
//     that makes a long message cheap.
//   • `parseVolatileTail` is not memoised and is `remend`ed first. It changes every
//     frame by construction, so a cache keyed on it would be a cache that never hits
//     and grows without bound — the failure mode the byte cap exists to prevent, reached
//     by caching the wrong half.
//
// THE TYPES ARE DERIVED FROM THE LIBRARY rather than imported from `@types/mdast`
// directly at the node level, so this module and its mapper cannot drift from what
// `fromMarkdown` actually returns at the pinned version.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import remend from "remend";

import { MARKDOWN_BLOCK_CACHE_BYTE_CAP } from "../card-bounds.js";
import { ByteBoundedCache } from "./byte-bounded-cache.js";

/** The document a parse produces. Derived from the parser, never restated. */
export type MarkdownRoot = ReturnType<typeof fromMarkdown>;

/** One top-level node. Derived from the root, so the union follows the pin. */
export type MarkdownBlockNode = MarkdownRoot["children"][number];

/**
 * The options `remend` is given for the volatile tail.
 *
 * Two are deliberately off the library's default:
 *
 *   • `inlineKatex` stays `false` (the library's own default) because a lone `$` is
 *     ambiguous with a currency symbol, and closing it would turn "it cost $5" into an
 *     unterminated formula the moment a second `$` never arrives.
 *   • `linkMode` stays `"protocol"`, so an unfinished link becomes the sentinel URL the
 *     mapper recognises. `"text-only"` would drop the link's own text mid-stream and
 *     then re-introduce it, which is the flicker `markdown-rules.ts` rule 1 forbids.
 */
const REMEND_OPTIONS = { inlineKatex: false, linkMode: "protocol" } as const;

/**
 * One markdown parser configuration, built per call.
 *
 * A function rather than a module-level constant because `gfm()` and `gfmFromMarkdown()`
 * each construct extension objects, and a module-level `const` holding them would be
 * exactly the module-scope mutable singleton `apps/desktop/AGENTS.md` rejects. The cost
 * is object construction beside a parse that is already the expensive part.
 */
function parseMarkdown(source: string): MarkdownRoot {
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/**
 * The settled-block cache.
 *
 * One per renderer process, and a `const` holding a class instance rather than a
 * module-level `Map`: the state is inside the object, the bound travels with it, and a
 * test constructs its own rather than reaching for this one.
 */
const settledBlockCache: ByteBoundedCache<MarkdownRoot> = new ByteBoundedCache<MarkdownRoot>(
  MARKDOWN_BLOCK_CACHE_BYTE_CAP,
);

/**
 * What separates the synthetic definitions from the block's own text.
 *
 * A blank line alone is not enough. A footnote definition takes INDENTED lines after a
 * blank one as its own continuation, so a preamble ending in a blank line would swallow
 * a block that opens on four-space indented code — the author's command line would
 * disappear into a note nothing renders. An HTML comment at column zero ends the
 * definition, is dropped with the rest of the preamble by the offset rule below, and
 * would be visible as its own characters rather than as markup if it ever were not.
 */
const FOOTNOTE_PREAMBLE_TERMINATOR = "\n<!---->\n\n";

/**
 * What joins the two halves of a settled block's cache key.
 *
 * NUL, for the reason `footnote-registry.ts` gives about its own composite key: it
 * occurs in neither half, because commonmark replaces a literal NUL with U+FFFD before
 * any of this text is parsed, so no preamble and no block body can carry one and two
 * different pairs cannot concatenate to one key. Written as an escape rather than typed,
 * so a reader and a diff can both see it.
 */
const SETTLED_KEY_SEPARATOR = "\u0000";

/**
 * The definitions a block is parsed AGAINST, as a minimal document preamble.
 *
 * GFM resolves `[^1]` against the definitions in its own document, so a block holding
 * only the reference yields no `footnoteReference` node at all — it yields the literal
 * characters, and no later pass can upgrade a text node into a reference. A message is
 * one document to its author and N documents to this pipeline, and this is what closes
 * that gap: every identifier the WHOLE body declares is restated, body-less, ahead of
 * each block, so a reference resolves wherever its definition settled.
 *
 * Sorted, so the same identifier set yields the same bytes and the same cache key
 * whatever order the blocks arrived in. Body-less, because the real definition's own
 * block still carries its body and is what registers it — a synthetic line is only ever
 * asked to make the identifier exist.
 *
 * A body declaring no footnotes gets `""` here, which is the whole point: its parse
 * input and its cache key are then byte-identical to what they were before any of this
 * existed, so only a footnote-bearing body pays anything.
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
 * Parse one settled block, once, against the definitions the whole body declared.
 *
 * Repeat calls with the same text AND the same preamble reuse the tree. The preamble is
 * part of the key because the same block text yields a different tree under a different
 * definition set — a paragraph citing `[^1]` is a reference node once that definition
 * has arrived somewhere in the message and a run of literal characters before it.
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
 * `remend` is applied HERE and nowhere else — the "tail only" half of its
 * ADOPT-with-constraints row. Running it over a settled block would rewrite text that is
 * already complete, and running it over the whole message would rewrite the committed
 * prefix on every frame, which is the quadratic behaviour the split exists to avoid.
 *
 * It runs on the tail BEFORE the preamble is prepended, so the synthetic definitions are
 * never among the constructs it inspects or closes.
 */
export function parseVolatileTail(tailSource: string, definitionPreamble = ""): MarkdownRoot {
  return parseAgainstDefinitions(remend(tailSource, REMEND_OPTIONS), definitionPreamble);
}

/**
 * The cache key, in one place, so a store and a lookup cannot disagree.
 *
 * The empty preamble takes the block source unaltered rather than a separator-prefixed
 * form of it, which is what makes a footnote-free body's key — and therefore its byte
 * cost and its hit rate — byte-identical to what this cache held before the preamble
 * existed. Only a footnote-bearing body pays the re-key when a new definition arrives.
 */
function settledBlockCacheKey(blockSource: string, definitionPreamble: string): string {
  return definitionPreamble === ""
    ? blockSource
    : definitionPreamble + SETTLED_KEY_SEPARATOR + blockSource;
}

/**
 * Parse a block with the body's definitions in scope, and return only the block's nodes.
 *
 * The synthetic definitions are dropped by OFFSET rather than by identity: mdast carries
 * a source position on every node, so a child starting at or past the preamble's length
 * is one the block's own text produced. Identity would be the wrong test — a block that
 * carries the real `[^1]: …` definition produces a `footnoteDefinition` for the same
 * identifier as the synthetic one, and that one is the author's and must survive.
 *
 * The filter runs inside the memoised path, so the array a caller holds is stable across
 * renders and `SettledBlock`'s pointer comparison still skips the whole subtree.
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

/** What the settled-block cache is holding. For the budget test, and for nothing else. */
export function settledBlockCacheStats(): ReturnType<ByteBoundedCache<MarkdownRoot>["stats"]> {
  return settledBlockCache.stats();
}
