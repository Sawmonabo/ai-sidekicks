// The phase graph's mount point: everything between a caller's phase list and a
// canvas, and nothing else.
//
// WHAT THIS COMPONENT OWNS. The caller hands over wire-shaped phases, the pinned
// definition's topology where it has one, and a name for the region. This file
// places them, decides whether the sequence can be drawn at all, fetches the
// renderer's code, and stands an absence in the box until it lands. The drawing
// itself belongs to `PhaseGraphCanvas.tsx`, on the far side of the `import()` that
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
//
// Collapsing any two would be exactly the conflation the console's absence rule
// exists to prevent, and the first two are decided before the chunk is asked for.
//
// THE WRAPPER IS UNSTYLED UNTIL THE CHUNK LANDS, and that is the arrangement rather
// than an oversight: this family's sheet rides the lazy chunk, so before it arrives
// `.meridian-phase-graph` matches no rule. Nothing that renders in that window needs
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

import { useEffect, useRef, useState } from "react";

import { normalizeWireRejection, type WireRefusal } from "../../../core/index.js";
import { Nothing, RefusalBanner } from "../../../primitives/index.js";
import {
  phaseGraphLoader,
  type PhaseGraphLoader,
  type PhaseGraphModule,
} from "./phase-graph-loader.js";
import { PhaseSequenceLayoutCache, type PhaseSequenceLayout } from "./phase-sequence-layout.js";
import type { PhaseGraphNode, PhaseTopology, PhaseTopologyAbsence } from "./phase-topology.js";

export interface PhaseGraphProps {
  /** The run's phases in sequence order. Empty renders nothing rather than an empty canvas. */
  readonly phases: readonly PhaseGraphNode[];
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
export function PhaseGraph(props: PhaseGraphProps): React.JSX.Element {
  const layout = usePhaseSequenceLayout(props.phases, props.topology);
  // The chunk is asked for only when there is a picture to fetch it for. Both of the
  // conditions are named: an empty run lays out cleanly — a drawable sequence of no
  // phases — so `drawn` alone would fetch a renderer for a canvas with nothing on it.
  const isCanvasNeeded = layout.status === "drawn" && props.phases.length > 0;
  const graphModule = usePhaseGraphModule(phaseGraphLoader, isCanvasNeeded);

  if (props.phases.length === 0) {
    return (
      <div className="meridian-phase-graph">
        <Nothing
          kind="empty"
          placement="surface"
          title="This run has no phases."
          detail="A run's phase sequence is drawn here once the run reports one."
        />
      </div>
    );
  }

  if (layout.status === "malformed") {
    return (
      <div className="meridian-phase-graph">
        <Nothing
          kind="error"
          placement="surface"
          title="The phase sequence could not be drawn."
          detail={repeatedPhaseDetail(layout.repeatedPhaseIds)}
        />
      </div>
    );
  }

  if (graphModule.status !== "loaded") {
    return <div className="meridian-phase-graph">{renderUnloadedCanvas(graphModule)}</div>;
  }

  // Bound to a capitalised local because JSX reads a lowercase leading identifier as
  // a tag name; the component itself is the one the loader resolved.
  const LoadedPhaseGraphCanvas = graphModule.module.PhaseGraphCanvas;
  return (
    <div className="meridian-phase-graph">
      <LoadedPhaseGraphCanvas layout={layout} label={props.label} />
      {layout.topologyAbsence === undefined ? null : (
        <p className="meridian-phase-graph__caption">
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

/** Where the renderer's code is: still coming, here, or refused. */
type PhaseGraphModuleState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly module: PhaseGraphModule }
  | { readonly status: "failed"; readonly refusal: WireRefusal };

const LOADING_GRAPH_MODULE: PhaseGraphModuleState = { status: "loading" };

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
 */
function renderUnloadedCanvas(
  graphModule: Exclude<PhaseGraphModuleState, { status: "loaded" }>,
): React.JSX.Element {
  return graphModule.status === "loading" ? (
    <Nothing kind="not-loaded" placement="surface" title="Loading the phase graph" />
  ) : (
    <RefusalBanner {...graphModule.refusal} />
  );
}

/**
 * Place the phases, holding the result still while the run does.
 *
 * The cache is built once per mount through a ref rather than on each render: a new
 * cache every render would memoise nothing, and constructing one in a render body is
 * the construction React may discard.
 */
function usePhaseSequenceLayout(
  phases: readonly PhaseGraphNode[],
  topology: PhaseTopology | undefined,
): PhaseSequenceLayout {
  const cacheRef = useRef<PhaseSequenceLayoutCache | undefined>(undefined);
  const cache = (cacheRef.current ??= new PhaseSequenceLayoutCache());
  return cache.layoutFor(phases, topology);
}

/**
 * Fetch the renderer's chunk and say where it got to.
 *
 * A hook rather than a call in the render body, on `apps/desktop/AGENTS.md`'s rule
 * and for a concrete reason: `import()` is a side effect, and a render body that
 * started one would start a second on every discarded pass.
 *
 * UNMOUNT BEFORE THE CHUNK ARRIVES is the arm worth naming. A pane opened and closed
 * inside one fetch leaves a promise still in flight over a component React has
 * already dropped, and settling it into state would be a write against a disposed
 * host. The flag below is read on both arms, so a late resolution and a late
 * rejection are each ignored rather than one of them handled — and the memo inside
 * the loader means the fetch itself is not wasted: the next mount gets the chunk
 * this one paid for.
 *
 * `isNeeded` false leaves the state at `loading` and starts nothing. That is not a
 * fourth state pretending to be a third: the caller reads this value only on the arm
 * where a sequence is drawable, which is the same condition.
 */
function usePhaseGraphModule(loader: PhaseGraphLoader, isNeeded: boolean): PhaseGraphModuleState {
  const [graphModule, setGraphModule] = useState<PhaseGraphModuleState>(LOADING_GRAPH_MODULE);

  useEffect(() => {
    if (!isNeeded) {
      return undefined;
    }
    let isMounted = true;
    loader.load().then(
      (loaded) => {
        if (isMounted) {
          setGraphModule({ status: "loaded", module: loaded });
        }
      },
      (loadError: unknown) => {
        if (isMounted) {
          setGraphModule({
            status: "failed",
            // Through the console's one reader of a caught value, and never through
            // `instanceof` and `String(...)` written here. Both of those THROW on
            // values a rejection may legitimately carry — the first on a revoked
            // Proxy, the second on a null-prototype object with no `toString` — and
            // a throw inside this handler escapes as an unhandled rejection, leaving
            // the graph at `loading` forever with nothing on screen saying why. No
            // fallback: the browser's own message is what says which fetch failed,
            // and the synthesized `phase-graph-chunk-call-failed` names the seam.
            refusal: normalizeWireRejection("phase-graph-chunk", loadError),
          });
        }
      },
    );
    return () => {
      isMounted = false;
    };
  }, [loader, isNeeded]);

  return graphModule;
}
