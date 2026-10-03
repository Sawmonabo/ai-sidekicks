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

/**
 * The fence info strings whose rendering waits for the block to settle: math and diagrams, both
 * wrong when fed a prefix. `mdast-util-gfm` gives neither its own node type, so the set is keyed
 * by the info string. A mermaid fence always renders as its source, since the app ships no
 * control that asks for a diagram, so no mermaid dependency exists.
 */
export const DEFERRED_FENCE_LANGUAGES = ["math", "latex", "tex", "mermaid"] as const;

const DEFERRED_FENCE_LANGUAGE_SET: ReadonlySet<string> = new Set(DEFERRED_FENCE_LANGUAGES);

/**
 * Whether a fenced block with this info string waits for the block to settle.
 *
 * The info string is lower-cased and cut at its first space, which is commonmark's own
 * reading of it: `mermaid {theme=dark}` declares `mermaid`.
 */
export function isDeferredFenceLanguage(infoString: string | null | undefined): boolean {
  if (infoString === null || infoString === undefined) {
    return false;
  }
  const [languageWord] = infoString.trim().toLowerCase().split(/\s+/u);
  return languageWord !== undefined && DEFERRED_FENCE_LANGUAGE_SET.has(languageWord);
}
