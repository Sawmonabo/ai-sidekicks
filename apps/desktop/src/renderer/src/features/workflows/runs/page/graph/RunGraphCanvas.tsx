// The canvas, and the whole of what the graph library is allowed to do here. It is the lazy chunk's
// entry (`loader.ts` imports it). The two sheets load in this order: `RunGraphCanvas.css` redefines
// the library's fallback palette at equal specificity, so it is second.

import "@xyflow/react/dist/base.css";
import "./RunGraphCanvas.css";

import { isElement, isHTMLElement } from "@floating-ui/utils/dom";
import { useCallback, useMemo, useRef } from "react";
import {
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";

import type { WorkflowDocument } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowEdgeItemCount } from "@ai-sidekicks/contracts/workflow/run/records";

import { tokenReference } from "#renderer/styles/tokens.js";
import { WORKFLOW_CANVAS_MEASURES } from "#renderer/features/workflows/canvas/measures.js";
import { EDGE_COUNT_CLASS, RUN_GRAPH_NODE_TYPE, runGraphNodeCenter } from "./elements.js";
import { RunGraphNode } from "./RunGraphNode.js";
import { useLiveStepFollow } from "./hooks/useLiveStepFollow.js";
import { useRunGraphElements } from "./hooks/useRunGraphElements.js";
import { ActionButton } from "#renderer/features/workflows/components/ActionButton.js";
import { useInViewMarks } from "../../hooks/useInViewMarks.js";

/** What the canvas draws: the workflow's document, the run's steps and counts, the selection. */
export interface RunGraphCanvasProps {
  readonly document: WorkflowDocument;
  readonly steps: readonly WorkflowStep[];
  /** How many items went through each edge, which the edge carries. */
  readonly edgeItemCounts: readonly WorkflowEdgeItemCount[];
  readonly selectedNodeId: string | undefined;
  /** The instant a resume time's day is counted from; it moves at midnight, not every second. */
  readonly nowMs: number;
  /** Called with a node's id when a person clicks it or presses Enter or Space on it. */
  readonly onSelectNode: (nodeId: string) => void;
}

/**
 * The node kinds this canvas renders. A module constant because the library re-registers its
 * renderers, and warns, whenever this object's identity moves.
 */
const RUN_GRAPH_NODE_TYPES: NodeTypes = { [RUN_GRAPH_NODE_TYPE]: RunGraphNode };

/**
 * How far out a long run may be zoomed. Below 0.35 (about three times the columns of 1x) the
 * names stop being readable.
 */
const RUN_GRAPH_MIN_ZOOM = 0.35;

/** How far in: a reading zoom for a long name; the graph has nothing to inspect at pixel scale. */
const RUN_GRAPH_MAX_ZOOM = 1.5;

/**
 * The arrowhead's color. The library writes it into an inline `style`, which resolves `var()`,
 * so this is the one token that reaches the library through script.
 */
const EDGE_MARKER_COLOR: string = tokenReference("edge-strong");

/** The keys that select the focused node, as a button's do. */
const SELECT_KEYS: readonly string[] = ["Enter", " "];

/** One run on its workflow's canvas, read-only, following the live step. */
export function RunGraphCanvas(props: RunGraphCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <RunGraphFlow {...props} />
    </ReactFlowProvider>
  );
}

/** The canvas inside the library's provider, where the view can be read and moved. */
function RunGraphFlow(props: RunGraphCanvasProps): React.JSX.Element {
  const { document, steps, edgeItemCounts, selectedNodeId, nowMs, onSelectNode } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  const { nodes, edges, liveCenter } = useRunGraphElements(
    document,
    steps,
    edgeItemCounts,
    selectedNodeId,
    nowMs,
  );
  const follow = useLiveStepFollow(liveCenter, canvasRef);
  const markInView = useInViewMarks();
  // The canvas is held for the follow and marked in view or out of it, so the sheet holds its
  // flowing edges still while it is scrolled away.
  const attachCanvas = useCallback(
    (element: HTMLDivElement | null) => {
      canvasRef.current = element;
      const unmark = markInView(element);
      return () => {
        canvasRef.current = null;
        unmark?.();
      };
    },
    [markInView],
  );
  const { stopFollowing, revealPoint } = follow;
  const { screenToFlowPosition } = useReactFlow();

  const selectClickedNode = useCallback<NodeMouseHandler>(
    (_event, node) => onSelectNode(node.id),
    [onSelectNode],
  );

  const graphOrder = useMemo(() => graphFocusOrder(nodes, edges), [nodes, edges]);
  // True only while the walk hands focus to an end node for the browser's own Tab to carry on.
  const isHandingOffRef = useRef(false);

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
          // Focus passes over the end node on its way out, which brings nothing into view.
          isHandingOffRef.current = true;
          move.element.focus();
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
    [graphOrder, onSelectNode, stopFollowing],
  );

  // A node or an edge's count reached by keyboard is brought into view, which the library does
  // only with its own keys on. Shift+Tab back into the walk lands on the browser's last node, so
  // focus moves on to the walk's last stop, the last count leaving that node where it has one.
  const revealFocusedElement = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (isHandingOffRef.current || !event.target.matches(":focus-visible")) {
        return;
      }
      const canvas = canvasRef.current;
      const nodeId = focusedNodeId(event.target);
      if (canvas !== null && nodeId !== undefined && isEnteredFromAfter(event)) {
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
        const countBox = event.target.getBoundingClientRect();
        revealPoint(
          screenToFlowPosition({
            x: countBox.left + countBox.width / 2,
            y: countBox.top + countBox.height / 2,
          }),
        );
      }
    },
    [graphOrder, nodes, revealPoint, screenToFlowPosition],
  );

  return (
    <div
      ref={attachCanvas}
      className="meridian-run-graph__canvas"
      style={WORKFLOW_CANVAS_MEASURES}
      onKeyDown={handleCanvasKey}
      onFocus={revealFocusedElement}
    >
      <ReactFlow
        aria-label="Run graph"
        nodes={nodes}
        edges={edges}
        nodeTypes={RUN_GRAPH_NODE_TYPES}
        onNodeClick={selectClickedNode}
        onMoveStart={follow.stopOnPersonMove}
        // Read-only, one prop per gesture: nothing on this canvas can change a run. Selection is
        // the page's, so the library selects nothing of its own.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesReconnectable={false}
        disableKeyboardA11y
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        nodesFocusable
        edgesFocusable={false}
        minZoom={RUN_GRAPH_MIN_ZOOM}
        maxZoom={RUN_GRAPH_MAX_ZOOM}
        defaultMarkerColor={EDGE_MARKER_COLOR}
        // The console's scheme is carried by the tokens the sheet sets, so the library's dark
        // rules must never match; `light` keeps that true if the library's default changes.
        colorMode="light"
      >
        {follow.canReturnToLiveStep ? (
          <Panel position="top-right">
            <ActionButton
              tone="raised"
              aria-label="Follow the live step now"
              // The chip's own keys are a press, not a key on the canvas.
              onKeyDown={(event) => event.stopPropagation()}
              onClick={follow.resumeFollowing}
            >
              now
            </ActionButton>
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
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
  return nodes.flatMap((node) => [
    { kind: "node" as const, id: node.id },
    ...edges
      .filter((edge) => edge.source === node.id)
      .map((edge) => ({ kind: "count" as const, id: edge.id })),
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
