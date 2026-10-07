// The markdown policy as values a test can assert and the mapper can be handed. Model HTML is
// never rendered (nothing is parsed as markup, so there is no sanitizer), and no link is
// clickable because there are no wire-validated path references. A math fence and a mermaid
// diagram fence show their source until their block settles, then draw as a formula or a picture.

/**
 * The URL `remend` writes into a link whose target has not finished arriving, copied verbatim
 * from the library. The mapper renders such a link as its text with no anchor, like any other.
 *
 * @consumedBy live links in a reply, which hold a half-typed link as its text
 */
export const INCOMPLETE_LINK_SENTINEL = "streamdown:incomplete-link";

/**
 * The fence info strings whose rendering waits for the block to settle, and what each one is:
 * math and mermaid diagrams, both wrong when fed a prefix. `mdast-util-gfm` gives neither its own
 * node type, so the set is keyed by the info string. A diagram fence shows its source while it
 * streams and is drawn as a picture once settled, so mermaid never parses a half-written diagram.
 */
export const DEFERRED_FENCE_KINDS = {
  math: "math",
  latex: "math",
  tex: "math",
  mermaid: "diagram",
} as const;

/** What a deferred fence draws once its block settles: a formula or a diagram. */
export type DeferredFenceKind = (typeof DEFERRED_FENCE_KINDS)[keyof typeof DEFERRED_FENCE_KINDS];

/**
 * What a fenced block with this info string waits to draw, or `undefined` for a fence that does
 * not wait, which is code.
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
  return languageWord !== undefined && Object.hasOwn(DEFERRED_FENCE_KINDS, languageWord)
    ? DEFERRED_FENCE_KINDS[languageWord as keyof typeof DEFERRED_FENCE_KINDS]
    : undefined;
}
