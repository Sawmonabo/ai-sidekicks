// The pictures' memory budget, sized to the machine.

/** The share of physical memory the pictures take: one part in this many. */
const PICTURE_MEMORY_SHARE = 64;
/** The most the pictures are given, 256 MiB, whatever the machine. */
const PICTURE_CACHE_CEILING_BYTES = 256 * 1024 * 1024;

/**
 * Bytes of pictures the screen keeps across every window: 1/64 of physical memory, at most
 * 256 MiB, so a 16 GiB machine keeps 256 MiB and an 8 GiB one 128 MiB.
 */
export function pictureCacheByteCap(physicalMemoryBytes: number): number {
  return Math.min(
    PICTURE_CACHE_CEILING_BYTES,
    Math.floor(physicalMemoryBytes / PICTURE_MEMORY_SHARE),
  );
}
