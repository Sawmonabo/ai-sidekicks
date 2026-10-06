// Where a lazily loaded chunk got to, as a reading a mount point renders: still coming, here, or
// refused with a way to ask again. The loader is a parameter, so a refusing fetch can be driven
// in a test; the loader drops a failed fetch's memo, so a retry is a real request.

import { useCallback, useEffect, useState } from "react";

import type { MemoizedLoad } from "#renderer/lib/memoized-load.js";
import { normalizeWireRejection, type WireRefusal } from "#renderer/lib/wire/rejection.js";

/** Where a chunk is: still coming, here, or refused. */
export type ChunkLoadState<TModule> =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly module: TModule }
  | { readonly status: "failed"; readonly refusal: WireRefusal };

/** Where the chunk got to, and how a person asks for it again. */
export interface ChunkLoad<TModule> {
  readonly state: ChunkLoadState<TModule>;
  /** Ask for the chunk again; only a refused fetch offers it. Stable for the mount. */
  readonly retry: () => void;
}

const LOADING_CHUNK = { status: "loading" } as const;

/**
 * Fetch a chunk through `loader` and say where it got to. A hook because `import()` is a side
 * effect a discarded render pass must not start; each run's own flag drops a settlement that
 * lands after unmount or a retry. `origin` names the chunk in a refusal.
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
          setState({ status: "failed", refusal: normalizeWireRejection(origin, loadError) });
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

  return { state, retry };
}
