// The phase graph's mount point: everything between a caller's phase list and a
// canvas, and nothing else.
//
// WHAT THIS COMPONENT OWNS. The caller hands over wire-shaped phases, the pinned
// definition's topology where it has one, and a name for the region. This file
// places them, decides whether the sequence can be drawn at all, fetches the
// renderer's code, and stands an absence in the box until it lands. The drawing
// itself belongs to `RunGraphCanvas.tsx`, on the far side of the `import()` that
// names this directory's `index.ts`, so a surface that mounts this component never
// names the graph library and never pulls a byte of it into the initial bundle.
//
// A GRAPH WITH NO EDGES SAYS SO IN WORDS. A run read carries no topology, so a
// caller with no definition to hand over gets placed phases and no connectors — and
// a picture of disconnected boxes is indistinguishable on screen from a workflow
// whose phases genuinely depend on nothing. The caption beneath the canvas is what
// tells those two apart, and it names which of the two absences occurred: nothing to
// read, or a definition whose topology could not be drawn.
//
// FOUR ABSENCES, AND THEY ARE FOUR BECAUSE THE OPERATOR'S NEXT MOVE DIFFERS:
//
//   • A run with no phases is EMPTY: the read succeeded and found none. Drawing an
//     empty canvas instead would be a picture asserting a shape the run never had.
//   • A sequence that repeats a phase id is an ERROR, named. Node identity on the
//     canvas is the phase id, so drawing one would silently show fewer phases than
//     the run has — a picture that looks finished and is short. Refusing names which
//     id repeated, so the next move is to fix the producer rather than to guess.
//   • A chunk still in flight is NOT-LOADED: the read-in-flight skeleton, which says
//     nothing because there is nothing yet to say.
//   • A chunk the browser refused is a REFUSAL, not an absence: something was asked
//     for and the answer was no, which is the one arm here that carries a code. It
//     goes through `normalizeWireRejection` and renders in the refusal grammar, so
//     the fetch's own message survives verbatim beside a code a person can quote.
//     And it carries a way to ask again, because the loader drops its memo on a
//     rejection precisely so a second `load()` re-fetches — a transient network or
//     disk failure being the expected cause. Without a control the only caller
//     latched the refusal for the life of the pane: the hardening was in the loader
//     and unreachable from the screen, so a fetch that failed once could be answered
//     only by closing the pane and opening it again.
//
// Collapsing any two would be exactly the conflation the console's absence rule
// exists to prevent, and the first two are decided before the chunk is asked for.
//
// THE WRAPPER IS UNSTYLED UNTIL THE CHUNK LANDS, and that is the arrangement rather
// than an oversight: this family's sheet rides the lazy chunk, so before it arrives
// `.meridian-run-graph` matches no rule. Nothing that renders in that window needs
// one — the absence primitive and the refusal banner both come from `primitives/`,
// whose sheet is in the initial bundle, and the wrapper's only job until then is to
// be the block they stand in. That matters most on the arm where the chunk never
// arrives at all: a refusal styled from the chunk that failed would be invisible.
//
// WHY THE LAYOUT LIVES IN A REF AND NOT IN A RENDER BODY. Placing phases is a
// derivation, and `apps/desktop/AGENTS.md` puts derivations in a class or a hook.
// The cache is a class with a private memo and one instance per mounted graph, so
// two graphs on screen never share one and the renderer downstream is handed arrays
// whose identity holds still while the run does.

import { Nothing, RefusalBanner } from "@renderer/console/primitives/index.js";
import { runGraphLoader } from "./run-graph-loader.js";
import type { RunGraphNode, PhaseTopology, PhaseTopologyAbsence } from "./phase-topology.js";
import { usePhaseSequenceLayout } from "./hooks/usePhaseSequenceLayout.js";
import { useRunGraphModule, type RunGraphModuleState } from "./hooks/useRunGraphModule.js";

export interface RunGraphProps {
  /** The run's phases in sequence order. Empty renders nothing rather than an empty canvas. */
  readonly phases: readonly RunGraphNode[];
  /**
   * The pinned definition's phases, where the surface holds one.
   *
   * Absent draws no edges at all, which is the honest picture rather than a degraded
   * one: a run's dependencies are the definition's, and there is no inferring them
   * from the order a run read happens to carry.
   */
  readonly topology?: PhaseTopology;
  /** The region's accessible name, supplied by the surface that mounts it. */
  readonly label: string;
}

/**
 * What the caption says for each reason a picture carries no connectors.
 *
 * A table rather than two ternaries at the call site, because the set is closed by
 * the layout's own union: a third reason fails to compile here until it has a
 * sentence, which is where the operator finds out what happened.
 */
