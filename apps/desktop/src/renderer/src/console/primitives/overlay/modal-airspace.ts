// What a MODAL overlay puts in the window's airspace: the backdrop as well as the
// popup.
//
// THE HAZARD THIS ANSWERS. A modal covers the window with a fixed, full-viewport
// backdrop, and registering only the popup left that cover invisible to the airspace.
// The visibility predicate a native view yields to (`browser/geometry/pane-geometry.ts`)
// hides a view only where a registered rectangle OVERLAPS the pane, so a pane whose
// box the dialog did not cross went on painting a live web page over the backdrop and
// went on taking its input — including the backdrop press that dismisses the dialog.
// The registry has no "suppress every native view" arm and does not need one: the
// backdrop's own rectangle IS that suppression, because it is the whole window.
//
// ONE OWNER FOR BOTH WRAPPERS. `OverlayDialogPopup` and `OverlayAlertDialogPopup` are
// separate primitives for a reason the first of them records, but WHICH parts of a
// modal are airspace is one decision and it is made here — two copies of it would
// agree until the day one of them grew a part and the other did not.
//
// AND THE POPUP IS STILL REGISTERED, which is not redundancy. Base UI renders a
// dialog's backdrop only where the dialog is not NESTED (`DialogBackdrop`'s own
// `enabled: forceRender || !nested`, measured against the installed 1.7.0), so a
// dialog opened inside another draws no backdrop at all. Registering the backdrop
// alone would put that dialog in no airspace whatever — the fail-OPEN direction, and
// the exact defect this module exists to close. Two rectangles where one modal is on
// screen costs one more entry in a set the predicate scans; a modal in no airspace
// costs a native view painted over it.
//
// NON-MODAL FAMILIES DO NOT COME HERE. A menu, a select, and a combobox
// are anchored boxes that cover what they cover, and a popup that claimed the whole
// window would suppress every native view in it for the length of a menu press.

import { useAirspaceRegistration, type AirspaceOverlayRef } from "../airspace-registration.js";
import type { AirspaceOverlayKind } from "../../core/index.js";

/**
 * The two refs a modal wrapper attaches — one per part that occupies the window.
 *
 * Refs and not a hook result to wire up further, on {@link AirspaceOverlayRef}'s own
 * reasoning: each registration travels with the element it is put on, so the only
 * thing a wrapper can get wrong is failing to attach one, and the architecture gate
 * is what catches that.
 */
export interface ModalOverlayAirspace {
  /** Goes on the backdrop: the full-viewport cover, live-read like any other box. */
  readonly backdropRef: AirspaceOverlayRef;
  /** Goes on the popup, and stands alone where a nested modal renders no backdrop. */
  readonly popupRef: AirspaceOverlayRef;
}

/**
 * Register a modal's backdrop and popup as airspace of `kind`, for its lifetime.
 *
 * Both registrations carry the same kind, because 12.3's enumeration names what a
 * thing IS on screen and both of these are parts of one dialog — a backdrop is not a
 * second kind of overlay, it is the half of this one that covers the window.
 */
export function useModalOverlayAirspace(kind: AirspaceOverlayKind): ModalOverlayAirspace {
  const backdropRef = useAirspaceRegistration(kind);
  const popupRef = useAirspaceRegistration(kind);
  return { backdropRef, popupRef };
}
