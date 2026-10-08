import { getWindow, isElement, isHTMLElement } from "@floating-ui/utils/dom";
import { useCallback, useMemo, useRef, type RefObject } from "react";

import { EDGE_COUNT_CLASS, runGraphNodeCenter } from "../elements.js";
import type { CanvasPoint } from "../layout.js";
import type { LiveStepFollow } from "./useLiveStepFollow.js";
import type { RunGraphElements } from "./useRunGraphElements.js";
import { useTrackShiftTab } from "./useTrackShiftTab.js";

/** The keys that select the focused node, as a button's do. */
const SELECT_KEYS: readonly string[] = ["Enter", " "];

/** The canvas's key and focus handlers: the graph's Tab walk, node selection by key, reveal. */
export interface RunGraphKeyboard {
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  readonly onFocus: (event: React.FocusEvent<HTMLDivElement>) => void;
}

/**
 * Walks the run graph by keyboard inside `canvasRef`'s canvas, selects a node on Enter or Space,
 * and brings a node or count reached by keyboard into view, stopping the follow.
 */
export function useRunGraphKeyboard(
  canvasRef: RefObject<HTMLDivElement | null>,
  nodes: RunGraphElements["nodes"],
  edges: RunGraphElements["edges"],
  follow: Pick<LiveStepFollow, "stopFollowing" | "revealPoint">,
  onSelectNode: (nodeId: string) => void,
): RunGraphKeyboard {
  const { stopFollowing, revealPoint } = follow;
  const graphOrder = useMemo(() => graphFocusOrder(nodes, edges), [nodes, edges]);
  // True only while the walk hands focus to an end node for the browser's own Tab to carry on.
  const isHandingOffRef = useRef(false);
  // Read so focus code hands back to a node is never taken for Shift+Tab coming in.
  const isShiftTabbingRef = useTrackShiftTab();

  // Any key on the canvas stops the follow; Enter or Space on a node also selects it, since the
  // library's own node keys are off along with its second live region. Tab walks the graph's own
  // order, each node and then the counts of the edges leaving it: the library draws every edge
  // before every node, so the browser's order would visit all the counts first.
  const handleCanvasKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      stopFollowing();
      const canvas = canvasRef.current;
      if (
        event.key === "Tab" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        canvas !== null
      ) {
        const move = moveGraphFocus(canvas, graphOrder, event.target, event.shiftKey);
        if (move?.kind === "stop") {
          move.element.focus();
          event.preventDefault();
          return;
        }
        if (move?.kind === "hand-off") {
          // Focus passes over the end node on its way out: the canvas does not pan to it, and
          // nothing scrolls to it, since the browser's own Tab scrolls to where focus lands.
          isHandingOffRef.current = true;
          move.element.focus({ preventScroll: true });
          isHandingOffRef.current = false;
          return;
        }
      }
      const nodeId = focusedNodeId(event.target);
      if (nodeId !== undefined && SELECT_KEYS.includes(event.key)) {
        event.preventDefault();
        onSelectNode(nodeId);
      }
    },
    [canvasRef, graphOrder, onSelectNode, stopFollowing],
  );

  // A node or an edge's count reached by keyboard is brought into view, which the library does
  // only with its own keys on, and the follow stops, so the next live step never pulls the view
  // off it; focus on the canvas's own controls or links leaves the follow running. Tab from
  // outside the canvas lands here with no key on the canvas. Shift+Tab back into the walk lands
  // on the browser's last node, so focus moves on to the walk's last stop, the last count leaving
  // that node where it has one; focus code returns to that node stays on it.
  const revealFocusedElement = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (
        isHandingOffRef.current ||
        !event.target.matches(":focus-visible") ||
        graphStopOf(event.target) === undefined
      ) {
        return;
      }
      stopFollowing();
      const canvas = canvasRef.current;
      const nodeId = focusedNodeId(event.target);
      if (
        canvas !== null &&
        nodeId !== undefined &&
        isShiftTabbingRef.current &&
        isEnteredFromAfter(event)
      ) {
        const lastStop = graphStopElement(canvas, graphOrder.at(-1));
        if (lastStop !== null && lastStop !== event.target) {
          lastStop.focus();
          return;
        }
      }
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (node !== undefined) {
        revealPoint(runGraphNodeCenter(node));
      } else if (event.target.classList.contains(EDGE_COUNT_CLASS)) {
        revealPoint(drawnGraphPoint(event.target));
      }
    },
    [canvasRef, graphOrder, isShiftTabbingRef, nodes, revealPoint, stopFollowing],
  );

  return { onKeyDown: handleCanvasKey, onFocus: revealFocusedElement };
}

