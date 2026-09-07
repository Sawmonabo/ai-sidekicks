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

/** What one mount holds for as long as its registration is the one it started on. */
interface PinnedBody<TContext extends object> {
  /**
   * The registration this pin belongs to, read as the `lazy()` component it built.
   *
   * The board mints exactly one of those per registration and holds it, so comparing it
   * is comparing registrations — no counter, no id, and nothing for a caller to keep in
   * step with the thing it identifies.
   */
  readonly registration: React.ComponentType<TContext>;
  /** The arm this mount renders: the settled body if there was one, else the lazy form. */
  readonly MountedBody: React.ComponentType<TContext>;
  /** The reveal record the reserved side writes and the loaded side reads. */
  readonly focusHandoff: RevealFocusHandoff;
}

/** Pin one registration's arm, with the reveal record that belongs to that mount. */
function pinBody<TContext extends object>(
  Body: React.ComponentType<TContext>,
  resolvedBody: React.ComponentType<TContext> | undefined,
): PinnedBody<TContext> {
  return {
    registration: Body,
    MountedBody: resolvedBody ?? Body,
    focusHandoff: new RevealFocusHandoff(),
  };
}

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
  // PINNED PER REGISTRATION, and pinning is the whole of the care here. The two arms are
  // different component TYPES, so swapping between them mid-mount is an unmount and a
  // rebuild — the body loses its state and its effects run again, for a module that had
  // merely finished arriving. Choosing once means a mount that started warm never
  // suspends and a mount that started cold keeps the lazy element it began with and swaps
  // nothing when the module lands.
  //
  // AND THE PIN IS RELEASED WHEN THE `Body` IT WAS GIVEN CHANGES, which is the half a
  // `useState` initializer alone cannot do. A registration holds one `lazy()` at a time,
  // so that component's identity is the identity of the load it stands for, and exactly
  // two things replace it: a board re-registering the same kind under the same owner — a
  // hot reload, a suite recomposing a family, a window swapping a fixture — which
  // replaces the whole `LoadedLazyBody`, and a load that REJECTED, which rebuilds the
  // `lazy()` over a fresh memo because React never re-runs a rejected one's initializer
  // (`lazy-body.ts` states that at the field). The element type and its position do not
  // change through either, so React keeps this instance and the initializer never runs
  // again; the pin then held a lazy component over a loader nothing would ever call, and
  // the surface went on rendering the module the OLD registration named. Re-derived on
  // the render that sees the new one instead — React's own adjust-state-during-render,
  // which re-renders before committing anything, so no frame shows the stale arm.
  const [held, setPinned] = useState(() => pinBody(Body, resolvedBody));
  // The SAME object is both rendered and stored, so the re-render this schedules settles
  // on the first pass rather than minting a second pin nobody reads. The reveal record
  // travels inside it and is re-minted with the body, for the reason it is per mount at
  // all: it is a handoff between two subtrees of one mount, and a record kept across a
  // swap would be read by a body the control it names never belonged to.
  const pinned = held.registration === Body ? held : pinBody(Body, resolvedBody);
  if (pinned !== held) {
    setPinned(pinned);
  }
  const { MountedBody, focusHandoff } = pinned;
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
