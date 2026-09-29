import { useCallback, useEffect, useState } from "react";

import { normalizeWireRejection, type WireRefusal } from "@renderer/lib/wire-rejection.js";
import type { RunGraphLoader, RunGraphModule } from "../run-graph-loader.js";

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
 *
 * THE ATTEMPT COUNT IS WHAT MAKES A SECOND FETCH REACHABLE. `loader` is module-scope
 * and `isNeeded` is true once a sequence is drawable, so neither of the other two
 * dependencies moves again for the life of the pane — the effect ran once and the
 * refusal it latched stood until the pane was closed, while the loader had already
 * dropped its memo so that a second `load()` would re-fetch. The counter is the one
 * dependency a person can move, and the state goes back to `loading` in the same act,
 * so the box says a fetch is in flight rather than holding the refusal beside it.
 *
 * A LATE SETTLEMENT FROM THE PREVIOUS ATTEMPT IS DROPPED BY THE ATTEMPT THAT RAISED
 * IT, not by a re-read of anything: each effect run owns its own flag and its cleanup
 * clears that one, so the answer to "was this settlement still wanted" is the identity
 * of the run that asked rather than a second look at the state it would write into.
 */
export function useRunGraphModule(loader: RunGraphLoader, isNeeded: boolean): RunGraphModuleFetch {
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
            // Through the console's one reader of a caught value, and never through
            // `instanceof` and `String(...)` written here. Both of those THROW on
            // values a rejection may legitimately carry — the first on a revoked
            // Proxy, the second on a null-prototype object with no `toString` — and
            // a throw inside this handler escapes as an unhandled rejection, leaving
            // the graph at `loading` forever with nothing on screen saying why. No
            // fallback: the browser's own message is what says which fetch failed,
            // and the synthesized `run-graph-chunk-call-failed` names the seam.
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
