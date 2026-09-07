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
// UNCONDITIONAL RATHER THAN UNDER AN `if (isOpen)`, so the claim this hook owns is
// always exactly its caller's own open state; the cleanup covers a close and an
// unmount alike, and a release of a claim already given up costs nothing. A render
// React discards mid-ceremony must not leave a window inert with nothing on screen to
// close.
//
// AND IT SPEAKS ONLY FOR ITS OWN CALLER, which is what the claim id buys. The two
// window-scoped overlays can be up at once — the sign-in card while the palette runs
// the onboarding command — and while this hook published a single boolean, the first
// of them to close cleared the guard under the one still open and left the background
// structurally reachable behind a `trap-focus` dialog. `modal-surface-claims.ts` holds
// the register; every mount takes an id from `useId`, so two mounts of ONE component
// are two claimants and a remount is a fresh one.
//
// IT PUBLISHES AND DOES NOT DECIDE. Whether the dialog is `modal="trap-focus"` is the
// caller's own JSX, and `test/console/architecture/dialog-modal-mode.test.ts` is what
// holds every `Dialog.Root` under `console/` to it — a hook cannot state a prop for a
// component it does not render, and a hook that returned one would be read as though
// it had.

import { useEffect, useId } from "react";

import type { FrameStore } from "../frame-store.js";

/**
 * Publish a window-scoped dialog's open state for the shell's `inert` guard.
 *
 * The caller passes the same boolean its `Dialog.Root` takes as `open`, so the two
 * cannot disagree: there is no second condition here to keep in step. The signature
 * carries no claim id — the hook mints its own, because an id a caller supplied could
 * be supplied twice and two surfaces would then be one claimant.
 */
export function useModalSurfaceLifetime(frameStore: FrameStore, isOpen: boolean): void {
  const claimId = useId();
  useEffect(() => {
    const claims = frameStore.modalSurfaceClaims;
    if (isOpen) {
      claims.hold(claimId);
    } else {
      claims.release(claimId);
    }
    return () => {
      claims.release(claimId);
    };
  }, [claimId, frameStore, isOpen]);
}
