// Which window a tree is drawn in. Every window a person sees renders from one document's tree
// through a portal, so the global `window` and `document` are the hidden document's, never the
// one a component is in; everything under this provider reads its own through `useOwnerWindow`.

import type { ReactNode } from "react";

import { OwnerWindowContext } from "./context.js";

/** The window a tree is drawn in, and the tree. */
export interface OwnerWindowProviderProps {
  readonly window: Window;
  readonly children: ReactNode;
}

/** Names the window the tree below is drawn in. */
export function OwnerWindowProvider(props: OwnerWindowProviderProps): React.JSX.Element {
  return (
    <OwnerWindowContext.Provider value={props.window}>{props.children}</OwnerWindowContext.Provider>
  );
}
