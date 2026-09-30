// The transcript cards' bounds: the two byte-bounded caches, the footnote registry,
// the tool row's one line, and the ANSI body's first render.
//
// Spent under `rows/` (`rows/markdown/`, `rows/ansi/` and `ToolRow.tsx`), declared here so
// each bound has one declaring module; what stays beside those readers is the layout and
// lag figures that are not ceilings.

/**
 * Bytes of parsed-block cache the renderer retains, across every card.
 *
 * Bounded in bytes rather than in entries because the entries are markdown blocks and
 * their sizes span four orders of magnitude: a thousand one-line paragraphs and one
 * pasted file are the same entry count and not the same memory. Two mebibytes is
 * several long conversations' worth of settled prose at the transcript's density, and it
 * is charged against the source text rather than the node tree because the source is
 * what the cache is keyed by and the only figure it can measure without walking.
 */
export const MARKDOWN_BLOCK_CACHE_BYTE_CAP = 2_097_152;
/** The share of physical memory the color spans take: one part in this many. */
const CODE_SPAN_MEMORY_SHARE = 2048;
/** The least the color spans are given, 4 MiB, whatever the machine. */
const CODE_SPAN_CACHE_FLOOR_BYTES = 4 * 1024 * 1024;
/** The most the color spans are given, 16 MiB, whatever the machine. */
const CODE_SPAN_CACHE_CEILING_BYTES = 16 * 1024 * 1024;

/**
 * Bytes of color spans the code blocks keep, across every code block, counting each
 * block's source beside its packed spans: 1/2048 of the machine's physical memory, held
 * between 4 and 16 MiB, which is the screen's budget for color spans.
 *
 * The source is charged as well as the spans because the cache keeps it as the key, so
 * what the cache holds stays inside the budget. At a transcript's usual blocks, about 0.3
 * bytes of spans per byte of source, the 4 MiB floor colors a little over three mebibytes
 * of code without asking again.
 */
export function codeSpanCacheByteCap(physicalMemoryBytes: number): number {
  return Math.min(
    CODE_SPAN_CACHE_CEILING_BYTES,
    Math.max(CODE_SPAN_CACHE_FLOOR_BYTES, Math.floor(physicalMemoryBytes / CODE_SPAN_MEMORY_SHARE)),
  );
}

/**
 * Footnote definitions a single transcript's registry retains.
 *
 * This console keeps one popover host per transcript with a definition registry keyed by
 * source — `rows/markdown/footnotes/footnote-registry.ts` states why. Bounded
 * for the reason every cache in the console is: a definition belongs to the message
 * that carried it, and a log holds `TRANSCRIPT_WINDOW_ROW_CAP` rows, so a few definitions
 * per retained row is the whole reachable population and nothing above it can ever be
 * opened.
 */
export const FOOTNOTE_DEFINITION_CAP = 2048;
/**
 * Characters of a tool row's one-clause summary before it is elided.
 *
 * Tool rows render as one line until opened. What that one line carries — glyph, tool
 * name, a one-clause summary, elapsed, and the result state — is this console's own
 * composition; the line is the constraint, and at the transcript's measure and mono figure
 * column this is what fits beside the name and the elapsed without wrapping.
 */
export const TOOL_SUMMARY_MAX_CHARACTERS = 96;
/**
 * ANSI chunks one command-output body renders before the rest is folded away.
 *
 * `anser` yields one entry per style run, so a color-heavy build log produces far more
 * entries than lines. The cap is on the mapped spans rather than on the source bytes
 * because the spans are what become DOM nodes.
 *
 * IT IS THE FIRST RENDER'S CAP AND NOT THE BLOCK'S CEILING. Every fold in the console
 * can be opened past, so this one has to be recoverable too, and `AnsiOutput` is what makes
 * it so — the notice carries both figures and a control that re-parses the same source
 * under a cap that admits every run. A cap with no way past it would put the tail of a
 * color-heavy command beyond reach, since reopening the card re-parses exactly the same
 * capped sequence.
 */
export const ANSI_SPAN_RENDER_CAP = 4096;
