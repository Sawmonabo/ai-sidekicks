// The markdown rules — `Spec-023 §Console Libraries`' streaming-markdown and
// math-and-diagrams rows as decisions rather than as prose, plus the two rules this
// console owns because no committed document states them.
//
// The PIPELINE lives under `markdown/`: the segmenter, the parse, the mapper, the
// footnote registry, the highlighter. This module is the policy that pipeline obeys,
// and it is separate for one reason — every rule below is a claim about what the
// console may and may not render, and a claim that lives inside the machinery that
// implements it can only be checked by reading the machinery. Here it is a value a
// test can assert against and a mapper can be handed.
//
// THE FIVE RULES, EACH WITH ITS OWN CONSEQUENCE.
//
//   1. **A committed-and-volatile split.** The committed prefix is memoised and
//      stable; the volatile tail is the reveal engine's, and an incomplete construct
//      never mounts. `MARKDOWN_SETTLE_LAG_BLOCKS` is the lag; `remend` closes the
//      tail's unterminated constructs so a half-open `**` renders as bold-in-progress
//      rather than italicising the rest of the message.
//   2. **Mermaid and math are deferred until the block settles.** Both are expensive
//      and both are wrong when fed a prefix: half a formula is not a formula, and a
//      diagram redrawn per token is a strobe. So a volatile math block renders as the
//      source it currently is, in mono, and becomes a formula when it settles.
//   3. **Model HTML is never rendered.** `mdast-util-gfm` delivers raw HTML as `html`
//      nodes at block and inline level; the mapper renders their literal text. That is
//      why NO SANITIZER IS ON THIS PATH — there is nothing to sanitise, because
//      nothing is ever parsed as markup. A sanitizer here would be the console
//      claiming it renders model HTML safely, which it does not do at all.
//   4. **Path links come only from wire-validated path references.** Today there are
//      none: `Plan-023 §Console growth slate` carries `timeline-path-reference`
//      ("validated path-reference member on timeline rows", owned by Spec-013,
//      `wireRegistered: false`). This module's own fallback is then binding — a
//      surface with no validated allowlist ships no path links — so a link renders as
//      its own text and nothing is clickable.
//   5. **Footnotes resolve through one registry keyed by source**, so a definition
//      line never resolves as its own body.

import { growthSlateRow, type GrowthSlateRow } from "../../bridge/index.js";

/**
 * The URL `remend` writes into a link whose target has not finished arriving.
 *
 * A verbatim copy of the library's sentinel rather than a re-derivation, because the
 * two sides of one seam share a module and this is the console's side of `remend`'s.
 * A link carrying it is a link the stream has not finished, and the mapper renders its
 * text with no anchor — the same disposition rule 4 gives every other link, reached
 * for a different reason.
 */
export const INCOMPLETE_LINK_SENTINEL = "streamdown:incomplete-link";

/**
 * The slate row that would make path links renderable, named so the absence points at
 * its owner rather than at a shrug.
 *
 * Read off the ledger through its own accessor rather than spelled as a literal: the
 * slate is the one place a row's wire, owner, and live status are stated, and a second
 * spelling here would be a claim that stops agreeing with it the day the wire lands.
 * The lookup is total over the id union, so the row is a value and never a maybe.
 */
export const PATH_LINK_SLATE_ROW: GrowthSlateRow = growthSlateRow("timeline-path-reference");

/**
 * Whether this console may render a clickable path link.
 *
 * A function over the ledger rather than a constant `false`, so the day
 * `timeline-path-reference` flips `wireRegistered` the answer changes with it and the
 * per-load nonce and allow-list rule 4 requires become the only remaining work. It is
 * fail-closed by construction: a row the ledger does not carry could not make this
 * true, and neither can any value a message body contains.
 */
export function arePathLinksRenderable(): boolean {
  return PATH_LINK_SLATE_ROW.wireRegistered;
}

/**
 * The mdast node types whose rendering waits for the block to settle.
 *
 * Math and diagrams, and nothing else. Both are rule 2's subject and both fail the
 * same way on a prefix. `mdast-util-gfm` emits neither as its own node type — math
 * arrives as `code` with a `math` language or as inline text, and mermaid as a `code`
 * node with the `mermaid` language — so the set is keyed by the fence's INFO STRING,
 * which is the only place either declares itself.
 *
 * Mermaid sits here permanently rather than until a renderer arrives.
 * `Spec-023 §Console Libraries` makes diagrams "opt-in, lazy, strict, user-triggered",
 * and opt-in plus user-triggered together mean a diagram is never drawn because a
 * message contained one. This console ships no control that asks for one, so a mermaid
 * fence renders as its source — which is exactly what deferral already does for it,
 * and why no mermaid dependency is on this package.
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
