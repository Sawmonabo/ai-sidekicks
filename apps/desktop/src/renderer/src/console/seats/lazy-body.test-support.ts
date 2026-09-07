// The synthetic contexts and the controllable loader every loader-form case is written
// over.
//
// ONE HOME BECAUSE TWO TIERS ASK THE SAME QUESTION. `lazy-body.test.tsx` proves what the
// boards do with a loader; `test/console/browser/console-harness-settle.test.tsx` proves
// that the shared browser mount waits for one. Both need a context the fallback can
// render from and a promise the case itself decides when to settle, and a second copy of
// either is how two tiers come to disagree about what a cold mount looks like.
//
// THE CONTEXTS ARE CASTS, DELIBERATELY AND OUT LOUD. What a loader-form case reads of a
// context is what the reserved region reads of it — the pane's `kind`, `focusHue` and
// `sessionStore`, and the route kind a pending surface names — and building a bridge, a
// frame store and three persistence stores to reach those four members would be a
// fixture proving the fixture. The cast says so where a reader meets it rather than
// hiding behind a builder that looks complete and is not.

import { type ConsolePaneContext } from "./pane-context.js";
import { type LazyBodyModule } from "./lazy-body.js";
import { type ConsoleSurfaceContext } from "./surface-context.js";

/** A pane context carrying only what a loader-form case and its fallback reach. */
export function syntheticPaneContextAt(kind: ConsolePaneContext["kind"]): ConsolePaneContext {
  return { kind, sessionStore: undefined, focusHue: undefined } as unknown as ConsolePaneContext;
}

/**
 * The same, for the frame's board.
 *
 * The route is real because the surface's reserved region names the destination it is
 * waiting for, exactly as the pane's names its kind.
 */
export function syntheticSurfaceContext(): ConsoleSurfaceContext {
  return { route: { kind: "settings", page: undefined } } as unknown as ConsoleSurfaceContext;
}

/**
 * A loader whose promise the CASE settles, so a wait can be proved rather than timed.
 *
 * WHY THE CASE HOLDS THE TRIGGER. A loader built over `Promise.resolve` lands inside the
 * first microtask drain, which every settle in this package crosses — so a mount that
 * waited for nothing at all would satisfy the assertion just as well as one that waited
 * correctly, and the case would be green against both. Handing the arrival to the case
 * is what separates the two: the module lands after the mount's own boundaries have gone
 * by, and only a mount that joined the registration's promise can still be waiting.
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
