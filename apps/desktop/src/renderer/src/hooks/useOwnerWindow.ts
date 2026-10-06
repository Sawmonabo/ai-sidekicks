// The window a component is drawn in, for a listener, a focus check or a portal target, which
// must read it here rather than from the global `window` and `document`.

import { useContext } from "react";

import { OwnerWindowContext } from "#renderer/components/OwnerWindow/context.js";

/**
 * The window this component is drawn in: the one the app opened it into, or the global window for
 * a tree mounted straight into a document.
 */
export function useOwnerWindow(): Window {
  return useContext(OwnerWindowContext) ?? window;
}