/** The id of the node an event landed on, read from the library's node element. */
function focusedNodeId(target: EventTarget): string | undefined {
  if (!isHTMLElement(target) || !target.classList.contains("react-flow__node")) {
    return undefined;
  }
  return target.dataset["id"];
}

/** One stop of the graph's Tab order: a node, or the item count on an edge. */
interface GraphFocusStop {
  readonly kind: "node" | "count";
  readonly id: string;
}

// Each node in the library's own node order, which the browser's Tab order already enters by,
// followed by the counts of the edges leaving it.
function graphFocusOrder(
  nodes: readonly { readonly id: string }[],
  edges: readonly { readonly id: string; readonly source: string }[],
): readonly GraphFocusStop[] {
  const countsBySource = new Map<string, GraphFocusStop[]>();
  for (const edge of edges) {
    const counts = countsBySource.get(edge.source) ?? [];
    counts.push({ kind: "count", id: edge.id });
    countsBySource.set(edge.source, counts);
  }
  return nodes.flatMap((node) => [
    { kind: "node" as const, id: node.id },
    ...(countsBySource.get(node.id) ?? []),
  ]);
}

/**
 * Where focus goes from a stop: the next stop of the walk, or, past either end, the first or last
 * node, handed to the browser's own Tab to carry out of the graph, since a count is no stop of the
 * browser's order.
 */
type GraphFocusMove =
  | { readonly kind: "stop"; readonly element: HTMLElement | SVGElement }
  | { readonly kind: "hand-off"; readonly element: HTMLElement };

/** The move from `target` to the next or previous stop of `order`; none from outside the walk. */
function moveGraphFocus(
  canvas: HTMLElement,
  order: readonly GraphFocusStop[],
  target: EventTarget,
  isBackward: boolean,
): GraphFocusMove | undefined {
  const from = graphStopOf(target);
  const index =
    from === undefined
      ? -1
      : order.findIndex((stop) => stop.kind === from.kind && stop.id === from.id);
  if (index === -1) {
    return undefined;
  }
  const step = isBackward ? -1 : 1;
  for (let next = index + step; next >= 0 && next < order.length; next += step) {
    const element = graphStopElement(canvas, order[next]);
    if (element !== null) {
      return { kind: "stop", element };
    }
  }
  const nodeElements = canvas.querySelectorAll<HTMLElement>(".react-flow__node");
  const endNode = nodeElements[isBackward ? 0 : nodeElements.length - 1];
  return endNode === undefined ? undefined : { kind: "hand-off", element: endNode };
}

// Where `element`'s center sits in the graph's own units, read off the drawn graph alone: the
// browser may already have scrolled the library's frame to show a focused element, which moves the
// element and the graph's origin alike, and the scale is the one the graph is drawn at.
function drawnGraphPoint(element: Element): CanvasPoint {
  const graph = element.closest<HTMLElement>(".react-flow__viewport");
  if (graph === null) {
    throw new Error("A focused run graph element is drawn outside the graph's viewport.");
  }
  const origin = graph.getBoundingClientRect();
  // The graph's own window, which may be another than this script's.
  const graphWindow = getWindow(graph);
  const scale = new graphWindow.DOMMatrixReadOnly(graphWindow.getComputedStyle(graph).transform).a;
  const box = element.getBoundingClientRect();
  return {
    x: (box.left + box.width / 2 - origin.left) / scale,
    y: (box.top + box.height / 2 - origin.top) / scale,
  };
}

// Whether focus came into the graph's walk from an element after it in the document's order, such
// as the canvas's own controls or whatever follows the canvas, rather than from a stop of the walk.
function isEnteredFromAfter(event: React.FocusEvent): boolean {
  const from = event.relatedTarget;
  return (
    from !== null &&
    graphStopOf(from) === undefined &&
    (from.compareDocumentPosition(event.target) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
  );
}

function graphStopOf(target: EventTarget): GraphFocusStop | undefined {
  const nodeId = focusedNodeId(target);
  if (nodeId !== undefined) {
    return { kind: "node", id: nodeId };
  }
  if (!isElement(target) || !target.classList.contains(EDGE_COUNT_CLASS)) {
    return undefined;
  }
  const edgeId = target.closest(".react-flow__edge")?.getAttribute("data-id");
  return edgeId === null || edgeId === undefined ? undefined : { kind: "count", id: edgeId };
}

function graphStopElement(
  canvas: HTMLElement,
  stop: GraphFocusStop | undefined,
): HTMLElement | SVGElement | null {
  if (stop === undefined) {
    return null;
  }
  const id = CSS.escape(stop.id);
  return stop.kind === "node"
    ? canvas.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
    : canvas.querySelector<SVGElement>(`.react-flow__edge[data-id="${id}"] .${EDGE_COUNT_CLASS}`);
}
