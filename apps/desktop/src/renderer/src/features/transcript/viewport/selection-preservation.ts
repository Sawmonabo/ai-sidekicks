// Preserves a reader's selection across a row's own remounts. A settled block becomes a
// memoized static subtree, which replaces the nodes the selection was anchored in, and the
// browser drops the selection. A selection inside a row survives; elsewhere it is never touched.
//   - Endpoints are character offsets into the row, not nodes, which a remount invalidates. This
//     also preserves a selection spanning the migrated block's boundary whole.
//   - `selectionchange` keeps the snapshot current: a function component has no pre-commit hook
//     and a layout effect would capture the previous commit's state.
//   - The listener returns early on a collapsed selection, so the common case costs one read.
//   - A restore happens only where a selection was lost, guarded by a generation so one
//     migration's restore cannot land after the next.

/** The document seam, declared rather than read off the DOM lib. */
export interface SelectionDocument {
  getSelection(): SelectionLike | null;
  addEventListener(type: "selectionchange", listener: () => void): void;
  removeEventListener(type: "selectionchange", listener: () => void): void;
}

/** The two ends of a selection, in document order. */
export interface SelectionRangeLike {
  readonly startContainer: Node;
  readonly startOffset: number;
  readonly endContainer: Node;
  readonly endOffset: number;
}

/**
 * The part of the platform selection this module reads and writes.
 *
 * Endpoints are read from the range and written forwards: reading `focusOffset` off a
 * same-node selection returns the start offset under this tree's test DOM (a range over `first`
 * reports anchor 4, focus 4), so anchor/focus would collapse every restore. A backwards drag
 * comes back forwards.
 */
export interface SelectionLike {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  getRangeAt(index: number): SelectionRangeLike;
  setBaseAndExtent(
    anchorNode: Node,
    anchorOffset: number,
    focusNode: Node,
    focusOffset: number,
  ): void;
}

/** One endpoint, as a character offset into the observed row. */
export interface SelectionEndpointSnapshot {
  readonly characterOffset: number;
}

/** A selection that was wholly inside the observed row, in document order. */
export interface RowSelectionSnapshot {
  readonly start: SelectionEndpointSnapshot;
  readonly end: SelectionEndpointSnapshot;
}

/** A resolved position inside a row: the text node, and the offset within it. */
interface ResolvedTextPosition {
  readonly textNode: Text;
  readonly offsetInNode: number;
}

const TEXT_NODE_TYPE = 3;

/** One row's selection, held across that row's own remounts. */
export class RowSelectionGuard {
  readonly #document: SelectionDocument;
  readonly #onSelectionChange: () => void;

  #rootElement: Node | undefined;
  #snapshot: RowSelectionSnapshot | undefined;
  #generation = 0;
  #listening = false;

  public constructor(selectionDocument: SelectionDocument) {
    this.#document = selectionDocument;
    this.#onSelectionChange = (): void => {
      this.#captureSnapshot();
    };
  }

  /**
   * Takes, or releases, the row this guard preserves. Called from the ref callback the
   * virtualizer's measurement uses, so the held element is the one the row painted.
   */
  public observe(rootElement: Node | null): void {
    if (rootElement !== null && rootElement === this.#rootElement) {
      // The same element again (a re-render): bumping the generation would drop the snapshot
      // on every render.
      return;
    }
    this.#rootElement = rootElement ?? undefined;
    this.#snapshot = undefined;
    this.#generation += 1;
    if (rootElement === null) {
      this.#stopListening();
      return;
    }
    if (!this.#listening) {
      this.#document.addEventListener("selectionchange", this.#onSelectionChange);
      this.#listening = true;
    }
    this.#captureSnapshot();
  }

  /** The snapshot a restore would use. */
  public get snapshot(): RowSelectionSnapshot | undefined {
    return this.#snapshot;
  }

  /** The generation a restore is guarded by. Bumped whenever the observed row changes. */
  public get generation(): number {
    return this.#generation;
  }

  /**
   * Puts the selection back if this row lost one it was holding. Called after every commit;
   * writes nothing when there is no snapshot, the generation is stale, the selection is still in
   * this row, or it has moved elsewhere.
   */
  public restoreAfterFlush(generation: number): boolean {
    const rootElement = this.#rootElement;
    const snapshot = this.#snapshot;
    if (rootElement === undefined || snapshot === undefined || generation !== this.#generation) {
      return false;
    }
    const selection = this.#document.getSelection();
    if (selection === null) {
      return false;
    }
    const liveRange = selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
    const startContainer = liveRange?.startContainer;
    const startIsInside = startContainer !== undefined && rootElement.contains(startContainer);
    if (startIsInside && !selection.isCollapsed && startContainer.isConnected) {
      // Still held: the remount did not reach the selection's nodes.
      return false;
    }
    if (!startIsInside && startContainer !== undefined && startContainer.isConnected) {
      // The reader is elsewhere now; their selection is theirs.
      return false;
    }
    const start = resolveTextPosition(rootElement, snapshot.start.characterOffset);
    const end = resolveTextPosition(rootElement, snapshot.end.characterOffset);
    if (start === undefined || end === undefined) {
      return false;
    }
    selection.setBaseAndExtent(start.textNode, start.offsetInNode, end.textNode, end.offsetInNode);
    return true;
  }

  /** Terminal. Drops the listener and the snapshot. */
  public dispose(): void {
    this.#stopListening();
    this.#rootElement = undefined;
    this.#snapshot = undefined;
  }

  #captureSnapshot(): void {
    const rootElement = this.#rootElement;
    if (rootElement === undefined) {
      return;
    }
    const selection = this.#document.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      // A caret is not worth preserving; this arm reads one boolean and touches no node.
      this.#snapshot = undefined;
      return;
    }
    const liveRange = selection.getRangeAt(0);
    const anchorOffset = characterOffsetWithin(
      rootElement,
      liveRange.startContainer,
      liveRange.startOffset,
    );
    const focusOffset = characterOffsetWithin(
      rootElement,
      liveRange.endContainer,
      liveRange.endOffset,
    );
    if (anchorOffset === undefined || focusOffset === undefined) {
      // One endpoint is outside this row and not addressable in its coordinates; restoring an
      // invented position would recreate a selection the reader never made.
      this.#snapshot = undefined;
      return;
    }
    this.#snapshot = {
      start: { characterOffset: anchorOffset },
      end: { characterOffset: focusOffset },
    };
  }

  #stopListening(): void {
    if (!this.#listening) {
      return;
    }
    this.#document.removeEventListener("selectionchange", this.#onSelectionChange);
    this.#listening = false;
  }
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
