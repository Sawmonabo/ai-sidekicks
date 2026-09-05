// What a pane may ask its host to do — and the reason it is a context.
//
// `ConsolePaneChrome.tsx` puts close and open-in-window on the pane's head, and both
// are the HOST's acts: the deck owns which panes exist and — for the auxiliary
// windows `Spec-023 §The surface set` names — in which window. But a pane body is
// mounted through `pane-registry.ts`, whose `render(context)` takes a
// `ConsolePaneContext` and nothing else — that contract is shared by six view
// families and widening it to carry two callbacks would be six branches changing one
// merged file.
//
// So the controls travel as REACT CONTEXT, provided by the deck around each pane body
// and read by the chrome. Three properties follow, and each is the reason:
//
//   • A pane rendered OUTSIDE a deck — the auxiliary timeline window, a full-width
//     surface with no deck at all — reads an absent context and offers no controls.
//     That is the absent-not-disabled rule `src/shared/auxiliary-routes.ts` applies
//     to the Window menu: a control whose act nobody can perform is left out, never
//     drawn greyed.
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

/**
 * How large a glyph in a pane's own chrome is drawn, in CSS pixels.
 *
 * Here rather than in either module that draws one: the head's controls and the
 * breadcrumb's separators are one chrome at one size, and a second copy is a second
 * answer waiting to drift. The kind glyph is deliberately NOT this size — it sits
 * beside a 600-weight heading and is set where it is drawn.
 */
export const PANE_CONTROL_GLYPH_SIZE = 14;

/** The acts a host can perform on the pane its chrome frames. */
export interface PaneControls {
  /** Close this pane. Absent where the host cannot close panes. */
  readonly onClose?: () => void;
  /**
   * Move this pane into a window of its own (`Spec-023 §The surface set`).
   *
   * Absent where the kind or the host does not permit it — `isDetachablePaneKind`
   * answers the kind's half, and the host's is whether it supplied a handler.
   */
  readonly onOpenInWindow?: () => void;
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
 * nothing", which no host does, while `undefined` means "there is no host", which is
 * exactly the auxiliary window's situation. Collapsing them would leave the two cases
 * indistinguishable at the one place the difference decides what renders.
 */
export const PaneControlsContext: React.Context<PaneControls | undefined> = createContext<
  PaneControls | undefined
>(undefined);

/** The host's acts for the pane this component is inside, or `undefined`. */
export function usePaneControls(): PaneControls | undefined {
  return useContext(PaneControlsContext);
}
