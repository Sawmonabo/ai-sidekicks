// A parsed text's tree as the app draws it: the parser's binary tree read into mdast, what the
// parser made of literal text made that text again (`literal-text.ts`), and a paragraph that is one
// double-dollar formula a display formula. The page reads each tree the worker sends here, and the
// worker each tree it makes into HTML, so a copy reads exactly as the screen draws.

import type { Root } from "mdast";
import { materializeMdastTree } from "satteri/mdast-materializer";
import { MdastReader } from "satteri/mdast-reader";

import { liftDisplayFormulas } from "../math-syntax.js";
import { restoreLiteralText } from "./literal-text.js";

/**
 * The tree in `buffer`, parsed from `parsedText` with each dollar it read as text under
 * `dollarStandIn`, as the app draws it.
 */
export function materializeMarkdownTree(
  buffer: ArrayBuffer,
  parsedText: string,
  dollarStandIn: string | undefined,
): Root {
  const root = restoreLiteralText(
    materializeMdastTree(new MdastReader(buffer)),
    parsedText,
    dollarStandIn,
  );
  if (parsedText.includes("$$")) {
    liftDisplayFormulas(root.children, parsedText);
  }
  return root;
}
