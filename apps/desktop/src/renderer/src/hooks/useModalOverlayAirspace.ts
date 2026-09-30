// What a modal overlay puts in the window's airspace: the backdrop as well as the popup.
//
// A modal covers the window with a fixed, full-viewport backdrop. The visibility predicate a
// native view yields to (`features/preview/geometry/pane-geometry.ts`) hides a view only
// where a registered rectangle overlaps the pane, so registering only the popup left a pane
// the dialog did not cross painting over the backdrop and taking its input, including the
// backdrop press that dismisses the dialog. The backdrop's rectangle is the suppression,
// because it is the whole window.
//
// `OverlayDialogPopup` and `OverlayAlertDialogPopup` share this one decision about which
// parts of a modal are airspace.
//
// The popup is still registered: Base UI renders a dialog's backdrop only where the dialog
// is not nested (`DialogBackdrop`'s `enabled: forceRender || !nested`, checked against the
// installed 1.7.0), so a nested dialog draws none. Registering the backdrop alone would leave
// that dialog in no airspace, which fails open. The extra rectangle costs one more entry in
// a set the predicate scans.
//
// Non-modal kinds (a menu, a select, a combobox) do not come here: they are anchored boxes,
// and a popup claiming the whole window would suppress every native view for the length of a
// menu press.

import { useAirspaceRegistration, type AirspaceOverlayRef } from "./useAirspaceRegistration.js";
import type { AirspaceOverlayKind } from "@renderer/lib/airspace-registry.js";

/**
 * The two refs a modal wrapper attaches, one per part that occupies the window.
 *
 * Each registration travels with the element it is put on, so the only thing a wrapper can
 * get wrong is failing to attach one.
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
 * Both carry the same kind: `AIRSPACE_OVERLAY_KINDS` names what a thing is on screen, and a
 * backdrop is the half of one dialog that covers the window.
 */
export function useModalOverlayAirspace(kind: AirspaceOverlayKind): ModalOverlayAirspace {
  const backdropRef = useAirspaceRegistration(kind);
  const popupRef = useAirspaceRegistration(kind);
  return { backdropRef, popupRef };
}
