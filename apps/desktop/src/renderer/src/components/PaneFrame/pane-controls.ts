// What a pane may ask its host to do — and the reason it is a context.
//
// `PaneFrame.tsx` puts close on the pane's head, and it is the HOST's act: the
// pane layout owns which panes exist. But a pane body is mounted through `pane-registry.ts`,
// whose `render(context)` takes a `PaneContext` and nothing else — that contract
// is shared by six features and widening it to carry callbacks would be six
// branches changing one merged file.
//
// So the controls travel as REACT CONTEXT, provided by the pane layout around each pane body
// and read by the chrome. Three properties follow, and each is the reason:
//
//   • A pane rendered OUTSIDE a pane layout — a full-width view with no pane layout at all —
//     reads an absent context and offers no controls: a control whose act nobody can
//     perform is left out, never drawn greyed.
//   • The pane layout stays the single source of truth for pane lifetime. A body cannot
//     close itself except by asking.
//   • The seam is one module below both the pane layout and the chrome, so neither imports
//     the other and the layering gate's cycle rule is satisfied by construction
//     rather than by care.
//
// The value is deliberately per PANE, not per pane layout: the chrome needs the acts for the
// pane it frames, and handing it a layout-wide object plus an id would make every pane
// re-derive which one it is.
//
// WHY IT SITS IN `components/` AND NOT IN THE PANE LAYOUT THAT PROVIDES IT. The pane layout
// belongs to the sessions feature, the pane bodies belong to their own features, and one
// feature never imports another. A context the pane layout provides and every pane's
// chrome reads therefore lives in the shared components below all of them.

import { createContext } from "react";

import { type PaneOpener } from "@renderer/routing/panes/pane-address.js";
// NO GLYPH SIZE IS DECLARED HERE. The head's controls and the breadcrumb's
// separators are one chrome at one size, and that size is `GLYPH_SIZE_CHROME` in
// `styles/glyphs.ts` — a console-wide token rather than a per-feature constant,
// because the same mark drawn in another feature's chrome has to match this one and
// two constants agree only while someone keeps them in step. The kind glyph is
// deliberately NOT that size: it takes `GLYPH_DEFAULT_SIZE` from the same module.

/** The acts a host can perform on the pane its chrome frames. */
export interface PaneControls {
  /** Close this pane. Absent where the host cannot close panes. */
  readonly onClose?: () => void;
  /**
   * Open another pane in this pane's pane layout.
   *
   * Not a control on the head — no pane's chrome draws a button for it — but a host
   * act like the close above, and here for the same reason it is: the pane layout owns
   * which panes exist, and a body reaching for a process-wide opener would open its
   * route in whichever pane layout was composed last. `PaneFrame` forwards it to the
   * pinned region it draws, which is the region that has a route to offer and no way
   * of its own to take it.
   *
   * Absent where the host opens no panes, which leaves the region stating where its
   * subject lives rather than drawing a control that could not act.
   */
  readonly openPane?: PaneOpener;
  /**
   * Make the pane's head the handle that drags it to a new position.
   *
   * A ref callback rather than a boolean, because the drag adapter binds to an
   * ELEMENT: the pane layout knows which pane the head belongs to and the chrome knows which
   * element it rendered, and neither can supply the other's half. Absent where the
   * host does not reorder panes — the auxiliary window, where there is one pane and
   * nowhere to drag it — which leaves the head undraggable rather than draggable into
   * a drop nothing would accept.
   */
  readonly registerDragHandle?: (element: HTMLElement | null) => void;
}

/**
 * The seam. `undefined` — not an empty object — where no host is mounted.
 *
 * The distinction is load-bearing: an empty object means "a host is here and offers
 * nothing", which no host does, while `undefined` means "there is no host", as for a
 * full-width view with no pane layout. Collapsing them would leave the two cases
 * indistinguishable at the one place the difference decides what renders.
 */
export const PaneControlsContext: React.Context<PaneControls | undefined> = createContext<
  PaneControls | undefined
>(undefined);
