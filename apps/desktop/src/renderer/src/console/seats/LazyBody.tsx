// The Suspense boundary one loader-backed body mounts inside.
//
// ONE BOUNDARY PER REGISTRATION, WHICH IS THE POINT. A boundary around the whole deck
// would blank every open pane the moment any one of them started loading; a boundary
// around this body replaces this body and leaves the rest of the window painted. That is
// also why the fallback comes from the board rather than from here: the reserved region
// a pane leaves is its own chrome, and the one a route leaves is the surface's absence
// frame, and neither is a shape this module should decide.
//
// THE CONTEXT IS SPREAD AS PROPS, which is the shape both boards' contracts already
// have. A descriptor's `render` is `(context) => ReactNode`, and that is a function
// component's signature when the props ARE the context —
// `frame/pane-harness-instances.ts` already mounts a registered body that way. So a body
// module's `Body` export is an ordinary component and the loader form introduces no
// second calling convention. The context is therefore constrained to an object: a spread
// is only meaningful over one, and both boards' contexts are records already.

import { Suspense } from "react";

export interface LazyBodyProps<TContext extends object> {
  /**
   * The lazy form of the registered body.
   *
   * Held by the registration and passed in, never built here: a `lazy()` call in this
   * render body would mint a new component type on every pass, and React would unmount
   * and rebuild the body each time its host re-rendered.
   */
  readonly Body: React.ComponentType<TContext>;
  /** What stands in the body's place while its module is in flight. */
  readonly fallback: (context: TContext) => React.ReactNode;
  readonly context: TContext;
}

/**
 * Mount a loader-backed body, showing the board's reserved region until it lands.
 *
 * There is no error arm here on purpose. A chunk that cannot be fetched is a damaged
 * install rather than a body-level condition, and `primitives/SurfaceErrorBoundary` is
 * the console's one answer to a subtree that threw — a second, narrower boundary here
 * would catch the body's own render failures too and report them as a load that failed,
 * which is a different sentence and usually the wrong one.
 */
export function LazyBody<TContext extends object>(
  props: LazyBodyProps<TContext>,
): React.JSX.Element {
  const { Body, fallback, context } = props;
  return (
    <Suspense fallback={<>{fallback(context)}</>}>
      <Body {...context} />
    </Suspense>
  );
}
