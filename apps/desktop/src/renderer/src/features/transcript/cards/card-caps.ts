// The transcript cards' bounds: the two byte-bounded caches, the footnote registry, the tool
// row's one line, and the ANSI body's first render. Each bound is declared here once; the
// layout figures that are not ceilings stay beside their readers.

/**
 * Bytes of parsed-block cache retained across every card. Bounded in bytes, not entries,
 * because block sizes span four orders of magnitude; charged against the source text, which
 * is the cache key.
 */
export const MARKDOWN_BLOCK_CACHE_BYTE_CAP = 2_097_152;
/** The share of physical memory the color spans take: one part in this many. */
const CODE_SPAN_MEMORY_SHARE = 2048;
/** The least the color spans are given, 4 MiB, whatever the machine. */
const CODE_SPAN_CACHE_FLOOR_BYTES = 4 * 1024 * 1024;
/** The most the color spans are given, 16 MiB, whatever the machine. */
const CODE_SPAN_CACHE_CEILING_BYTES = 16 * 1024 * 1024;

/**
 * Bytes of color spans the code blocks keep across every block, source counted beside its
 * packed spans: 1/2048 of physical memory, held between 4 and 16 MiB. The source is charged
 * because the cache keeps it as the key; at about 0.3 bytes of spans per source byte the
 * floor colors a little over 3 MiB of code.
 */
export function codeSpanCacheByteCap(physicalMemoryBytes: number): number {
  return Math.min(
    CODE_SPAN_CACHE_CEILING_BYTES,
    Math.max(CODE_SPAN_CACHE_FLOOR_BYTES, Math.floor(physicalMemoryBytes / CODE_SPAN_MEMORY_SHARE)),
  );
}

/**
 * Footnote definitions one transcript's registry retains. A definition belongs to a message
 * and a log holds `TRANSCRIPT_WINDOW_ROW_CAP` rows, so a few per retained row is everything
 * that can be opened.
 */
export const FOOTNOTE_DEFINITION_CAP = 2048;
/**
 * Characters of a tool row's one-clause summary before it is elided; at the transcript's
 * measure this is what fits beside the name and elapsed time without wrapping.
 */
export const TOOL_SUMMARY_MAX_CHARACTERS = 96;
/**
 * ANSI chunks one command-output body renders before the rest is folded away. `anser` yields
 * one entry per style run, so the cap is on the mapped spans, which become DOM nodes. It is
 * the first render's cap, not a ceiling: `AnsiOutput` offers a control that re-parses the
 * source under a cap admitting every run, because reopening re-parses the same capped sequence.
 */
export const ANSI_SPAN_RENDER_CAP = 4096;
