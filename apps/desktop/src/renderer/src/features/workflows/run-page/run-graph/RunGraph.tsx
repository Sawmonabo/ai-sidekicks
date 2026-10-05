// The run graph's mount point: fetches the canvas chunk and stands a loading or refused state
// in the box until it lands. The drawing is `RunGraphCanvas.tsx`'s, behind an `import()`, so the
// graph and layout libraries stay out of the page's own bundle.

import { LoadingNotice } from "@renderer/components/LoadingNotice/LoadingNotice.js";
import { RefusalBanner } from "@renderer/components/Refusal/RefusalBanner.js";
import type { Clock } from "@renderer/lib/clock.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { ActionButton } from "../../components/ActionButton.js";
import type { RunGraphCanvasProps } from "./RunGraphCanvas.js";
import { runGraphLoader } from "./run-graph-loader.js";
import { useRunGraphModule, type RunGraphModuleState } from "./hooks/useRunGraphModule.js";

/**
 * What the run page hands the graph: the workflow's document, the run's steps, the selected
 * node and what selecting one does. The canvas reads exactly this.
 */
export type RunGraphProps = RunGraphCanvasProps;

/** One run on its workflow's canvas, read-only, drawn once the canvas chunk arrives. */
export function RunGraph(props: RunGraphProps): React.JSX.Element {
  const clock = useClock();
  const { state: graphModule, retry: retryChunk } = useRunGraphModule(runGraphLoader);

  if (graphModule.status !== "loaded") {
    return (
      <div className="meridian-run-graph">
        {renderUnloadedCanvas(graphModule, retryChunk, clock)}
      </div>
    );
  }

  // Capitalized because JSX reads a lowercase leading identifier as a tag name.
  const LoadedRunGraphCanvas = graphModule.module.RunGraphCanvas;
  return (
    <div className="meridian-run-graph">
      <LoadedRunGraphCanvas {...props} />
    </div>
  );
}

/**
 * What stands in the canvas box while the canvas code is not there: `Loading the run graph…`
 * after the session's short delay while the chunk is in flight, a refusal with a retry when it
 * was refused. Both use only styles that load with the page, since one from the graph chunk would
 * be missing exactly when the chunk failed.
 */
function renderUnloadedCanvas(
  graphModule: Exclude<RunGraphModuleState, { status: "loaded" }>,
  retryChunk: () => void,
  clock: Clock,
): React.JSX.Element {
  return graphModule.status === "loading" ? (
    <LoadingNotice clock={clock} placement="block" title="Loading the run graph…" />
  ) : (
    <RefusalBanner
      {...graphModule.refusal}
      action={<ActionButton onClick={retryChunk}>Try loading the graph again</ActionButton>}
    />
  );
}
