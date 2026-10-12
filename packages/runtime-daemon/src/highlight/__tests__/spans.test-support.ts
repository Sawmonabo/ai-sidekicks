// Reads the colorer's packed spans back as text and class names, so a test states colors plainly.

import { HIGHLIGHT_SPAN_CLASSES } from "@ai-sidekicks/contracts/highlight";

/** Each span as the text it covers and the class it paints as. */
export function decodeSpans(source: string, spans: Uint32Array): [string, string][] {
  const decoded: [string, string][] = [];
  for (let index = 0; index < spans.length; index += 3) {
    const offset = spans[index] ?? 0;
    const length = spans[index + 1] ?? 0;
    decoded.push([
      source.slice(offset, offset + length),
      HIGHLIGHT_SPAN_CLASSES[spans[index + 2] ?? 0] ?? "?",
    ]);
  }
  return decoded;
}
