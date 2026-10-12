// How a reply's markdown reads mathematics: a single dollar is read as Pandoc reads it, so a price
// or a shell variable stays text. A formula between single dollars opens on a non-space, closes on
// a non-space and is not followed by a digit: `$x^2$` is a formula, while `$5`, `$HOME` and "$5 and
// $10" are words. Double dollars are read as the parser reads them, and a paragraph that is one
// double-dollar formula is a display one.

import type { RootContent } from "mdast";
import type { Math } from "mdast-util-math";

/**
 * Whether the formula the parser read from `start` to `end` in `text`, its dollars included, keeps
 * Pandoc's rule: one between double dollars always does.
 */
export function isPandocFormula(text: string, start: number, end: number): boolean {
  if (text.charAt(start + 1) === "$") {
    return true;
  }
  return (
    !isSpace(text.charAt(start + 1)) && !isSpace(text.charAt(end - 2)) && !isDigit(text.charAt(end))
  );
}

/**
 * Makes each paragraph among `children`, and among their children's, that holds one double-dollar
 * formula and nothing else a display formula, read from `source`, the text they were parsed from.
 */
export function liftDisplayFormulas(children: RootContent[], source: string): void {
  children.forEach((child, index) => {
    if (child.type === "paragraph") {
      const [formula] = child.children;
      const start = formula?.position?.start.offset;
      if (
        child.children.length === 1 &&
        formula?.type === "inlineMath" &&
        start !== undefined &&
        source.startsWith("$$", start)
      ) {
        const display: Math = {
          type: "math",
          meta: null,
          value: formula.value,
          position: child.position,
        };
        children[index] = display;
      }
    } else if (
      child.type === "blockquote" ||
      child.type === "list" ||
      child.type === "listItem" ||
      child.type === "footnoteDefinition"
    ) {
      liftDisplayFormulas(child.children, source);
    }
  });
}

/** A space, a tab or a line end; an empty string, the text's edge, counts as one. */
function isSpace(character: string): boolean {
  return /^[ \t\n\r]?$/u.test(character);
}

function isDigit(character: string): boolean {
  return /^[0-9]$/u.test(character);
}
