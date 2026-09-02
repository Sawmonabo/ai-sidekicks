// The ledger cards' named bounds.
//
// `core/constants.ts` holds the substrate's domains and says in its own header that
// "each view family adds its own module beside its subtree rather than widening this
// one, so a bound always sits next to the code that spends it". `ledger/frame/
// frame-bounds.ts` is that module for the frame; this is it for the cards, and every
// bound below has a spender in this directory or under `markdown/`.
//
// A number that appears inline in this subtree and is not a layout literal is a
// review rejection: the rationale is the point, not the constant.

/**
 * Complete blocks held back from the settled set, behind the incomplete tail.
 *
 * `Spec-023 §Console Design (Meridian)` §5.14: "settled blocks parse once with a
 * two-block settle lag". Two, because a block boundary is not final when it is first
 * seen — a blank line after a paragraph becomes the inside of a list the moment the
 * next line starts with a marker, and a setext underline turns the paragraph above it
 * into a heading. One block of lag closes the setext case and not the list case; two
 * closes both, and a third would only delay memoisation without closing anything the
 * commonmark block grammar can still reinterpret.
 */
export const MARKDOWN_SETTLE_LAG_BLOCKS = 2;

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
 * `Spec-023 §Console Libraries`, syntax-highlighting row: "byte-bounded token cache".
 * The bound is in source bytes because that is what `byte-bounded-cache.ts` charges —
 * it measures the KEY, which is the block's own text, for the reason its header gives:
 * a node tree's retained size cannot be had without walking it. So this figure is sized
 * with the retained tokens in mind rather than stated in them. That row's measurement is
 * 21.5x, and one mebibyte of retained tokens divided by it is about 48,771 source bytes;
 * 48,000 is that rounded down, so the tokens stay INSIDE the mebibyte rather than a
 * little past it. It is a screenful of fenced blocks in scrollback, and far below the
 * point where retaining them costs more than re-tokenising them.
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
 * `Spec-023 §Console Libraries`: "in a Worker above about 4 kB of source". The row's
 * own measurement is the reason — the JavaScript engine costs about 8.1 ms per 2,700 bytes,
 * so 4,096 bytes is the last size whose tokenisation still fits inside one 16.7 ms frame
 * beside the layout it has to leave room for.
 */
export const CODE_WORKER_THRESHOLD_BYTES = 4096;

/**
 * Source bytes above which a code block is not highlighted at all.
 *
 * The worker keeps a large block off the main thread; it does not make the block
 * cheap. Past a quarter mebibyte the tokens cost more than the whole retained cache
 * and the block is prose to the reader either way, so it renders as plain mono text
 * and says so — which is the honest reading of `Spec-023 §Console Design (Meridian)`
 * rule 8's "an absence names its cause" applied to a capability rather than to a row.
 */
export const CODE_HIGHLIGHT_SOURCE_BYTE_CAP = 262_144;

/**
 * Footnote definitions one timeline's registry retains.
 *
 * `Spec-023 §Console Design (Meridian)` §5.14 puts "one popover host per timeline with
 * a definition registry keyed by source". Bounded for the reason every cache in the
 * console is: a definition belongs to the message that carried it, and a log holds
 * `LEDGER_WINDOW_ROW_CAP` rows, so a few definitions per retained row is the whole
 * reachable population and nothing above it can ever be opened.
 */
export const FOOTNOTE_DEFINITION_CAP = 2048;

/**
 * Characters of a tool row's one-clause summary before it is elided.
 *
 * `Spec-023 §Console Design (Meridian)` §5.9: "Every tool row is one line until
 * opened: glyph, tool name, a one-clause summary, elapsed, and the result state." One
 * line is the constraint; at the ledger's measure and mono figure column this is what
 * fits beside the name and the elapsed without wrapping.
 */
export const TOOL_SUMMARY_MAX_CHARACTERS = 96;

/**
 * ANSI chunks one command-output body renders before the rest is folded away.
 *
 * `anser` yields one entry per style run, so a colour-heavy build log produces far more
 * entries than lines. The cap is on the mapped spans rather than on the source bytes
 * because the spans are what become DOM nodes, and the fold is recoverable — the body
 * says how much is shown and offers the rest, per §5.9's payload-expansion rule.
 */
export const ANSI_SPAN_RENDER_CAP = 4096;
