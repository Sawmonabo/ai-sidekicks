// The synthetic pane context and the counting loader the pane registry's loader-form cases are
// written over. The context is a cast on purpose: a loader-form case reads only what the reserved
// region reads (the pane's `kind` and `sessionStore`), and building a bridge and stores to reach
// those would be a fixture proving the fixture.

import { type PaneContext } from "#renderer/registries/panes/pane-context.js";
import { type LazyBodyModule } from "#renderer/components/LazyBody/lazy-body.js";

/** A pane context carrying only what a loader-form case and its fallback reach. */
export function syntheticPaneContextAt(kind: PaneContext["kind"]): PaneContext {
  return { kind, sessionStore: undefined } as unknown as PaneContext;
}

/**
 * A loader whose module is written by the case, and a count of how often it was called. The
 * count is the instrument for the memo claims: a registry fetching once per caller would pass
 * every rendering assertion and still pay for the chunk on every arrow-key press.
 */
export function countingLoader<TContext extends object>(
  Body: (context: TContext) => React.ReactNode,
): { readonly load: () => Promise<LazyBodyModule<TContext>>; readonly callCount: () => number } {
  let callCount = 0;
  return {
    load: () => {
      callCount += 1;
      return Promise.resolve({ Body });
    },
    callCount: () => callCount,
  };
}
