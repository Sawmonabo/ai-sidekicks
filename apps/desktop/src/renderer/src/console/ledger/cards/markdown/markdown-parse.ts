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
 *     then re-introduce it, which is the flicker §5.14 forbids.
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

/** Parse one settled block, once. Repeat calls with the same text reuse the tree. */
export function parseSettledBlock(blockSource: string): MarkdownRoot {
  const cached = settledBlockCache.get(blockSource);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseMarkdown(blockSource);
  settledBlockCache.set(blockSource, parsed);
  return parsed;
}

/**
 * Parse the volatile tail, closing its unterminated constructs first.
 *
 * `remend` is applied HERE and nowhere else — the "tail only" half of its
 * ADOPT-with-constraints row. Running it over a settled block would rewrite text that is
 * already complete, and running it over the whole message would rewrite the committed
 * prefix on every frame, which is the quadratic behaviour the split exists to avoid.
 */
export function parseVolatileTail(tailSource: string): MarkdownRoot {
  return parseMarkdown(remend(tailSource, REMEND_OPTIONS));
}

/** What the settled-block cache is holding. For the budget test, and for nothing else. */
export function settledBlockCacheStats(): ReturnType<ByteBoundedCache<MarkdownRoot>["stats"]> {
  return settledBlockCache.stats();
}