const TOPOLOGY_ABSENCE_CAPTIONS: Readonly<Record<PhaseTopologyAbsence, string>> = {
  "not-supplied":
    "Dependencies unavailable — this run's definition has not been read here, so the phases are shown in the order the run reports them and nothing is connected.",
  "not-drawable":
    "Dependencies unavailable — the definition that was read does not declare a topology this run can be drawn from, so the phases are shown in the order the run reports them.",
};

/** One run's phase sequence, read-only, drawn once its renderer arrives. */
export function RunGraph(props: RunGraphProps): React.JSX.Element {
  const layout = usePhaseSequenceLayout(props.phases, props.topology);
  // The chunk is asked for only when there is a picture to fetch it for. Both of the
  // conditions are named: an empty run lays out cleanly — a drawable sequence of no
  // phases — so `drawn` alone would fetch a renderer for a canvas with nothing on it.
  const isCanvasNeeded = layout.status === "drawn" && props.phases.length > 0;
  const { state: graphModule, retry: retryChunk } = useRunGraphModule(
    runGraphLoader,
    isCanvasNeeded,
  );

  if (props.phases.length === 0) {
    return (
      <div className="meridian-run-graph">
        <Nothing
          kind="empty"
          placement="block"
          title="This run has no phases."
          detail="A run's phase sequence is drawn here once the run reports one."
        />
      </div>
    );
  }

  if (layout.status === "malformed") {
    return (
      <div className="meridian-run-graph">
        <Nothing
          kind="error"
          placement="block"
          title="The phase sequence could not be drawn."
          detail={repeatedPhaseDetail(layout.repeatedPhaseIds)}
        />
      </div>
    );
  }

  if (graphModule.status !== "loaded") {
    return (
      <div className="meridian-run-graph">{renderUnloadedCanvas(graphModule, retryChunk)}</div>
    );
  }

  // Bound to a capitalized local because JSX reads a lowercase leading identifier as
  // a tag name; the component itself is the one the loader resolved.
  const LoadedRunGraphCanvas = graphModule.module.RunGraphCanvas;
  return (
    <div className="meridian-run-graph">
      <LoadedRunGraphCanvas layout={layout} label={props.label} />
      {layout.topologyAbsence === undefined ? null : (
        <p className="meridian-run-graph__caption">
          {TOPOLOGY_ABSENCE_CAPTIONS[layout.topologyAbsence]}
        </p>
      )}
    </div>
  );
}

/**
 * Why a sequence was refused, in the operator's terms.
 *
 * Names the ids rather than counting them: "two phases repeated" tells nobody which
 * producer to look at, and the ids are the only thing here that does.
 */
function repeatedPhaseDetail(repeatedPhaseIds: readonly string[]): string {
  return `More than one phase arrived under the same identifier: ${repeatedPhaseIds.join(", ")}. Every phase on the canvas is keyed by its identifier, so drawing this run would have shown fewer phases than it has.`;
}

/**
 * What stands in the canvas box while the renderer's code is not there.
 *
 * TWO STATES AND TWO GRAMMARS, because they are two different facts. A chunk in
 * flight is an absence — `not-loaded`, and deliberately neither `empty`, which would
 * claim the run has no phases this arm has already disproved, nor `not-checked`,
 * which would claim nobody asked. A chunk the browser refused is a REFUSAL: something
 * was asked for and the answer was no, so it renders in the refusal grammar the rest
 * of this family renders a failed read in, carrying its code in mono. It was a
 * `Nothing kind="error"` with a bare message and no code — the one failure on this
 * surface a person could not quote.
 *
 * THE NEXT MOVE RIDES THE REFUSAL AND NOT THE ABSENCE, which is the grammar's own
 * split: `action` is the caller's answer to "what now", and a chunk still in flight
 * has no answer to offer. The button wears the feature's own action treatment, whose
 * rules are in `WorkflowStateStrip.css` and load with the page rather than the graph's
 * chunk — a control styled from the chunk that failed to arrive would be invisible on
 * exactly the arm that needs it.
 */
function renderUnloadedCanvas(
  graphModule: Exclude<RunGraphModuleState, { status: "loaded" }>,
  retryChunk: () => void,
): React.JSX.Element {
  return graphModule.status === "loading" ? (
    <Nothing kind="not-loaded" placement="block" title="Loading the phase graph" />
  ) : (
    <RefusalBanner
      {...graphModule.refusal}
      action={
        <button type="button" className="meridian-workflow__action" onClick={retryChunk}>
          Try loading the graph again
        </button>
      }
    />
  );
}
