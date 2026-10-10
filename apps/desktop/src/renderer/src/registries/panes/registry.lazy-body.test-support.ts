// The counting loader the pane registry's loader-form cases are written over.

import { type LazyBodyModule } from "#renderer/components/LazyBody/loader.js";

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
