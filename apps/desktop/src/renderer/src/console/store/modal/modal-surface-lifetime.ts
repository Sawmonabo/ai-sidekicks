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
//
// AND THE STORE IS SPLIT OFF THE HOOK, because one caller cannot reach it. The window
// overlay seat hands its body ACTS and never the window's store, so the deep-link
// invite card — which is `modal="trap-focus"` like the other two and left the
// background live exactly as the walkthrough did — has no `FrameStore` to pass. The
// register's own two operations therefore travel as ONE act, `ModalSurfaceClaimAct`,
// with the hook that owns the two easy-to-omit halves taking the act rather than the
// store. `useModalSurfaceLifetime` is that same hook bound to a store, so a surface
// that can reach one keeps the shorter call and there is one implementation of the
// effect rather than two.

import { useEffect, useId, useMemo } from "react";

import type { FrameStore } from "../frame-store.js";

/**
 * Take or give up ONE claimant's claim on the window's modal surface.
 *
 * A function and not the register, so a body the frame seats can be handed what it may
 * do without being handed the window it may do it to. The claim id is the caller's
 * because the register is keyed on it; `useModalSurfaceClaim` is what mints one, and no
 * caller writes an id of its own.
 */
export type ModalSurfaceClaimAct = (claimId: string, isHeld: boolean) => void;

/**
 * Bind the claim act to one window's register.
 *
 * A composed act's IDENTITY is load-bearing — {@link useModalSurfaceClaim} depends on
 * it, so an act rebuilt on every render would release and re-hold on every pass and
 * publish a change each time. Every caller composes it once, under the same `useMemo`
 * the frame already gives `sessionOpenerFor`.
 */
export function modalSurfaceClaimFor(frameStore: FrameStore): ModalSurfaceClaimAct {
  return (claimId, isHeld) => {
    const claims = frameStore.modalSurfaceClaims;
    if (isHeld) {
      claims.hold(claimId);
    } else {
      claims.release(claimId);
    }
  };
}

/**
 * Publish a window-scoped dialog's open state through a claim act.
 *
 * The caller passes the same boolean its `Dialog.Root` takes as `open`, so the two
 * cannot disagree: there is no second condition here to keep in step. The signature
 * carries no claim id — the hook mints its own, because an id a caller supplied could
 * be supplied twice and two surfaces would then be one claimant.
 */
export function useModalSurfaceClaim(claim: ModalSurfaceClaimAct, isOpen: boolean): void {
  const claimId = useId();
  useEffect(() => {
    claim(claimId, isOpen);
    return () => {
      claim(claimId, false);
    };
  }, [claim, claimId, isOpen]);
}

/**
 * The same publish, for a surface that already holds the window's store.
 *
 * The two overlays that reach a `FrameStore` through `ConsoleSurfaceContext` keep this
 * call rather than composing an act each: what they have is the store, and a hook that
 * made them bind it themselves would be the seam's producer written at every site.
 */
export function useModalSurfaceLifetime(frameStore: FrameStore, isOpen: boolean): void {
  const claim = useMemo(() => modalSurfaceClaimFor(frameStore), [frameStore]);
  useModalSurfaceClaim(claim, isOpen);
}
