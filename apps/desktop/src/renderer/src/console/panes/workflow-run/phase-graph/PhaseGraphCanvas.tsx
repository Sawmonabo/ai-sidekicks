// The canvas, and the whole of what the graph library is allowed to do here.
//
// THIS MODULE IS THE LAZY CHUNK. It is reached only through
// `phase-graph-loader.ts`'s `import()`, so the library, its runtime sibling, its
// `base.css` and this family's sheet are emitted together and fetched the first time
// a run's phases are drawn. Both stylesheets are imported HERE rather than from a
// barrel for exactly that reason: a sheet imported anywhere on the initial path
// would put 13.6 kB of library CSS into the document the operator waits for.
//
// THIS IS THE CONSOLE'S ONE STYLESHEET EDGE OUTSIDE A FAMILY BARREL, and it is
// asserted by name in `test/console/architecture/stylesheet-edges.test.ts` rather
// than left to a reader to notice. Pulling `phase-graph.css` up into `workflows.css`
// with the family's other per-surface sheets would break it twice over: it would put
// this sheet on the initial path the paragraph above keeps it off, and it would load
// it BEFORE `base.css` instead of after — so every `--xy-*` value the block below
// sets from Meridian would lose to the library's own fallback at equal specificity.
//
// THE STYLESHEET ORDER BELOW IS LOAD-BEARING. `base.css` defines the library's own
// fallback palette on `.react-flow`; this family's sheet redefines every one of
// those properties from Meridian tokens at equal specificity, so it has to come
// second. Nothing else about the two files interacts.
//
// THE PIN IS 12.11.5, NOT THE NEWEST 12.11.x. `Spec-023 §Console Libraries` requires
// an exact pin inside the `12.11.x` band with `@xyflow/system` in lockstep, and
// 12.11.5 is the newest release the workspace's 24-hour `minimumReleaseAge` guard
// admits — it is also the release that fixed the broken 12.11.4 that row warns
// about, and its manifest declares `@xyflow/system@0.0.81` exactly, so the lockstep
// constraint is met by the library's own dependency rather than by agreement between
// two hand-written numbers. `base.css` is byte-identical across the two releases, so
// the token set this family's sheet drives does not depend on which one is pinned.
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

import { ReactFlow, type FitViewOptions, type NodeTypes } from "@xyflow/react";

import "@xyflow/react/dist/base.css";
import "./phase-graph.css";

import { tokenReference } from "../../../tokens/index.js";
import { PHASE_NODE_TYPE, usePhaseGraphElements } from "./phase-graph-elements.js";
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
 * How far out a long run may be zoomed. 0.35 shows roughly three times as many ranks
 * as 1×, which is the point past which the label stops being readable at all — below
 * it the picture is a diagram of nothing.
 */
const PHASE_GRAPH_MIN_ZOOM = 0.35;

/**
 * How far in. 1.5 is a reading zoom for a long label, not a design tool's zoom: there
 * is nothing on this surface to inspect at pixel scale.
 */
const PHASE_GRAPH_MAX_ZOOM = 1.5;

/**
 * The arrowhead's colour.
 *
 * The library paints markers from a string it writes into an inline `style`, which is
 * a CSS declaration and so resolves `var()` — this is the one place a token reaches
 * the library through JavaScript rather than through the sheet, and it goes through
 * the console's own `tokenReference` so the token name is checked in one place.
 */
const SEQUENCE_MARKER_COLOR: string = tokenReference("edge-strong");

export interface PhaseGraphCanvasProps {
  /** The placed sequence. A malformed one never reaches here — the host refuses first. */
  readonly layout: DrawnPhaseSequence;
  /** The region's accessible name, supplied by the surface that mounted the graph. */
  readonly label: string;
}

/** One run's phase sequence, drawn. */
export function PhaseGraphCanvas(props: PhaseGraphCanvasProps): React.JSX.Element {
  const { nodes, edges } = usePhaseGraphElements(props.layout);

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
        minZoom={PHASE_GRAPH_MIN_ZOOM}
        maxZoom={PHASE_GRAPH_MAX_ZOOM}
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
