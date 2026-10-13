// A parsed text's tree as the app draws it: the parser's binary tree read into mdast, its positions
// counted in the text the app asked to parse, what the parser made of literal text made that text
// again (`literal-text.ts`), and a paragraph that is one double-dollar formula a display formula.
// The page reads each tree the worker sends here, and the worker each tree it makes into HTML, so a
// copy reads exactly as the screen draws.

import type { Nodes, Root } from "mdast";
import { materializeMdastTree } from "satteri/mdast-materializer";
import { MdastReader } from "satteri/mdast-reader";

import { liftDisplayFormulas } from "../math-syntax.js";
import { parseLeadOf } from "./byte-order-mark.js";
import { restoreLiteralText } from "./literal-text.js";
import type { Point } from "./position.js";

/**
 * The tree in `buffer`, parsed from `parsedText` with each dollar it read as text under
 * `dollarStandIn`, as the app draws it: its positions count `parsedText`, without the lead the
 * parser was given ahead of it.
 */
export function materializeMarkdownTree(
  buffer: ArrayBuffer,
  parsedText: string,
  dollarStandIn: string | undefined,
): Root {
  const tree = materializeMdastTree(new MdastReader(buffer));
  const leadLength = parseLeadOf(parsedText).length;
  if (leadLength > 0) {
    // The lead is one blank line.
    shiftPositions(tree, -leadLength, -1);
  }
  const root = restoreLiteralText(tree, parsedText, dollarStandIn);
  if (parsedText.includes("$$")) {
    liftDisplayFormulas(root.children, parsedText);
  }
  return root;
}

/** `node` and every node below it moved `offsetShift` code units and `lineShift` lines on. */
export function shiftPositions(node: Nodes, offsetShift: number, lineShift: number): void {
  // Each node's place is its own object, made as the node was read, so it moves in place.
  const position = node.position;
  if (position !== undefined) {
    shiftPoint(position.start, offsetShift, lineShift);
    shiftPoint(position.end, offsetShift, lineShift);
  }
  if ("children" in node) {
    for (const child of node.children) {
      shiftPositions(child, offsetShift, lineShift);
    }
  }
}

/** `point` moved `offsetShift` code units and `lineShift` lines on, in place. */
export function shiftPoint(point: Point, offsetShift: number, lineShift: number): void {
  point.line += lineShift;
  if (point.offset !== undefined) {
    point.offset += offsetShift;
  }
}
