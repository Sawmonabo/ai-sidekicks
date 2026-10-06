// Figures for the markdown segmenter that are not memory ceilings; the block cache's byte ceiling
// is in `components/Markdown/parse.ts`.

/**
 * Complete blocks held back from the settled set, behind the incomplete tail.
 *
 * Two, because a block boundary is not final when first seen: a setext underline turns the
 * paragraph above it into a heading, and a marker line makes the blank line before it the
 * inside of a list. One block of lag closes the setext case, two close both, and a third
 * would only delay memoization.
 */
export const MARKDOWN_SETTLE_LAG_BLOCKS = 2;
