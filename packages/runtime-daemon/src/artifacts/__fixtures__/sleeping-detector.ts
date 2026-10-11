// A detector that holds its thread for as many milliseconds as its leading bytes spell, then names
// plain text, so a test can see how many detection threads run at once and when each one's time
// bound starts.

/** Holds its thread for the milliseconds `leadingBytes` spell in ASCII digits, then answers. */
export function detectMediaType(leadingBytes: Uint8Array): Promise<string | undefined> {
  const holdMs = Number(new TextDecoder().decode(leadingBytes));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
  return Promise.resolve("text/plain");
}

/** This module's URL, which the detection thread is handed. */
export const SLEEPING_DETECTOR_URL: URL = new URL(import.meta.url);
