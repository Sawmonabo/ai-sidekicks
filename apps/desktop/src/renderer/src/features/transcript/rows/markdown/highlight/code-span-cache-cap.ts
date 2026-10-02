// The color spans' memory budget, sized to the machine.

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
