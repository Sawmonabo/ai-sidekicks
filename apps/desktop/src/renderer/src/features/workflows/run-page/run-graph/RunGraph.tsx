// The phase graph's mount point: places the caller's phases, decides whether the sequence can
// be drawn, fetches the renderer's chunk and stands an empty state in the box until it lands. The
// drawing is `RunGraphCanvas.tsx`'s, behind an `import()`, so the graph library stays out of
// the initial bundle.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { RefusalBanner } from "@renderer/components/Refusal/RefusalBanner.js";
import { runGraphLoader } from "./run-graph-loader.js";
import type { RunGraphNode, PhaseTopology, PhaseTopologyAbsence } from "./phase-topology.js";
import { usePhaseSequenceLayout } from "./hooks/usePhaseSequenceLayout.js";
import { useRunGraphModule, type RunGraphModuleState } from "./hooks/useRunGraphModule.js";

/** The phases to draw, the pinned definition's topology where held, and the region's name. */
export interface RunGraphProps {
  /** The run's phases in sequence order. Empty renders a no-phases empty state, not a canvas. */
  readonly phases: readonly RunGraphNode[];
  /**
   * The pinned definition's phases, where the caller holds one.
   *
   * Absent draws no edges: dependencies are the definition's and cannot be inferred from the
   * order a run read carries.
   */
  readonly topology?: PhaseTopology;
  /** The region's accessible name, supplied by the component that mounts it. */
  readonly label: string;
}

/**
 * What the caption says for each reason a picture carries no connectors.
 *
 * Without it, disconnected boxes look like a workflow whose phases depend on nothing. Closed
 * by the layout's union, so a third reason fails to compile until it has a sentence.
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
  // The chunk is asked for only when there is a picture to fetch it for: an empty run lays out
  // cleanly, so `drawn` alone would fetch a renderer for an empty canvas.
  const isCanvasNeeded = layout.status === "drawn" && props.phases.length > 0;
  const { state: graphModule, retry: retryChunk } = useRunGraphModule(
    runGraphLoader,
    isCanvasNeeded,
  );

  // Empty is a fact about the run, not a picture: a canvas would assert a shape it never had.
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

  // Node identity is the phase id, so a repeated id is named rather than drawn short.
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

  // Capitalized because JSX reads a lowercase leading identifier as a tag name.
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
 * Why a sequence was refused, in the person's terms.
 *
 * Names the ids rather than counting them: the ids say which producer to look at.
 */
function repeatedPhaseDetail(repeatedPhaseIds: readonly string[]): string {
  return `More than one phase arrived under the same identifier: ${repeatedPhaseIds.join(", ")}. Every phase on the canvas is keyed by its identifier, so drawing this run would have shown fewer phases than it has.`;
}

/**
 * What stands in the canvas box while the renderer's code is not there.
 *
 * A chunk in flight is a `not-loaded` empty state; a refused chunk is a refusal with a retry
 * action. Both use only styles that load with the page, since one from the graph chunk would
 * be missing exactly when the chunk failed.
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
