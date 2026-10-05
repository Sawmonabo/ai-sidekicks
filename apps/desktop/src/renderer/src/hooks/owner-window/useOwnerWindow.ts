// Which window a component is drawn in. Every window a person sees renders from one document's
// tree through a portal, so the global `window` and `document` are the hidden document's, never
// the one a component is in; a listener, a focus check or a portal target reads this instead.

import { createContext, useContext, type Context } from "react";

/** The window the tree below is drawn in; `undefined` outside any, where the global is it. */
export const OwnerWindowContext: Context<Window | undefined> = createContext<Window | undefined>(
  undefined,
);

/**
 * The window this component is drawn in: the one the app opened it into, or the global window for
 * a tree mounted straight into a document.
 */
export function useOwnerWindow(): Window {
  return useContext(OwnerWindowContext) ?? window;
}
