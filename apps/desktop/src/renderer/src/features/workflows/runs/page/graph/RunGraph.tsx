// The run graph's mount point: fetches the canvas chunk and stands a loading or failed state
// in the box until it lands. The drawing is `RunGraphCanvas.tsx`'s, behind an `import()`, so the
// graph and layout libraries stay out of the page's own bundle.

import { useChunkLoad } from "#renderer/hooks/useChunkLoad.js";
import type { RunGraphCanvasProps } from "./RunGraphCanvas.js";
import { runGraphLoader } from "./loader.js";
import { UnloadedRunGraph } from "./UnloadedRunGraph.js";

/**
 * What the run page hands the graph: the workflow's document, the run's steps, the selected
 * node and what selecting one does. The canvas reads exactly this.
 */
export type RunGraphProps = RunGraphCanvasProps;

/** One run on its workflow's canvas, read-only, drawn once the canvas chunk arrives. */
export function RunGraph(props: RunGraphProps): React.JSX.Element {
  const {
    state: graphModule,
    retry: retryChunk,
    attempt: chunkAttempt,
  } = useChunkLoad(runGraphLoader, "run-graph-chunk");

  if (graphModule.status !== "loaded") {
    return (
      <div className="meridian-run-graph">
        {graphModule.status === "loading" ? (
          <UnloadedRunGraph state="loading" />
        ) : (
          <UnloadedRunGraph state="failed" onRetry={retryChunk} attempt={chunkAttempt} />
        )}
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
