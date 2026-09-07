// A family-owned modal telling the frame it is up, for exactly as long as it is up.
//
// THE FRAME CANNOT SEE IT. `Spec-023 §Console Libraries` adopts the dialog family
// under `modal="trap-focus"`, which traps focus and leaves inerting the app root to
// the shell — so a reader following the accessibility tree is handled and one
// navigating by STRUCTURE is not: the rail and the whole route surface stay reachable
// underneath. The shell has the guard — `AppFrame`'s `modalOverlayOpen`, which hangs
// `inert` on the background — and cannot arm it for a view family's card, because
// `console-view-family-isolation` forbids `frame/` from naming one. So the card
// publishes into the WINDOW store and the frame folds it with the palette's own state.
//
// HOISTED ON THE SECOND USE, which is this module's whole reason to exist. Two
// window-scoped overlays now hold this wiring — the sign-in card and the onboarding
// walkthrough — and the second one was written without it, so the walkthrough trapped
// focus and left the background live for anyone moving through the document. The rule
// has two halves that are easy to write and easy to write only one of: publish `true`
// while the card is up, and publish `false` on BOTH endings.
//
// UNCONDITIONAL RATHER THAN UNDER AN `if (isOpen)`, so the cell this hook owns is
// always exactly its caller's own open state; the cleanup covers a close and an
// unmount alike, and the store's own comparison makes a repeated `false` cost nothing.
// A render React discards mid-ceremony must not leave a window inert with nothing on
// screen to close.
//
// IT PUBLISHES AND DOES NOT DECIDE. Whether the dialog is `modal="trap-focus"` is the
// caller's own JSX, and `test/console/architecture/dialog-modal-mode.test.ts` is what
// holds every `Dialog.Root` under `console/` to it — a hook cannot state a prop for a
// component it does not render, and a hook that returned one would be read as though
// it had.

import { useEffect } from "react";

import type { FrameStore } from "./frame-store.js";

/**
 * Publish a window-scoped dialog's open state for the shell's `inert` guard.
 *
 * The caller passes the same boolean its `Dialog.Root` takes as `open`, so the two
 * cannot disagree: there is no second condition here to keep in step.
 */
export function useModalSurfaceLifetime(frameStore: FrameStore, isOpen: boolean): void {
  useEffect(() => {
    frameStore.setModalSurfaceOpen(isOpen);
    return () => {
      frameStore.setModalSurfaceOpen(false);
    };
  }, [frameStore, isOpen]);
}
