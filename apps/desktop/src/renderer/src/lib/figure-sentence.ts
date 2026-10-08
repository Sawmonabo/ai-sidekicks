// A sentence that carries figures in its words, kept as parts so each figure can be drawn in the
// class its origin calls for, and read back as one string for an announcement.

/**
 * One stretch of a sentence: words, a figure the wire sent, drawn as a wire figure, or a figure
 * the app made, such as a count of what the wire sent, drawn as the app's own.
 */
export type FigureSentencePart = string | { readonly wire: string } | { readonly derived: string };

/** A sentence's words and figures as one string, for an announcement. */
export function joinFigureSentence(parts: readonly FigureSentencePart[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : "wire" in part ? part.wire : part.derived))
    .join("");
}
