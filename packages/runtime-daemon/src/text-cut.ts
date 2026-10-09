// A cut of text to a bound counted in UTF-16 code units, as the wire's string bounds and Zod's
// `.max()` count, that never leaves half a character for a JSON sink to refuse.

/**
 * `text` cut to at most `maxLength` UTF-16 code units, one fewer when the cut would split a
 * surrogate pair, so the result never ends in half a character.
 */
export function cutToCodeUnits(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const lastUnit = text.charCodeAt(maxLength - 1);
  const splitsPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return text.slice(0, splitsPair ? maxLength - 1 : maxLength);
}
