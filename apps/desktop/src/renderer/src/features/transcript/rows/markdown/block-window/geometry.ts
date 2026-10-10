// A windowed block's geometry: its wrapper's height and the margins at its two edges. A wrapper is
// a plain block with no border or padding, so its first and last elements' margins collapse
// through it with its neighbors' exactly as in one flow, and its border box holds neither. The
// window counts each block from its top edge to the end of the margin it shares with the next.
// The margins are read from computed styles, which settle with no layout, so measuring a block
// on the scroll path forces none.

/** One drawn block's size and the margins at its edges, in CSS pixels. */
export interface BlockGeometry {
  /** The wrapper's border-box height, which its edge elements' margins collapse out of. */
  readonly heightPx: number;
  /** The margin at its top edge, collapsed through the first elements that pass it on. */
  readonly topMarginPx: number;
  /** The margin at its bottom edge, collapsed through the last elements that pass it on. */
  readonly bottomMarginPx: number;
}

/** Where a block sits among its neighbors, as its room in the window depends on it. */
export interface BlockNeighbors {
  /** Whether it is the body's first block, whose top margin sits inside the body. */
  readonly isFirst: boolean;
  /** The next block's top margin, or `undefined` for the last block, whose margin ends the body. */
  readonly nextTopMarginPx: number | undefined;
}

/** The geometry of one block wrapper whose border box is `heightPx` tall, reading styles only. */
export function readBlockGeometry(wrapper: Element, heightPx: number): BlockGeometry {
  return {
    heightPx,
    topMarginPx: collapsedEdgeMarginPx(wrapper, "top"),
    bottomMarginPx: collapsedEdgeMarginPx(wrapper, "bottom"),
  };
}

/**
 * The room one block takes in the window: its border box, the margin it shares with the next
 * block (or its own, ending the body), and for the first block the top margin the body holds.
 */
export function blockSizePx(geometry: BlockGeometry, neighbors: BlockNeighbors): number {
  const topInset = neighbors.isFirst ? geometry.topMarginPx : 0;
  const gapAfter =
    neighbors.nextTopMarginPx === undefined
      ? geometry.bottomMarginPx
      : collapsedMarginPx(geometry.bottomMarginPx, neighbors.nextTopMarginPx);
  return topInset + geometry.heightPx + gapAfter;
}

/**
 * Two adjoining margins as flow collapses them: the larger of the positive ones plus the most
 * negative of the negative ones.
 */
export function collapsedMarginPx(first: number, second: number): number {
  return Math.max(0, first, second) + Math.min(0, first, second);
}

/** Which edge of a block a margin is read at. */
type BlockEdge = "top" | "bottom";

/**
 * The margin at one edge of a wrapper: the edge element's own, collapsed with each first (or last)
 * descendant's that reaches the same edge, as flow layout collapses them. Positive margins
 * collapse to the largest and negative ones to the most negative, and the two add.
 */
function collapsedEdgeMarginPx(wrapper: Element, edge: BlockEdge): number {
  const view = wrapper.ownerDocument.defaultView;
  let largest = 0;
  let smallest = 0;
  let element = view === null ? undefined : inFlowEdgeChildOf(wrapper, edge, view);
  while (element !== undefined && view !== null) {
    const style = view.getComputedStyle(element);
    if (!BLOCK_DISPLAYS.has(style.display)) {
      // An inline box's vertical margins move nothing, and a line box at the edge stops the
      // collapse.
      break;
    }
    const margin = Number.parseFloat(edge === "top" ? style.marginTop : style.marginBottom);
    largest = Math.max(largest, margin);
    smallest = Math.min(smallest, margin);
    element = passesMarginOn(style, edge) ? inFlowEdgeChildOf(element, edge, view) : undefined;
  }
  return largest + smallest;
}

/** Displays whose box sits in block flow and has margins that meet its neighbors'. */
const BLOCK_DISPLAYS: ReadonlySet<string> = new Set([
  "block",
  "list-item",
  "flow-root",
  "table",
  "flex",
  "grid",
]);

/**
 * Whether a box lets its first (or last) child's margin through to its own edge: a block that
 * starts no formatting context, with no border or padding at that edge.
 */
function passesMarginOn(style: CSSStyleDeclaration, edge: BlockEdge): boolean {
  const border = edge === "top" ? style.borderTopWidth : style.borderBottomWidth;
  const padding = edge === "top" ? style.paddingTop : style.paddingBottom;
  return (
    (style.display === "block" || style.display === "list-item") &&
    (style.overflowY === "visible" || style.overflowY === "clip") &&
    Number.parseFloat(border) === 0 &&
    Number.parseFloat(padding) === 0
  );
}

/**
 * The child whose box meets a parent's top (or bottom) edge: the first (or last) child that is
 * in flow. `undefined` when that child is text, whose line box ends the collapse.
 */
function inFlowEdgeChildOf(parent: Element, edge: BlockEdge, view: Window): Element | undefined {
  for (
    let node = edge === "top" ? parent.firstChild : parent.lastChild;
    node !== null;
    node = edge === "top" ? node.nextSibling : node.previousSibling
  ) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent?.trim() === "") {
        continue;
      }
      return undefined;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const element = node as Element;
    const style = view.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.position === "absolute" ||
      style.position === "fixed" ||
      style.float !== "none"
    ) {
      continue;
    }
    return element;
  }
  return undefined;
}
