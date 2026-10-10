// Which of a windowed body's blocks a selection keeps drawn. A selection's ends live in drawn
// nodes, and copying reads the nodes between them, so every block from the one holding the start
// to the one holding the end stays drawn however far the reader scrolls. An end outside the body
// pins the body's edge on that side.

import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "./markers.js";

/** The blocks a selection runs across, first and last, by index. */
export interface PinnedBlockRange {
  readonly firstIndex: number;
  readonly lastIndex: number;
}

/**
 * The blocks of the window in `windowElement` that `selectionRange` runs across, or `undefined`
 * when it misses them: no selection, or one wholly before or after the window.
 */
export function pinnedBlockRangeOf(
  selectionRange: AbstractRange | undefined,
  windowElement: Element,
  blockCount: number,
): PinnedBlockRange | undefined {
  if (selectionRange === undefined || blockCount === 0) {
    return undefined;
  }
  const windowRange = windowElement.ownerDocument.createRange();
  windowRange.selectNodeContents(windowElement);
  const start = windowRange.comparePoint(selectionRange.startContainer, selectionRange.startOffset);
  const end = windowRange.comparePoint(selectionRange.endContainer, selectionRange.endOffset);
  if (start > 0 || end < 0) {
    return undefined;
  }
  const lastBlockIndex = blockCount - 1;
  const firstIndex =
    start < 0
      ? 0
      : blockIndexAt(
          selectionRange.startContainer,
          selectionRange.startOffset,
          windowElement,
          "start",
        );
  const lastIndex =
    end > 0
      ? lastBlockIndex
      : blockIndexAt(selectionRange.endContainer, selectionRange.endOffset, windowElement, "end");
  return {
    firstIndex: Math.min(firstIndex ?? 0, lastBlockIndex),
    lastIndex: Math.min(lastIndex ?? lastBlockIndex, lastBlockIndex),
  };
}

/**
 * The window's own indexes with every pinned block below `blockCount` added, ascending and each
 * once. A pin can outlive a block it named, when the body was replaced since the selection.
 */
export function withPinnedBlocks(
  windowIndexes: number[],
  pins: PinnedBlockRange | undefined,
  blockCount: number,
): number[] {
  if (pins === undefined) {
    return windowIndexes;
  }
  const indexes = new Set(windowIndexes);
  const lastIndex = Math.min(pins.lastIndex, blockCount - 1);
  for (let index = pins.firstIndex; index <= lastIndex; index += 1) {
    indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

/**
 * The index of the block holding a boundary point inside the window. A point between the
 * window's own children belongs to the nearest wrapper after it for a start and before it for an
 * end, past any spacer; `undefined` when no wrapper holds or follows (or precedes) it.
 */
function blockIndexAt(
  container: Node,
  offset: number,
  windowElement: Element,
  boundary: "start" | "end",
): number | undefined {
  if (container === windowElement) {
    for (
      let node: Node | null | undefined =
        boundary === "start"
          ? windowElement.childNodes[offset]
          : windowElement.childNodes[offset - 1];
      node !== null && node !== undefined;
      node = boundary === "start" ? node.nextSibling : node.previousSibling
    ) {
      const index = indexOf(node);
      if (index !== undefined) {
        return index;
      }
    }
    return undefined;
  }
  for (
    let node: Node | null = container;
    node !== null && node !== windowElement;
    node = node.parentNode
  ) {
    const index = indexOf(node);
    if (index !== undefined) {
      return index;
    }
  }
  return undefined;
}

/** The block index a wrapper carries; `undefined` for any other node. */
function indexOf(node: Node): number | undefined {
  const attribute =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element).getAttribute(MARKDOWN_BLOCK_INDEX_ATTRIBUTE)
      : null;
  return attribute === null ? undefined : Number(attribute);
}
