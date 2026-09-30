// The synthetic contexts and the controllable loader every loader-form case is written over.
//
// One home because the pane registry's and screen registry's `lazy-body` suites and
// `tests/browser/app-harness.test.tsx` all need a context the fallback can render from and a
// promise the case decides when to settle. The contexts are casts on purpose: a loader-form case
// reads only what the reserved region reads (the pane's `kind` and `sessionStore`, and the route
// kind a pending screen names), and building a bridge and stores to reach those would be a
// fixture proving the fixture.

import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type LazyBodyModule } from "@renderer/components/LazyBody/lazy-body.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";

/** A pane context carrying only what a loader-form case and its fallback reach. */
export function syntheticPaneContextAt(kind: PaneContext["kind"]): PaneContext {
  return { kind, sessionStore: undefined } as unknown as PaneContext;
}

/**
 * The same, for the screen registry. The route is real because the reserved region names the
 * destination it is waiting for, as the pane's names its kind.
 */
export function createSyntheticScreenContext(): ScreenContext {
  return { route: { kind: "settings", page: undefined } } as unknown as ScreenContext;
}

/**
 * A loader whose promise the case settles, so a wait can be proved rather than timed.
 *
 * A loader over `Promise.resolve` lands inside the first microtask drain, so a mount that waited
 * for nothing would pass too. Handing the arrival to the case lets the module land after the
 * mount's own boundaries, so only a mount that joined the registration's promise is still waiting.
 */
export function deferredBodyModule<TContext extends object>(): {
  /** The registration's `body`: one promise, however many callers ask for it. */
  readonly load: () => Promise<LazyBodyModule<TContext>>;
  /** Land the module. Everything joined to the loader settles from here and not before. */
  readonly arrive: (Body: (context: TContext) => React.ReactNode) => void;
} {
  let land: ((module: LazyBodyModule<TContext>) => void) | undefined;
  const pending = new Promise<LazyBodyModule<TContext>>((resolve) => {
    land = resolve;
  });
  return {
    load: () => pending,
    arrive: (Body) => {
      if (land === undefined) {
        throw new Error("the deferred body module was never given its resolver");
      }
      land({ Body });
    },
  };
}

/**
 * A loader whose module is written by the case, and a count of how often it was called. The
 * count is the instrument for the memo claims: a registry fetching once per caller would pass
 * every rendering assertion and still pay for the chunk on every arrow-key press. Shared because
 * both boards' suites take it.
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
