// The ledger cards' bounds: the two byte-bounded caches, the two highlighting
// thresholds, the footnote registry, the tool row's one line, and the ANSI body's
// first render.
//
// Spent under `ledger/cards/` and `ledger/markdown/`, declared here because
// `cap-constant-home` allows a bound exactly one declaring module; what stays beside
// those readers is the layout and lag figures that are not ceilings.

/**
 * Bytes of parsed-block cache the renderer retains, across every card.
 *
 * Bounded in bytes rather than in entries because the entries are markdown blocks and
 * their sizes span four orders of magnitude: a thousand one-line paragraphs and one
 * pasted file are the same entry count and not the same memory. Two mebibytes is
 * several long conversations' worth of settled prose at the ledger's density, and it
 * is charged against the source text rather than the node tree because the source is
 * what the cache is keyed by and the only figure it can measure without walking.
 */
export const MARKDOWN_BLOCK_CACHE_BYTE_CAP = 2_097_152;
/**
 * SOURCE bytes of highlighted code the token cache holds, across every code block.
 *
 * The token cache is byte-bounded. The bound is in source bytes because that is what
 * `byte-bounded-cache.ts` charges — it measures the KEY, which is the block's own text,
 * for the reason its header gives: a node tree's retained size cannot be had without
 * walking it. So this figure is sized with the retained tokens in mind rather than stated
 * in them. The measured ratio is 21.5x, and one mebibyte of retained tokens divided by it
 * is about 48,771 source bytes; 48,000 is that rounded down, so the tokens stay INSIDE
 * the mebibyte rather than a little past it. It is a screenful of fenced blocks in
 * scrollback, and far below the point where retaining them costs more than re-tokenising
 * them.
 *
 * THE CONSEQUENCE, NAMED RATHER THAN LEFT TO BE FOUND: a block between this cap and
 * `CODE_HIGHLIGHT_SOURCE_BYTE_CAP` is highlighted and NOT cached, because the cache
 * drops an entry larger than the whole cap rather than evicting everything else to hold
 * it. That is exactly what the highlight-source cap's own rationale below asserts, and
 * it is only true while this figure is stated in the units the cache charges.
 */
export const CODE_TOKEN_CACHE_BYTE_CAP = 48_000;
/**
 * Source bytes above which highlighting leaves the main thread.
 *
 * Highlighting runs in a Worker above about 4 kB of source. The measurement is the
 * reason — the JavaScript engine costs about 8.1 ms per 2,700 bytes, so 4,096 bytes is
 * the last size whose tokenisation still fits inside one 16.7 ms frame beside the
 * layout it has to leave room for.
 */
export const CODE_WORKER_THRESHOLD_BYTES = 4096;
/**
 * Source bytes above which a code block is not highlighted at all.
 *
 * The worker keeps a large block off the main thread; it does not make the block
 * cheap. Past a quarter mebibyte the tokens cost more than the whole retained cache
 * and the block is prose to the reader either way, so it renders as plain mono text
 * and says so — which is an absence naming its cause, applied to a capability rather
 * than to a row.
 */
export const CODE_HIGHLIGHT_SOURCE_BYTE_CAP = 262_144;
/**
 * Footnote definitions a single timeline's registry retains.
 *
 * This console keeps one popover host per timeline with a definition registry keyed by
 * source — `ledger/cards/markdown/footnotes/footnote-registry.ts` states why. Bounded
 * for the reason every cache in the console is: a definition belongs to the message
 * that carried it, and a log holds `LEDGER_WINDOW_ROW_CAP` rows, so a few definitions
 * per retained row is the whole reachable population and nothing above it can ever be
 * opened.
 */
export const FOOTNOTE_DEFINITION_CAP = 2048;
/**
 * Characters of a tool row's one-clause summary before it is elided.
 *
 * Tool rows render as one line until opened. What that one line carries — glyph, tool
 * name, a one-clause summary, elapsed, and the result state — is this console's own
 * composition; the line is the constraint, and at the ledger's measure and mono figure
 * column this is what fits beside the name and the elapsed without wrapping.
 */
export const TOOL_SUMMARY_MAX_CHARACTERS = 96;
/**
 * ANSI chunks one command-output body renders before the rest is folded away.
 *
 * `anser` yields one entry per style run, so a colour-heavy build log produces far more
 * entries than lines. The cap is on the mapped spans rather than on the source bytes
 * because the spans are what become DOM nodes.
 *
 * IT IS THE FIRST RENDER'S CAP AND NOT THE BLOCK'S CEILING. The rules every console
 * surface obeys are why: the fold has to be recoverable, and `AnsiOutput` is what makes
 * it so — the notice carries both figures and a control that re-parses the same source
 * under a cap that admits every run. A cap with no way past it would put the tail of a
 * colour-heavy command beyond reach, since reopening the card re-parses exactly the same
 * capped sequence.
 */
export const ANSI_SPAN_RENDER_CAP = 4096;
