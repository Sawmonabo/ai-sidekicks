// Cutting a text down to a bound and marking the cut with an ellipsis, so a reader can tell an
// elided text from a short one.

const ELLIPSIS = "…";

/**
 * `text` whole when it fits within `maximumCharacters`, otherwise its first `maximumCharacters`
 * characters followed by `…`. With `ellipsisWithinBound`, the `…` counts toward the bound, so the
 * result never exceeds `maximumCharacters`. With `atWordBoundary`, the cut moves back to the last
 * space when that keeps more than half the kept length, and the trailing whitespace before the
 * ellipsis goes.
 */
export function elideText(
  text: string,
  maximumCharacters: number,
  options: { readonly atWordBoundary?: boolean; readonly ellipsisWithinBound?: boolean } = {},
): string {
  if (text.length <= maximumCharacters) {
    return text;
  }
  const keptLength =
    options.ellipsisWithinBound === true ? maximumCharacters - ELLIPSIS.length : maximumCharacters;
  const head = text.slice(0, keptLength);
  if (options.atWordBoundary !== true) {
    return `${head}${ELLIPSIS}`;
  }
  const lastSpace = head.lastIndexOf(" ");
  const kept = lastSpace > keptLength / 2 ? head.slice(0, lastSpace) : head;
  return `${kept.trimEnd()}${ELLIPSIS}`;
}
