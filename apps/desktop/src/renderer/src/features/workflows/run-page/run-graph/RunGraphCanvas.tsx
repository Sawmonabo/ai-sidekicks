// The canvas, and the whole of what the graph library is allowed to do here.
//
// THIS MODULE IS INSIDE THE LAZY CHUNK, which `index.ts` beside it enters, so the library,
// its runtime sibling and the two sheets below are fetched together the first time a run's
// phases are drawn. THE ORDER OF THE TWO SHEETS IS LOAD-BEARING: `run-graph.css` redefines
// the library's fallback palette from `base.css` at equal specificity, so it loads second.
//
// THE PIN IS 12.11.6, WHICH IS THE BASELINE THE LIBRARY POLICY MEASURED. That policy
// binds an exact pin with `@xyflow/system` in lockstep and records its bundle and
// heap figures against 12.11.6 / `@xyflow/system@0.0.82`; the manifest carried
// 12.11.5 / 0.0.81, so the code was running a pair the governing decision had not
// measured. The lockstep half needs no second hand-written number either way —
// 12.11.6's manifest declares `@xyflow/system@0.0.82` exactly, so the library's own
// dependency is what meets it — and 12.11.5's fix for the broken 12.11.4 that policy
// warns about is carried forward rather than left behind.
//
// MOVING THE PIN COST 488 RAW BYTES AND 75 GZIPPED, ALL OF THEM IN THIS LAZY CHUNK
// (measured over both builds of this tree: 180,576 B raw / 58,465 B gzip at 12.11.5
// against 181,064 B / 58,540 B at 12.11.6). The initial graph does not move at all —
// 624,224 B raw and 187,562 B gzip on both — which is the lazy arrangement's whole
// claim holding under a version move. The chunk's stylesheet is byte-identical across
// the two releases, so the token set this family's sheet drives does not depend on
// which one is pinned.
//
// READ-ONLY IS EXPRESSED AS PROPS, NOT AS A CONVENTION. Dragging, connecting,
// selecting, reconnecting, deleting and keyboard node movement are each switched off
// below by the prop that governs them, so there is no gesture on this surface that
// changes a run. The authoring canvas is another plan's body; this one is a
// projection of a run that already happened or is happening.
//
// WHAT STAYS ON. Panning, zooming and focus: those are ways of READING a picture
// that does not fit, and a projection that could not be scrolled would simply hide
// the phases past the fold. Nodes stay focusable so a keyboard reaches every phase.
//
// WHY `disableKeyboardA11y` IS SET ON AN ACCESSIBLE SURFACE, which reads backwards
// until you look at what the flag governs: it turns off arrow-key node MOVEMENT, the
// selection-key handler, and the library's own `aria-live` region that narrates
// those moves. None of the three has anything to narrate here — nothing moves and
// nothing selects — and the console has exactly one live announcer, so a second
// region owned by a dependency is a second speaker. Focusability is a different prop
// and stays on.

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
 * The node kinds this canvas renders. A module constant because the library
 * re-registers its renderers whenever this object's identity moves, and warns about
 * it — a table built in the render body would rebuild every node on every commit.
 */
const PHASE_NODE_TYPES: NodeTypes = { [PHASE_NODE_TYPE]: PhaseNode };

/**
 * How much of the viewport is left empty around the fitted graph, as a fraction.
 *
 * 0.12 keeps the first and last box clear of the pane's own edge, so a sequence that
 * exactly fills the height does not read as clipped.
 */
const PHASE_GRAPH_FIT_VIEW_PADDING = 0.12;

/** Stable for the same reason the node table is: the library reads it on every fit. */
const PHASE_GRAPH_FIT_VIEW_OPTIONS: FitViewOptions = { padding: PHASE_GRAPH_FIT_VIEW_PADDING };

/**
 * The arrowhead's colour.
 *
 * The library paints markers from a string it writes into an inline `style`, which is
 * a CSS declaration and so resolves `var()` — this is the one place a token reaches
 * the library through JavaScript rather than through the sheet, and it goes through
 * the console's own `tokenReference` so the token name is checked in one place.
 */
const SEQUENCE_MARKER_COLOR: string = tokenReference("edge-strong");

export interface RunGraphCanvasProps {
  /** The placed sequence. A malformed one never reaches here — the host refuses first. */
  readonly layout: DrawnPhaseSequence;
  /** The region's accessible name, supplied by the surface that mounted the graph. */
  readonly label: string;
}

/** One run's phase sequence, drawn. */
export function RunGraphCanvas(props: RunGraphCanvasProps): React.JSX.Element {
  const { nodes, edges } = useRunGraphElements(props.layout);

  return (
    <div className="meridian-phase-graph__canvas">
      <ReactFlow
        aria-label={props.label}
        nodes={nodes}
        edges={edges}
        nodeTypes={PHASE_NODE_TYPES}
        // Read-only, one prop per gesture.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesReconnectable={false}
        disableKeyboardA11y
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        // Reading the picture, which is a different thing from editing it.
        nodesFocusable
        edgesFocusable={false}
        fitView
        fitViewOptions={PHASE_GRAPH_FIT_VIEW_OPTIONS}
        minZoom={RUN_GRAPH_MIN_ZOOM}
        maxZoom={RUN_GRAPH_MAX_ZOOM}
        defaultMarkerColor={SEQUENCE_MARKER_COLOR}
        // Names which of the library's two built-in palettes is the inert one. The
        // console's scheme is Meridian's and is carried by the tokens the sheet sets,
        // so the library's own dark rules must never match; pinning this keeps that
        // true if the library's default ever changes.
        colorMode="light"
      />
    </div>
  );
}
