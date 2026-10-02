// Cutting a text down to a bound and marking the cut with an ellipsis, so a reader can tell an
// elided text from a short one.

/**
 * `text` whole when it fits within `maximumCharacters`, otherwise its first `maximumCharacters`
 * characters followed by `…`. With `atWordBoundary`, the cut moves back to the last space when
 * that keeps more than half the bound, and the trailing whitespace before the ellipsis goes.
 */
export function elideText(
  text: string,
  maximumCharacters: number,
  options: { readonly atWordBoundary?: boolean } = {},
): string {
  if (text.length <= maximumCharacters) {
    return text;
  }
  const head = text.slice(0, maximumCharacters);
  if (options.atWordBoundary !== true) {
    return `${head}…`;
  }
  const lastSpace = head.lastIndexOf(" ");
  const kept = lastSpace > maximumCharacters / 2 ? head.slice(0, lastSpace) : head;
  return `${kept.trimEnd()}…`;
}
