// The markdown policy as values a test can assert and the mapper can be handed. Model HTML is
// never rendered (nothing is parsed as markup, so there is no sanitizer), and no link is
// clickable because there are no wire-validated path references. Math and diagram fences wait
// for their block to settle.

/**
 * The URL `remend` writes into a link whose target has not finished arriving, copied verbatim
 * from the library. The mapper renders such a link as its text with no anchor, like any other.
 *
 * @consumedBy live links in a reply, which hold a half-typed link as its text
 */
export const INCOMPLETE_LINK_SENTINEL = "streamdown:incomplete-link";

/** What a deferred fence holds: a formula, or a diagram, which always renders as its source. */
type DeferredFenceKind = "math" | "diagram";

/**
 * The fence info strings whose rendering waits for the block to settle, and what each holds: math
 * and diagrams, both wrong when fed a prefix. `mdast-util-gfm` gives neither its own node type, so
 * the table is keyed by the info string.
 */
const DEFERRED_FENCE_KIND_BY_LANGUAGE: ReadonlyMap<string, DeferredFenceKind> = new Map([
  ["math", "math"],
  ["latex", "math"],
  ["tex", "math"],
  ["mermaid", "diagram"],
] satisfies readonly (readonly [string, DeferredFenceKind])[]);

/**
 * What a fenced block with this info string holds, where it waits for the block to settle, or
 * `undefined` for a fence that renders as code at once.
 *
 * The info string is lower-cased and cut at its first space, which is commonmark's own
 * reading of it: `mermaid {theme=dark}` declares `mermaid`.
 */
export function readDeferredFenceKind(
  infoString: string | null | undefined,
): DeferredFenceKind | undefined {
  if (infoString === null || infoString === undefined) {
    return undefined;
  }
  const [languageWord] = infoString.trim().toLowerCase().split(/\s+/u);
  return languageWord === undefined ? undefined : DEFERRED_FENCE_KIND_BY_LANGUAGE.get(languageWord);
}
