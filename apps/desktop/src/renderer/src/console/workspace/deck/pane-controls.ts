// What a pane body may ask its host to do — and the reason it is a context.
//
// `Spec-023 §Console Design (Meridian)` §4.2 puts close and open-in-window on the
// pane HEADER, and §4.5 makes both of them the DECK's acts: the deck owns which
// panes exist and in which window. But a pane body is mounted through
// `workspace/seats/pane-registry.ts`, whose `render(context)` takes a
// `ConsolePaneContext` and nothing else — that contract is shared by six view
// families and widening it to carry two callbacks would be six branches changing
// one merged file.
//
// So the controls travel as REACT CONTEXT, provided by the deck around each pane
// body and read by `PaneHeader`. Three properties follow, and each is the reason:
//
//   • A pane rendered OUTSIDE a deck — the auxiliary timeline window, the
//     full-width surface with no deck at all — reads an absent context and offers
//     no controls. That is the absent-not-disabled rule the shipped timeline pane
//     already states: a control whose act nobody can perform is left out, never
//     drawn greyed.
//   • The deck stays the single source of truth for pane lifetime. A body cannot
//     close itself except by asking.
//   • The seam is one module below both `Deck.tsx` and `PaneHeader.tsx`, so
//     neither imports the other and the layering gate's cycle rule is satisfied by
//     construction rather than by care.
//
// The value is deliberately per PANE, not per deck: the header needs the acts for
// the pane it heads, and handing it a deck-wide object plus an id would make every
// header re-derive which pane it belongs to.

import { createContext, useContext } from "react";

/** The acts a host can perform on the pane a header heads. */
export interface PaneControls {
  /** Close this pane. Absent where the host cannot close panes. */
  readonly onClose?: () => void;
  /** Move this pane into a window of its own (§4.5). Absent where the kind or the
   * host does not permit it — the kind's `openInWindow` is the deck's own test. */
  readonly onOpenInWindow?: () => void;
  /**
   * Make the header the handle that drags this pane to a new position.
   *
   * A ref callback rather than a boolean, because the drag adapter binds to an
   * ELEMENT: the deck knows which pane the header heads and the header knows which
   * element it rendered, and neither can supply the other's half. Absent where the
   * host does not reorder panes — the auxiliary window, where there is one pane and
   * nowhere to drag it — which leaves the header undraggable rather than draggable
   * into a drop nothing would accept.
   */
  readonly registerDragHandle?: (element: HTMLElement | null) => void;
}

/**
 * The seam. `undefined` — not an empty object — where no host is mounted.
 *
 * The distinction is load-bearing: an empty object means "a host is here and offers
 * nothing", which no host does, while `undefined` means "there is no host", which
 * is exactly the auxiliary window's situation. Collapsing them would leave the two
 * cases indistinguishable at the one place the difference decides what renders.
 */
export const PaneControlsContext: React.Context<PaneControls | undefined> = createContext<
  PaneControls | undefined
>(undefined);

/** The host's acts for the pane this component is inside, or `undefined`. */
export function usePaneControls(): PaneControls | undefined {
  return useContext(PaneControlsContext);
}
