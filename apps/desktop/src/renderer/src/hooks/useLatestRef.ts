// The latest committed value, readable from a callback that outlives the render.
//
// A palette command, a registered chord or a dispatch handed to a store is built once and
// invoked later, so it cannot close over the render's props; a ref the callback reads at
// invoke time answers that.
//
// The ref is written in a layout effect, not the render body. A concurrent render that is
// thrown away has already run every component body in it, so a render-body assignment would
// mutate state the committed tree keeps, and the command on screen would invoke the
// discarded render's callbacks. Layout rather than passive: a passive effect flushes after
// paint, leaving a window where the tree on screen is new and the ref holds the previous
// value.
//
// A ref is not a subscription: nothing re-renders when it changes. A value that decides what
// is on screen belongs in state or a store.

import { useLayoutEffect, useRef } from "react";

/**
 * Hold `value` in a ref that every committed render refreshes.
 *
 * Read `.current` at invoke time, never at build time, or the callback captures the value
 * this render happened to see.
 */
export function useLatestRef<TValue>(value: TValue): React.RefObject<TValue> {
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  }, [value]);
  return latest;
}
