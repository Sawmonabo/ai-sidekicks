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

import { Suspense, useState } from "react";

import { RevealFocusHandoff } from "./lazy-body-focus.js";
import { LazyBodyFocusHandoff } from "./LazyBodyFocusHandoff.js";

export interface LazyBodyProps<TContext extends object> {
  /**
   * The lazy form of the registered body.
   *
   * Held by the registration and passed in, never built here: a `lazy()` call in this
   * render body would mint a new component type on every pass, and React would unmount
   * and rebuild the body each time its host re-rendered.
   */
  readonly Body: React.ComponentType<TContext>;
  /**
   * The settled body, when the registration's load has already finished.
   *
   * `undefined` on a cold mount. Supplied so a mount that begins AFTER a preload
   * completed can render the module directly and never suspend: `lazy` learns its value
   * in a microtask however warm the underlying promise is, which costs a committed
   * fallback frame on exactly the path that paid to avoid one.
   */
  readonly resolvedBody?: React.ComponentType<TContext> | undefined;
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
 *
 * THE FOCUS IS CARRIED ACROSS THE REVEAL, and `lazy-body-focus.ts` states why it has to
 * be carried rather than kept: the reserved region and the loaded body are two subtrees,
 * so the reveal DELETES the chrome a person may be standing on. The handoff pair below
 * is the transfer — one record per mount, written as the reserved side goes and read as
 * the loaded side arrives.
 */
export function LazyBody<TContext extends object>(
  props: LazyBodyProps<TContext>,
): React.JSX.Element {
  const { Body, resolvedBody, fallback, context } = props;
  // PINNED AT THIS MOUNT'S FIRST RENDER, and pinning is the whole of the care here.
  // The two arms are different component TYPES, so swapping between them mid-mount is an
  // unmount and a rebuild — the body loses its state and its effects run again, for a
  // module that had merely finished arriving. Choosing once means a mount that started
  // warm never suspends and a mount that started cold keeps the lazy element it began
  // with and swaps nothing when the module lands.
  const [MountedBody] = useState<React.ComponentType<TContext>>(() => resolvedBody ?? Body);
  // One record per MOUNT, minted once for the same reason the body is pinned once: two
  // panes revealing in the same commit each restore their own control.
  const [focusHandoff] = useState(() => new RevealFocusHandoff());
  return (
    <Suspense
      fallback={
        // BEFORE the reserved region and not after it, which is load-bearing rather than
        // stylistic: React deletes a subtree in child order and detaches each host node as
        // it finishes with it, so a recorder placed after the chrome would run its teardown
        // once that chrome was already out of the document and focus already lost. First
        // means the teardown reads a document that still holds the focused control.
        <>
          <LazyBodyFocusHandoff handoff={focusHandoff} phase="reserved" />
          {fallback(context)}
        </>
      }
    >
      <LazyBodyFocusHandoff handoff={focusHandoff} phase="revealed" />
      <MountedBody {...context} />
    </Suspense>
  );
}
