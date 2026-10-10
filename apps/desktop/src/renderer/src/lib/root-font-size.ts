// The root font size a document draws its `rem` figures at, which the text size sets.

/**
 * The root font size of `ownerDocument`, in CSS px, as its own window computes it. Throws for a
 * document with no window.
 */
export function rootFontSizePx(ownerDocument: Document): number {
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) {
    throw new Error("A root font size was read in a document with no window.");
  }
  return Number.parseFloat(ownerWindow.getComputedStyle(ownerDocument.documentElement).fontSize);
}
