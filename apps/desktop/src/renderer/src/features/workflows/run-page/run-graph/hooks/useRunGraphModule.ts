import { useCallback, useEffect, useState } from "react";

import { normalizeWireRejection, type WireRefusal } from "@renderer/lib/wire-rejection.js";
import type { MemoizedLoad } from "@renderer/lib/memoized-load.js";
import type { RunGraphModule } from "../run-graph-loader.js";

/** Where the renderer's code is: still coming, here, or refused. */
export type RunGraphModuleState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly module: RunGraphModule }
  | { readonly status: "failed"; readonly refusal: WireRefusal };

/** Where the chunk got to, and how a person asks for it again. */
export interface RunGraphModuleFetch {
  readonly state: RunGraphModuleState;
  /**
   * Ask for the chunk again. Only the refused arm offers it to anybody.
   *
   * Stable for the mount, so the refusal banner is handed one identity rather than a
   * fresh callback each pass.
   */
  readonly retry: () => void;
}

const LOADING_GRAPH_MODULE: RunGraphModuleState = { status: "loading" };

/**
 * Fetch the renderer's chunk and say where it got to.
 *
 * `import()` is a side effect, so it runs in an effect, and each run's own `isMounted` flag
 * drops a late settlement after unmount or retry. `isNeeded` false starts nothing. `retry`
 * bumps the attempt counter, so the loader (which drops its memo on rejection) is asked again.
 */
export function useRunGraphModule(
  loader: MemoizedLoad<RunGraphModule>,
  isNeeded: boolean,
): RunGraphModuleFetch {
  const [graphModule, setGraphModule] = useState<RunGraphModuleState>(LOADING_GRAPH_MODULE);
  const [attempt, setAttempt] = useState(0);

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
            // The console's one reader of a caught value: `instanceof` or `String()` here throw
            // on a revoked Proxy or a null-prototype object, leaving the graph stuck at `loading`.
            refusal: normalizeWireRejection("run-graph-chunk", loadError),
          });
        }
      },
    );
    return () => {
      isMounted = false;
    };
  }, [loader, isNeeded, attempt]);

  const retry = useCallback(() => {
    setGraphModule(LOADING_GRAPH_MODULE);
    setAttempt((previous) => previous + 1);
  }, []);

  return { state: graphModule, retry };
}
