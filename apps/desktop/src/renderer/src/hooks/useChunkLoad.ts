// Where a lazily loaded chunk got to, as a reading a mount point renders: still coming, here, or
// failed with a way to ask again. The loader is a parameter, so a refusing fetch can be driven
// in a test; the loader drops a failed fetch's memo, so a retry is a real request. A failure's
// own text, a browser's or a library's, goes to the diagnostic capture and never to the screen.

import { useCallback, useEffect, useState } from "react";

import { RealClock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import type { MemoizedLoad } from "#renderer/lib/memoized-load.js";
import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";

/** Where a chunk is: still coming, here, or failed. */
export type ChunkLoadState<TModule> =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly module: TModule }
  | { readonly status: "failed" };

/** Where the chunk got to, and how a person asks for it again. */
export interface ChunkLoad<TModule> {
  readonly state: ChunkLoadState<TModule>;
  /** Ask for the chunk again; only a refused fetch offers it. Stable for the mount. */
  readonly retry: () => void;
  /**
   * The retries the state answers, from `0`: the failure line's attempt, so a retry that fails
   * again in the same words is said again.
   */
  readonly attempt: number;
}

const LOADING_CHUNK = { status: "loading" } as const;
const FAILED_CHUNK = { status: "failed" } as const;

/** The subsystem every chunk failure's diagnostic record names. */
const CHUNK_LOAD_SOURCE = "hooks/useChunkLoad";

/**
 * Fetch a chunk through `loader` and say where it got to. A hook because `import()` is a side
 * effect a discarded render pass must not start; each run's own flag drops a settlement that
 * lands after unmount or a retry. `origin` names the chunk in the failure's diagnostic record.
 */
export function useChunkLoad<TModule>(
  loader: MemoizedLoad<TModule>,
  origin: string,
): ChunkLoad<TModule> {
  const [state, setState] = useState<ChunkLoadState<TModule>>(LOADING_CHUNK);
  // Raised by a retry, so the effect below asks the loader again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let isCurrent = true;
    loader.load().then(
      (module) => {
        if (isCurrent) {
          setState({ status: "loaded", module });
        }
      },
      (loadError: unknown) => {
        if (isCurrent) {
          // The app's one reader of a caught value: `instanceof` or `String()` here throw on a
          // revoked Proxy or a null-prototype object, leaving the box stuck at `loading`.
          const failure = normalizeWireRejection(origin, loadError);
          windowDiagnosticCapture.record({
            at: diagnosticStampAt(new RealClock()),
            severity: "error",
            source: CHUNK_LOAD_SOURCE,
            kind: failure.code,
            detail: failure.detail,
          });
          setState(FAILED_CHUNK);
        }
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [loader, origin, attempt]);

  const retry = useCallback(() => {
    setState(LOADING_CHUNK);
    setAttempt((previous) => previous + 1);
  }, []);

  return { state, retry, attempt };
}
