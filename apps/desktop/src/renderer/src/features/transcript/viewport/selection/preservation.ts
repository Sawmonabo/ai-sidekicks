// How a reader's selection inside one row survives that row's own remounts. A settled block becomes
// a memoized static subtree, which replaces the nodes the selection was anchored in, and the
// browser drops the selection. A selection inside a row survives; elsewhere it is never touched.
//   - Endpoints are character offsets into the row, not nodes, which a remount invalidates. This
//     also preserves a selection spanning the migrated block's boundary whole.
//   - Endpoints are read from the range and written forwards, because a same-node selection's
//     `focusOffset` can report the start offset while the range reports both ends, and anchor and
//     focus would then collapse every restore. A backwards drag comes back forwards.
//   - A restore happens only where a selection was lost.

/** A selection that was wholly inside one row, as character offsets into it, in document order. */
export interface RowSelectionSnapshot {
  readonly startCharacterOffset: number;
  readonly endCharacterOffset: number;
}

/** A resolved position inside a row: the text node, and the offset within it. */
interface ResolvedTextPosition {
  readonly textNode: Text;
  readonly offsetInNode: number;
}

const TEXT_NODE_TYPE = 3;

/**
 * `range` in `rowElement`'s character coordinates, or `undefined` when either end is outside the
 * row: restoring an invented position would recreate a selection the reader never made.
 */
export function captureRowSelection(
  rowElement: Node,
  range: AbstractRange,
): RowSelectionSnapshot | undefined {
  const startCharacterOffset = characterOffsetWithin(
    rowElement,
    range.startContainer,
    range.startOffset,
  );
  const endCharacterOffset = characterOffsetWithin(rowElement, range.endContainer, range.endOffset);
  if (startCharacterOffset === undefined || endCharacterOffset === undefined) {
    return undefined;
  }
  return { startCharacterOffset, endCharacterOffset };
}

/**
 * Puts `snapshot` back as the selection if `rowElement` lost it. Writes nothing, and answers
 * false, while the selection is still in the row or the reader has moved it elsewhere.
 */
export function restoreRowSelection(
  rowElement: Node,
  snapshot: RowSelectionSnapshot,
  selection: Selection,
): boolean {
  const startContainer =
    selection.rangeCount > 0 ? selection.getRangeAt(0).startContainer : undefined;
  const isStartInside = startContainer !== undefined && rowElement.contains(startContainer);
  if (isStartInside && !selection.isCollapsed && startContainer.isConnected) {
    // Still held: the remount did not reach the selection's nodes.
    return false;
  }
  if (!isStartInside && startContainer !== undefined && startContainer.isConnected) {
    // The reader is elsewhere now; their selection is theirs.
    return false;
  }
  const start = resolveTextPosition(rowElement, snapshot.startCharacterOffset);
  const end = resolveTextPosition(rowElement, snapshot.endCharacterOffset);
  if (start === undefined || end === undefined) {
    return false;
  }
  selection.setBaseAndExtent(start.textNode, start.offsetInNode, end.textNode, end.offsetInNode);
  return true;
}

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
function characterOffsetWithin(
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
