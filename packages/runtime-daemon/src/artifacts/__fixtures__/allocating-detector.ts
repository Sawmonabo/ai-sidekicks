// A detector that allocates without end, as a parser fed a payload crafted to make it build ever
// larger structures can: only the detection thread's heap bound stops it. It pauses between
// allocations, so a thread with no bound grows slowly enough to be stopped by the time bound.

const ALLOCATION_LENGTH = 256 * 1024;
const PAUSE_MS = 10;

/** Never returns; holds every array it makes until its thread runs out of heap. */
export function detectMediaType(): Promise<string | undefined> {
  const held: number[][] = [];
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    held.push(Array.from({ length: ALLOCATION_LENGTH }, (_, index) => index));
    Atomics.wait(pause, 0, 0, PAUSE_MS);
  }
}

/** This module's URL, which the detection thread is handed. */
export const ALLOCATING_DETECTOR_URL: URL = new URL(import.meta.url);
