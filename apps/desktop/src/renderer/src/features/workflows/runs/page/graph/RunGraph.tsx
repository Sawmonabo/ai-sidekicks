// The run graph's mount point: fetches the canvas chunk and stands a loading or failed state
// in the box until it lands. The drawing is `RunGraphCanvas.tsx`'s, behind an `import()`, so the
// graph and layout libraries stay out of the page's own bundle.

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useChunkLoad, type ChunkLoadState } from "#renderer/hooks/useChunkLoad.js";
import type { Clock } from "#renderer/lib/clock.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { RunGraphCanvasProps } from "./RunGraphCanvas.js";
import { runGraphLoader, type RunGraphModule } from "./loader.js";

/**
 * What the run page hands the graph: the workflow's document, the run's steps, the selected
 * node and what selecting one does. The canvas reads exactly this.
 */
export type RunGraphProps = RunGraphCanvasProps;

/** One run on its workflow's canvas, read-only, drawn once the canvas chunk arrives. */
export function RunGraph(props: RunGraphProps): React.JSX.Element {
  const clock = useClock();
  const {
    state: graphModule,
    retry: retryChunk,
    attempt: chunkAttempt,
  } = useChunkLoad(runGraphLoader, "run-graph-chunk");

  if (graphModule.status !== "loaded") {
    return (
      <div className="meridian-run-graph">
        {renderUnloadedCanvas(graphModule, retryChunk, chunkAttempt, clock)}
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
 * after the session's short delay while the chunk is in flight, and `Could not load the run graph`
 * with `Retry` when it failed, never the failure's own text. Both use only styles
 * that load with the page, since one from the graph chunk would be missing exactly when the
 * chunk failed.
 */
function renderUnloadedCanvas(
  graphModule: Exclude<ChunkLoadState<RunGraphModule>, { status: "loaded" }>,
  retryChunk: () => void,
  chunkAttempt: number,
  clock: Clock,
): React.JSX.Element {
  return graphModule.status === "loading" ? (
    <LoadingNotice clock={clock} placement="block" title="Loading the run graph…" />
  ) : (
    <Nothing
      kind="error"
      placement="block"
      title="Could not load the run graph"
      action={<TryAgainButton word="Retry" onPress={retryChunk} />}
      attempt={chunkAttempt}
    />
  );
}
