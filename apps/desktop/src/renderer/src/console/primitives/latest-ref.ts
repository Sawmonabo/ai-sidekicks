// The latest COMMITTED value, readable from a callback that outlives the render.
//
// The problem it solves is one every surface with a long-lived callback meets. A
// palette command, a registered chord, a dispatch handed to a store: each is built
// once and invoked much later, so it cannot close over the render's props — it would
// dispatch against a run version, a session, or a bridge that has since moved. The
// shape that answers it is a ref the callback reads at invoke time.
//
// WHERE THE REF IS WRITTEN IS THE WHOLE CLAIM, AND A RENDER BODY IS THE WRONG PLACE.
// React's own rule is that a ref is not touched while rendering, and the reason is
// concrete rather than stylistic: a concurrent render that is thrown away has already
// run every component body in it, so a render-body assignment mutates state the
// COMMITTED tree keeps. The abandoned pass may have been for another session, another
// bridge, or another draft key — and the command still on screen would then invoke
// that discarded render's callbacks and its pending flags.
//
// A LAYOUT EFFECT AND NOT A PASSIVE ONE. A passive effect is flushed after paint, so
// between the commit that changed the value and that flush there is a window in which
// the tree on screen is the new one and the ref still holds the previous render's
// value. `useLayoutEffect` runs synchronously before paint, so the ref is current the
// moment the tree that produced it is, and "never a render behind" is a property of
// this hook rather than of what a browser happens to schedule. The write is one
// assignment, so the synchronous phase costs nothing.
//
// A REF IS NOT A SUBSCRIPTION. Nothing re-renders when this changes, which is exactly
// what a caller wants for a value it reads at invoke time and exactly wrong for one it
// renders. A value that decides what is on screen belongs in state or in a store.

import { useLayoutEffect, useRef } from "react";

/**
 * Hold `value` in a ref that every committed render refreshes.
 *
 * Read `.current` at invoke time, never at build time: reading it while composing a
 * callback captures the value this render happened to see and gives up everything the
 * hook is for.
 */
export function useLatestRef<TValue>(value: TValue): React.RefObject<TValue> {
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  }, [value]);
  return latest;
}
