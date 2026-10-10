// Which of a window's items a selection keeps drawn: a long body's blocks, or a long table's rows,
// each marked with its index under its window's own attribute. A selection's ends live in drawn
// nodes, so the items holding them stay drawn however far the reader scrolls; a body's blocks
// between the ends stay drawn too, since a copy reads them from the page, while a table's rows
// between them are read from the text and drawn only where the reader looks. An end outside the
// window pins the window's edge on that side.

/** The items a selection runs across, first and last, by index. */
export interface PinnedRange {
  readonly firstIndex: number;
  readonly lastIndex: number;
}

/**
 * The items of the window in `windowElement`, marked with `indexAttribute`, that `selectionRange`
 * runs across, or `undefined` when it misses them: no selection, or one wholly before or after
 * the window.
 */
export function pinnedRangeOf(
  selectionRange: AbstractRange | undefined,
  windowElement: Element,
  itemCount: number,
  indexAttribute: string,
): PinnedRange | undefined {
  if (selectionRange === undefined || itemCount === 0) {
    return undefined;
  }
  const windowRange = windowElement.ownerDocument.createRange();
  windowRange.selectNodeContents(windowElement);
  const start = windowRange.comparePoint(selectionRange.startContainer, selectionRange.startOffset);
  const end = windowRange.comparePoint(selectionRange.endContainer, selectionRange.endOffset);
  if (start > 0 || end < 0) {
    return undefined;
  }
  const lastItemIndex = itemCount - 1;
  const firstIndex =
    start < 0
      ? 0
      : itemIndexAt(
          selectionRange.startContainer,
          selectionRange.startOffset,
          windowElement,
          indexAttribute,
          "start",
        );
  const lastIndex =
    end > 0
      ? lastItemIndex
      : itemIndexAt(
          selectionRange.endContainer,
          selectionRange.endOffset,
          windowElement,
          indexAttribute,
          "end",
        );
  return {
    firstIndex: Math.min(firstIndex ?? 0, lastItemIndex),
    lastIndex: Math.min(lastIndex ?? lastItemIndex, lastItemIndex),
  };
}

/** Every index from a pinned range's first to its last, for a window that keeps them all drawn. */
export function indexesBetween(pins: PinnedRange | undefined): readonly number[] {
  if (pins === undefined) {
    return [];
  }
  const indexes: number[] = [];
  for (let index = pins.firstIndex; index <= pins.lastIndex; index += 1) {
    indexes.push(index);
  }
  return indexes;
}

/** A pinned range's two ends, for a window that keeps only the items holding them drawn. */
export function rangeEnds(pins: PinnedRange | undefined): readonly number[] {
  return pins === undefined ? [] : [pins.firstIndex, pins.lastIndex];
}

/**
 * The window's own indexes with every pinned index below `itemCount` added, ascending and each
 * once. A pin can outlive an item it named, when the body was replaced since the selection.
 */
export function withPinnedIndexes(
  windowIndexes: number[],
  pinnedIndexes: readonly number[],
  itemCount: number,
): number[] {
  if (pinnedIndexes.length === 0) {
    return windowIndexes;
  }
  const indexes = new Set(windowIndexes);
  for (const index of pinnedIndexes) {
    if (index < itemCount) {
      indexes.add(index);
    }
  }
  return [...indexes].sort((left, right) => left - right);
}

/**
 * The index of the item holding a boundary point inside the window. A point between the
 * window's own children belongs to the nearest marked item after it for a start and before it for
 * an end, past any spacer; `undefined` when no item holds or follows (or precedes) it.
 */
function itemIndexAt(
  container: Node,
  offset: number,
  windowElement: Element,
  indexAttribute: string,
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
      const index = indexOf(node, indexAttribute);
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
    const index = indexOf(node, indexAttribute);
    if (index !== undefined) {
      return index;
    }
  }
  return undefined;
}

/** The index a marked item carries; `undefined` for any other node. */
function indexOf(node: Node, indexAttribute: string): number | undefined {
  const attribute =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element).getAttribute(indexAttribute) : null;
  return attribute === null ? undefined : Number(attribute);
}
