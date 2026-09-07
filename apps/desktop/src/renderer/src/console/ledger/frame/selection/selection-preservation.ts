// Preserving a reader's selection across a block migration.
//
// WHAT MIGRATION MEANS HERE. A streaming message's blocks settle behind the tail: a
// block that was live prose becomes a memoised static subtree, which is a REMOUNT —
// the nodes the reader's selection was anchored in are replaced by different nodes
// holding the same characters. The browser has no opinion about that; it drops the
// selection. Mid-stream, that is a reader who highlighted a sentence watching it
// un-highlight because a delta arrived two paragraphs below.
//
// THE SENTENCE THIS MODULE ADDS, because no committed document states it: a selection
// inside a ledger row survives the row's own remounts, and a selection anywhere else
// is never touched.
//
// FOUR DECISIONS:
//
//   • **An endpoint is a CHARACTER OFFSET into the row, not a node and an offset.** A
//     node reference is exactly what a remount invalidates, so storing one stores the
//     thing that is about to stop existing. The offset is stable across a remount that
//     produces the same characters, which is what a settle is — the block's text is
//     final by the time it migrates. It also addresses an endpoint OUTSIDE the block
//     that migrated, so a selection spanning the boundary is preserved whole rather
//     than clipped to the half that moved.
//   • **The snapshot is kept live by `selectionchange`, not taken pre-commit.** A
//     function component has no pre-commit hook, and taking the snapshot in a layout
//     effect would capture the state at the PREVIOUS commit — stale for the ordinary
//     case, which is a reader who selects text and then receives a delta with no
//     render in between. The listener is what makes the snapshot current.
//   • **The listener early-outs on a collapsed selection before touching the DOM.** A
//     caret, or no selection at all, is every moment except the ones a person is
//     dragging through — so the common case costs one boolean read, and the `contains`
//     walk happens only while text is actually selected.
//   • **A restore happens only where a selection was LOST.** If the selection is still
//     inside this row, or has moved to another row, nothing is written: putting a
//     selection back that the reader has moved on from is worse than losing one.
//     Guarded by a generation, so a restore scheduled for one migration can never
//     land after the next.

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
 * The selection surface this module reads and writes.
 *
 * READ AS A RANGE, WRITTEN AS ANCHOR AND FOCUS, and that asymmetry is deliberate
 * rather than sloppy: the anchor/focus pair carries the DIRECTION a person dragged in,
 * and reading it is how a restore would preserve that direction — but the endpoint
 * pair is what every engine agrees on, and reading `focusOffset` off a same-node
 * selection returns the START offset under this tree's test DOM (measured: a range
 * whose text is `first` reports anchor 4 and focus 4). A restore built on that would
 * silently collapse every selection it was supposed to save. So the endpoints are read
 * from the range and written forwards, and the cost is named: a backwards drag comes
 * back as a forwards one, which changes which end shift-arrow extends from and nothing
 * a reader can see.
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
  // An element position addresses a child BOUNDARY, so the offset is everything the
  // first `offsetInNode` children hold. A selection that starts at a block boundary
  // reaches this arm rather than the text one.
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

function indexOfChild(node: Node): number {
  const parent = node.parentNode;
  if (parent === null) {
    return 0;
  }
  return Array.from(parent.childNodes).indexOf(node as ChildNode);
}

/**
 * The DOM position a character offset names, or `undefined` when the row holds no
 * text to land in.
 *
 * The offset is clamped to the row's own length rather than refused: a migration that
 * shortened the text is a row whose selection cannot be restored exactly, and the end
 * of the text is the honest nearest position.
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
   * Take, or release, the row this guard preserves.
   *
   * Called from the same ref callback the virtualizer's measurement uses, so the
   * element this guard holds is the element the row actually painted.
   */
  public observe(rootElement: Node | null): void {
    if (rootElement !== null && rootElement === this.#rootElement) {
      // The same element again — a re-render, not a new row. Bumping the generation
      // here would drop the snapshot on every render, which is every snapshot this
      // guard would ever hold.
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

  /** The snapshot a restore would use. Read by tests and by the binding's assertions. */
  public get snapshot(): RowSelectionSnapshot | undefined {
    return this.#snapshot;
  }

  /** The generation a restore is guarded by. Bumped whenever the observed row changes. */
  public get generation(): number {
    return this.#generation;
  }

  /**
   * Put the selection back, if this row lost one it was holding.
   *
   * Called after every commit of the row. Four things stop it, each of them a case
   * where writing a selection would be worse than not writing one: no snapshot, a
   * stale generation, a selection that is still inside this row, and a selection that
   * has moved somewhere else.
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
      // Still held. The remount did not reach the nodes the selection was in.
      return false;
    }
    if (!startIsInside && startContainer !== undefined && startContainer.isConnected) {
      // The reader is somewhere else now. Their selection is theirs.
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
      // The early-out the header's third decision names: a caret is not a selection
      // worth preserving, and this arm reads one boolean and touches no node.
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
      // One endpoint outside this row. Its position is not addressable in this row's
      // coordinates, and inventing one would restore a selection the reader never
      // made — so this row holds nothing for it.
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
