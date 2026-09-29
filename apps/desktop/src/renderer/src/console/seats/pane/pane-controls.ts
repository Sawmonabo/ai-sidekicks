// What a pane may ask its host to do — and the reason it is a context.
//
// `ConsolePaneChrome.tsx` puts close on the pane's head, and it is the HOST's act: the
// deck owns which panes exist. But a pane body is mounted through `pane-registry.ts`,
// whose `render(context)` takes a `ConsolePaneContext` and nothing else — that contract
// is shared by six view families and widening it to carry callbacks would be six
// branches changing one merged file.
//
// So the controls travel as REACT CONTEXT, provided by the deck around each pane body
// and read by the chrome. Three properties follow, and each is the reason:
//
//   • A pane rendered OUTSIDE a deck — a full-width surface with no deck at all —
//     reads an absent context and offers no controls: a control whose act nobody can
//     perform is left out, never drawn greyed.
//   • The deck stays the single source of truth for pane lifetime. A body cannot
//     close itself except by asking.
//   • The seam is one module below both the deck and the chrome, so neither imports
//     the other and the layering gate's cycle rule is satisfied by construction
//     rather than by care.
//
// The value is deliberately per PANE, not per deck: the chrome needs the acts for the
// pane it frames, and handing it a deck-wide object plus an id would make every pane
// re-derive which one it is.
//
// WHY IT SITS IN `seats/` AND NOT IN THE DECK THAT PROVIDES IT. The deck is a view
// family, the six pane-body families are its siblings, and a sibling may not import a
// sibling. A context the deck provides and six families' chrome reads is exactly the
// contract shape this family exists to hold.

import { createContext, useContext } from "react";

import { type ConsolePaneOpener } from "@renderer/routing/panes/pane-address.js";

// NO GLYPH SIZE IS DECLARED HERE. The head's controls and the breadcrumb's
// separators are one chrome at one size, and that size is `GLYPH_SIZE_CHROME` in
// `tokens/glyphs.ts` — a console-wide token rather than a per-family constant,
// because the same mark drawn in another family's chrome has to match this one and
// two constants agree only while someone keeps them in step. The kind glyph is
// deliberately NOT that size: it takes `GLYPH_DEFAULT_SIZE` from the same module.

/** The acts a host can perform on the pane its chrome frames. */
export interface PaneControls {
  /** Close this pane. Absent where the host cannot close panes. */
  readonly onClose?: () => void;
  /**
   * Open another pane in this pane's deck.
   *
   * Not a control on the head — no pane's chrome draws a button for it — but a host
   * act like the close above, and here for the same reason it is: the deck owns
   * which panes exist, and a body reaching for a process-wide opener would open its
   * route in whichever deck was composed last. `ConsolePaneChrome` forwards it to the
   * pinned region it draws, which is the surface that has a route to offer and no way
   * of its own to take it.
   *
   * Absent where the host opens no panes, which leaves the region stating where its
   * subject lives rather than drawing a control that could not act.
   */
  readonly openPane?: ConsolePaneOpener;
  /**
   * Make the pane's head the handle that drags it to a new position.
   *
   * A ref callback rather than a boolean, because the drag adapter binds to an
   * ELEMENT: the deck knows which pane the head belongs to and the chrome knows which
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
 * full-width surface with no deck. Collapsing them would leave the two cases
 * indistinguishable at the one place the difference decides what renders.
 */
export const PaneControlsContext: React.Context<PaneControls | undefined> = createContext<
  PaneControls | undefined
>(undefined);

/** The host's acts for the pane this component is inside, or `undefined`. */
export function usePaneControls(): PaneControls | undefined {
  return useContext(PaneControlsContext);
}
