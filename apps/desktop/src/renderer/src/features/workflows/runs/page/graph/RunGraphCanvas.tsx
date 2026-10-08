// The canvas, and the whole of what the graph library is allowed to do here. It is the lazy chunk's
// entry (`loader.ts` imports it). The two sheets load in this order: `RunGraphCanvas.css` redefines
// the library's fallback palette at equal specificity, so it is second.

import "@xyflow/react/dist/base.css";
import "./RunGraphCanvas.css";

import { isHTMLElement } from "@floating-ui/utils/dom";
import { useCallback, useRef } from "react";
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

  // Any key on the canvas stops the follow; Enter or Space on a node also selects it, since the
  // library's own node keys are off along with its second live region.
  const handleCanvasKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      stopFollowing();
      const nodeId = focusedNodeId(event.target);
      if (nodeId !== undefined && SELECT_KEYS.includes(event.key)) {
        event.preventDefault();
        onSelectNode(nodeId);
      }
    },
    [onSelectNode, stopFollowing],
  );

  // A node or an edge's count reached by keyboard is brought into view, which the library does
  // only with its own keys on.
  const revealFocusedElement = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (!event.target.matches(":focus-visible")) {
        return;
      }
      const nodeId = focusedNodeId(event.target);
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
    [nodes, revealPoint, screenToFlowPosition],
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
