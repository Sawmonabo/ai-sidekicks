// The Suspense boundary one loader-backed body mounts inside. One boundary per registration, so
// a body that is still loading blanks only itself. The context is spread as props, so a body
// module's `Body` is an ordinary component.

import { Suspense, useState } from "react";

import { RevealFocusTransfer } from "./reveal-focus-transfer.js";
import { LazyBodyFocusTransfer } from "./LazyBodyFocusTransfer.js";

/** Props for `LazyBody`; `context` is spread onto the body as its props. */
export interface LazyBodyProps<TContext extends object> {
  /**
   * The registration's lazy component, built by the registration: a `lazy()` here would remount
   * every render.
   */
  readonly Body: React.ComponentType<TContext>;
  /**
   * The settled body once the load has finished, else `undefined`. Rendering it directly avoids
   * the committed fallback frame `lazy` costs even for a resolved promise.
   */
  readonly resolvedBody?: React.ComponentType<TContext> | undefined;
  /** What stands in the body's place while its module is in flight. */
  readonly fallback: (context: TContext) => React.ReactNode;
  readonly context: TContext;
}

/**
 * Mounts a loader-backed body, showing the board's reserved region until it lands, and carries
 * keyboard focus across the reveal. It has no error arm: `ErrorBoundary` is the one answer to a
 * subtree that threw, and a second boundary would report body render failures as load failures.
 */
export function LazyBody<TContext extends object>(
  props: LazyBodyProps<TContext>,
): React.JSX.Element {
  const { Body, resolvedBody, fallback, context } = props;
  // The arm is pinned per mount: the settled body and the lazy form are different component
  // types, so swapping mid-mount would remount the body and lose its state.
  //
  // The pin is released when `Body` changes (a re-registration, or a rebuilt `lazy()` after a
  // rejected load). React keeps this instance through either, so an initializer alone would
  // keep rendering the old registration's module. Re-deriving during render commits no stale
  // frame.
  const [held, setPinned] = useState(() => pinBody(Body, resolvedBody));
  // The same object is rendered and stored, so the scheduled re-render settles on the first
  // pass. The reveal record is re-minted with the pin: it belongs to one mount's two subtrees.
  const pinned = held.registration === Body ? held : pinBody(Body, resolvedBody);
  if (pinned !== held) {
    setPinned(pinned);
  }
  const { MountedBody, focusHandoff } = pinned;
  return (
    <Suspense
      fallback={
        // Before the reserved region: React deletes a subtree in child order, so a recorder
        // placed after the chrome would tear down once focus was already lost.
        <>
          <LazyBodyFocusTransfer handoff={focusHandoff} phase="reserved" />
          {fallback(context)}
        </>
      }
    >
      <LazyBodyFocusTransfer handoff={focusHandoff} phase="revealed" />
      <MountedBody {...context} />
    </Suspense>
  );
}

/** What one mount holds for as long as its registration is the one it started on. */
interface PinnedBody<TContext extends object> {
  /**
   * The registration's `lazy()` component. The board holds one per registration, so equality is
   * identity.
   */
  readonly registration: React.ComponentType<TContext>;
  /** The arm this mount renders: the settled body if there was one, else the lazy form. */
  readonly MountedBody: React.ComponentType<TContext>;
  /** The reveal record the reserved side writes and the loaded side reads. */
  readonly focusHandoff: RevealFocusTransfer;
}

/** Pin one registration's arm, with the reveal record that belongs to that mount. */
function pinBody<TContext extends object>(
  Body: React.ComponentType<TContext>,
  resolvedBody: React.ComponentType<TContext> | undefined,
): PinnedBody<TContext> {
  return {
    registration: Body,
    MountedBody: resolvedBody ?? Body,
    focusHandoff: new RevealFocusTransfer(),
  };
}
