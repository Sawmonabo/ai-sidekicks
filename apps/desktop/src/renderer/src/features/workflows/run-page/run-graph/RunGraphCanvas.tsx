// The canvas, and the whole of what the graph library is allowed to do here. It is the lazy
// chunk's entry (`run-graph-loader.ts` imports it). The two sheets load in this order:
// `run-graph.css` redefines the library's fallback palette at equal specificity, so it is second.
// The library is pinned to an exact version because its bundle and heap cost were measured there.

import "@xyflow/react/dist/base.css";
import "./run-graph.css";

import { ReactFlow, type FitViewOptions, type NodeTypes } from "@xyflow/react";

import { tokenReference } from "@renderer/styles/tokens.js";
import { RUN_GRAPH_MAX_ZOOM, RUN_GRAPH_MIN_ZOOM } from "../../workflows-caps.js";
import { PHASE_NODE_TYPE } from "./run-graph-elements.js";
import { useRunGraphElements } from "./hooks/useRunGraphElements.js";
import { PhaseNode } from "./PhaseNode.js";
import type { DrawnPhaseSequence } from "./phase-sequence-layout.js";

/**
 * The node kinds this canvas renders. A module constant because the library re-registers its
 * renderers, and warns, whenever this object's identity moves.
 */
const PHASE_NODE_TYPES: NodeTypes = { [PHASE_NODE_TYPE]: PhaseNode };

/**
 * How much of the viewport is left empty around the fitted graph, as a fraction.
 *
 * Keeps the first and last box clear of the pane's own edge.
 */
const PHASE_GRAPH_FIT_VIEW_PADDING = 0.12;

/** Stable for the same reason the node table is: the library reads it on every fit. */
const PHASE_GRAPH_FIT_VIEW_OPTIONS: FitViewOptions = { padding: PHASE_GRAPH_FIT_VIEW_PADDING };

/**
 * The arrowhead's color.
 *
 * The library writes it into an inline `style`, which resolves `var()`, so this is the one
 * token that reaches the library through JavaScript; `tokenReference` checks the token name.
 */
const SEQUENCE_MARKER_COLOR: string = tokenReference("edge-strong");

/** The placed sequence to draw and the region's accessible name. */
export interface RunGraphCanvasProps {
  /** The placed sequence. A malformed one never reaches here — the host refuses first. */
  readonly layout: DrawnPhaseSequence;
  /** The region's accessible name, supplied by the component that mounted the graph. */
  readonly label: string;
}

/** One run's phase sequence, drawn. */
export function RunGraphCanvas(props: RunGraphCanvasProps): React.JSX.Element {
  const { nodes, edges } = useRunGraphElements(props.layout);

  return (
    <div className="meridian-run-graph__canvas">
      <ReactFlow
        aria-label={props.label}
        nodes={nodes}
        edges={edges}
        nodeTypes={PHASE_NODE_TYPES}
        // Read-only, one prop per gesture: nothing on this canvas can change a run.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesReconnectable={false}
        // Switches off arrow-key node movement and the library's own aria-live region; nothing
        // moves or selects here, and the console has one live announcer. Focus is separate.
        disableKeyboardA11y
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        // Reading, not editing: nodes stay focusable so a keyboard reaches every phase.
        nodesFocusable
        edgesFocusable={false}
        fitView
        fitViewOptions={PHASE_GRAPH_FIT_VIEW_OPTIONS}
        minZoom={RUN_GRAPH_MIN_ZOOM}
        maxZoom={RUN_GRAPH_MAX_ZOOM}
        defaultMarkerColor={SEQUENCE_MARKER_COLOR}
        // The console's scheme is carried by the tokens the sheet sets, so the library's dark
        // rules must never match; `light` keeps that true if the library's default changes.
        colorMode="light"
      />
    </div>
  );
}
