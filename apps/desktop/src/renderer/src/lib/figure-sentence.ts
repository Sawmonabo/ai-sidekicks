// A sentence that carries figures in its words, kept as parts so each figure can be drawn in the
// class its origin calls for, and read back as one string for an announcement.

import { formatByteQuantity } from "./wire/figures.js";

/**
 * Where a figure's value comes from: `wire`, what the daemon, a provider or the updater sent, or
 * the person's own data; `derived`, what the app computed, such as a count of what the wire sent.
 */
export type FigureOrigin = "wire" | "derived";

/**
 * One stretch of a sentence: words, a figure the wire sent, drawn as a wire figure, or a figure
 * the app made, drawn as the app's own. A figure's `hoverLabel` says what it stands for where the
 * text is a formatted reading of it, as the figure components' own `hoverLabel` does.
 */
export type FigureSentencePart =
  | string
  | { readonly wire: string; readonly hoverLabel?: string | undefined }
  | { readonly derived: string; readonly hoverLabel?: string | undefined };

/** A figure of `origin` as a sentence part, with what it stands for where that is not its text. */
export function figurePart(
  origin: FigureOrigin,
  text: string,
  hoverLabel?: string,
): FigureSentencePart {
  return origin === "wire" ? { wire: text, hoverLabel } : { derived: text, hoverLabel };
}

/**
 * A byte quantity as a figure of `origin`, `1.2 MiB`, with its whole count in words as its hover
 * label once it is scaled past bytes.
 */
export function byteFigurePart(origin: FigureOrigin, byteCount: number): FigureSentencePart {
  const size = formatByteQuantity(byteCount);
  return figurePart(origin, size.text, size.exactText);
}

/** A sentence's words and figures as one string, for an announcement. */
export function joinFigureSentence(parts: readonly FigureSentencePart[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : "wire" in part ? part.wire : part.derived))
    .join("");
}
