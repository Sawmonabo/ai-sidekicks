// What a pane may ask its host to do, carried as React context.
//
// Close is the host's act, since the pane layout owns which panes exist. `pane-registry.ts`'s
// `render(context)` takes only a `PaneContext`, shared by every feature, so callbacks travel as
// context provided around each pane body and read by the chrome. A pane outside a pane layout
// reads an absent context and offers no controls, and the seam sits below both the pane layout
// and the chrome, which keeps them from importing each other. It lives in `components/` because
// one feature never imports another. The value is per pane, so a pane need not find itself.

import { createContext } from "react";

import { type PaneOpener } from "@renderer/routing/panes/pane-address.js";

/** The acts a host can perform on the pane its chrome frames. */
export interface PaneControls {
  /** Close this pane. Absent where the host cannot close panes. */
  readonly onClose?: () => void;
  /** Opens another pane in this pane's pane layout; absent where the host opens no panes. */
  readonly openPane?: PaneOpener;
  /**
   * A ref callback that makes the pane's head the grip its pane is dragged by: the pane layout's
   * reorder binds to an element, which only the chrome has. Absent where the host does not
   * reorder panes.
   */
  readonly registerDragHandle?: (element: HTMLElement | null) => void;
}

/** The seam. `undefined`, not an empty object, means no host is mounted. */
export const PaneControlsContext: React.Context<PaneControls | undefined> = createContext<
  PaneControls | undefined
>(undefined);
