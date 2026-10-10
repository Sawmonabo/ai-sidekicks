// The coordinates a reader's selection is kept in, so it survives the nodes it was anchored in:
// a settled block becoming a memoized static subtree, or the row leaving the window and coming
// back, replaces them and the browser drops the selection.
//   - An end is a character offset into the text nodes of the innermost windowed element holding
//     it (a long body's block, a long table's row), found by that element's index, or into the
//     row's text where none holds it. A window draws a different set of blocks or table rows
//     around the end as the reader scrolls, so an offset counted from the row's start would shift
//     with them; an element's own text is drawn the same each time, so its offset names one place.
//   - Ends are read from the range and written forwards, because a same-node selection's
//     `focusOffset` can report the start offset while the range reports both ends, and anchor and
//     focus would then collapse every restore. A backwards drag comes back forwards.

import { WINDOWED_ELEMENT_INDEX_ATTRIBUTES } from "../../rows/markdown/block-window/markers.js";

/**
 * Where one end of a selection sits in its row: the windowed elements holding it, outermost
 * first, and the characters into the innermost one's text, or into the row's when none holds it.
 */
export interface RowTextPosition {
  readonly path: readonly WindowedElementAddress[];
  readonly characterOffset: number;
}

/** One windowed element on the way to an end: the index attribute it carries, and its index. */
export interface WindowedElementAddress {
  readonly attribute: string;
  readonly index: number;
}

/** A resolved position inside a row: the text node, and the offset within it. */
interface ResolvedTextPosition {
  readonly textNode: Text;
  readonly offsetInNode: number;
}

const TEXT_NODE_TYPE = 3;
const ELEMENT_NODE_TYPE = 1;

/**
 * The DOM position a character offset names, or `undefined` when the row has no text. The offset
 * is clamped to the row's length, so a migration that shortened the text lands at its end.
 */
export function resolveTextPosition(
  root: Node,
  characterOffset: number,
): ResolvedTextPosition | undefined {
  const textNodes = collectTextNodes(root);
  let remaining = Math.max(0, characterOffset);
  let lastTextNode: Text | undefined;
  for (const textNode of textNodes) {
    if (remaining <= textNode.data.length) {
      return { textNode, offsetInNode: remaining };
    }
    remaining -= textNode.data.length;
    lastTextNode = textNode;
  }
  if (lastTextNode === undefined) {
    return undefined;
  }
  return { textNode: lastTextNode, offsetInNode: lastTextNode.data.length };
}

/**
 * The character offset of one DOM position, measured from the start of `root`.
 *
 * `undefined` when the position is not inside `root` at all, which is how a selection
 * that has left this row is told from one that is still in it.
 */
export function characterOffsetWithin(
  root: Node,
  node: Node | null,
  offsetInNode: number,
): number | undefined {
  if (node === null || !root.contains(node)) {
    return undefined;
  }
  if (isTextNode(node)) {
    let offset = 0;
    for (const textNode of collectTextNodes(root)) {
      if (textNode === node) {
        return offset + Math.min(offsetInNode, textNode.data.length);
      }
      offset += textNode.data.length;
    }
    return undefined;
  }
  // An element position addresses a child boundary: the offset is the text the first
  // `offsetInNode` children hold.
  let offset = 0;
  const children = Array.from(node.childNodes);
  for (const [childIndex, child] of children.entries()) {
    if (childIndex >= offsetInNode) {
      break;
    }
    offset += child.textContent?.length ?? 0;
  }
  const leading = characterOffsetWithin(root, node.parentNode, indexOfChild(node));
  return leading === undefined ? offset : leading + offset;
}

/**
 * Where a DOM position sits in `row`, anchored to the innermost windowed element holding it, or
 * `undefined` when the position is not inside `row`.
 */
export function rowTextPositionOf(
  row: Node,
  node: Node,
  offsetInNode: number,
): RowTextPosition | undefined {
  const path: WindowedElementAddress[] = [];
  let anchor: Node = row;
  for (let ancestor: Node | null = node; ancestor !== null && ancestor !== row; ) {
    const address = windowedAddressOf(ancestor);
    if (address !== undefined) {
      path.unshift(address);
      if (anchor === row) {
        anchor = ancestor;
      }
    }
    ancestor = ancestor.parentNode;
  }
  const characterOffset = characterOffsetWithin(anchor, node, offsetInNode);
  return characterOffset === undefined ? undefined : { path, characterOffset };
}

/**
 * The DOM position a row text position names in `row`, or `undefined` when an element on its
 * path is not drawn or the element holds no text.
 */
export function resolveRowTextPosition(
  row: Element,
  position: RowTextPosition,
): ResolvedTextPosition | undefined {
  let anchor: Element | undefined = row;
  for (const address of position.path) {
    anchor = descendantAt(anchor, address);
    if (anchor === undefined) {
      return undefined;
    }
  }
  return resolveTextPosition(anchor, position.characterOffset);
}

/**
 * The order of two positions in one row: negative when `first` comes first. Paths compare index
 * by index, a position outside a windowed element before one inside it, then the offsets.
 */
export function compareRowTextPositions(first: RowTextPosition, second: RowTextPosition): number {
  const depth = Math.max(first.path.length, second.path.length);
  for (let level = 0; level < depth; level += 1) {
    const difference = (first.path[level]?.index ?? -1) - (second.path[level]?.index ?? -1);
    if (difference !== 0) {
      return difference;
    }
  }
  return first.characterOffset - second.characterOffset;
}

/** The windowed element at `address` inside `parent`, its nearest one carrying that attribute. */
function descendantAt(parent: Element, address: WindowedElementAddress): Element | undefined {
  return parent.querySelector(`[${address.attribute}="${String(address.index)}"]`) ?? undefined;
}

/** The windowed index a node carries, or `undefined` for a node no window marks. */
function windowedAddressOf(node: Node): WindowedElementAddress | undefined {
  if (node.nodeType !== ELEMENT_NODE_TYPE) {
    return undefined;
  }
  for (const attribute of WINDOWED_ELEMENT_INDEX_ATTRIBUTES) {
    const value = (node as Element).getAttribute(attribute);
    if (value !== null) {
      return { attribute, index: Number(value) };
    }
  }
  return undefined;
}

function isTextNode(node: Node): node is Text {
  return node.nodeType === TEXT_NODE_TYPE;
}

/** Every text node under `root`, in document order. */
function collectTextNodes(root: Node): readonly Text[] {
  const textNodes: Text[] = [];
  const visit = (node: Node): void => {
    if (isTextNode(node)) {
      textNodes.push(node);
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      visit(child);
    }
  };
  visit(root);
  return textNodes;
}

function indexOfChild(node: Node): number {
  const parent = node.parentNode;
  if (parent === null) {
    return 0;
  }
  return Array.from(parent.childNodes).indexOf(node as ChildNode);
}
