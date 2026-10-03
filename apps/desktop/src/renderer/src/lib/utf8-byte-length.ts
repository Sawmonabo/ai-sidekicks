// The one byte measurement every cap in the renderer counts through.

/** Stateless, so one encoder serves every caller. */
const UTF8_ENCODER = new TextEncoder();

/**
 * How many UTF-8 bytes a string occupies, the one measure every cap in this app uses so two
 * caps cannot disagree on non-ASCII text. Not `String.length`, which counts UTF-16 code units and
 * would refuse a shorter sentence in one script than another.
 */
export function measureUtf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}
