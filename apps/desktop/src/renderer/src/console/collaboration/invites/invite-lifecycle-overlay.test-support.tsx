// The mount every case that drives the window's invite lifecycle takes, and the press.
//
// HOISTED ON THE SECOND USE, which is what this module is for. Two suites drive one
// overlay over two subjects — `InviteLifecycleOverlay.test.tsx` asserts what each entry
// point dispatches and where the window goes, and `InviteLifecycleOverlay.modal-
// surface.test.tsx` asserts the shell's `inert` guard, which renders nothing and is
// visible only in the frame store's own cell. A second copy of the mount would be a
// second answer to WHAT THE SEAT HANDS THIS BODY, and the props it is handed are
// exactly what both files are about.
//
// THE MOUNT COMPOSES THE CLAIM ACT ONCE, the same way `ConsoleFrame` does: the act's
// identity is what the body's effect depends on, so one rebuilt per render would
// release and re-hold on every pass. It is composed here rather than in a case because
// this is where the props are, and a case composing its own would be the seam written
// twice over.

import { act, render } from "@testing-library/react";
import { vi } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { FrameStore, modalSurfaceClaimFor } from "../../store/index.js";
import { inviteConfirmationMount } from "./invite-confirmation-mount.js";
import { InviteLifecycleOverlay } from "./InviteLifecycleOverlay.js";
import { scenarioWithArrivals } from "./pending-invite.test-support.js";

/** What one mount of the overlay hands back to a case. */
export interface MountedOverlay {
  readonly body: HTMLElement;
  readonly openSession: ReturnType<typeof vi.fn>;
  /**
   * The window this mount was seated in.
   *
   * A real `FrameStore` rather than a spy on the claim act, because what the card owes
   * the shell is the CELL the frame hangs `inert` on — and a spy would pass over an act
   * that was called and published nothing.
   */
  readonly frameStore: FrameStore;
  /** Tear the overlay down, which is the other way its card can end. */
  readonly unmount: () => void;
}

/**
 * Mount the overlay over a scripted arrival, with no session anywhere in the tree.
 *
 * The bridge is the only READ it is given, which is the claim: this lifecycle is
 * bridge-scoped, so a window that has opened nothing still receives what arrives.
 */
export async function mountOverlay(bridge?: ConsoleBridge): Promise<MountedOverlay> {
  const openSession = vi.fn();
  const frameStore = new FrameStore();
  const resolved = bridge ?? createFixtureBridge({ scenario: scenarioWithArrivals() });
  const { container, unmount } = render(
    <InviteLifecycleOverlay
      bridge={resolved}
      openSession={openSession}
      claimModalSurface={modalSurfaceClaimFor(frameStore)}
    />,
  );
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  // The card arrives on its own chunk, so a mount that has a prompt draws the reserved
  // region until it lands. Resolved through the MOUNT the overlay itself renders — one
  // home for the wait rather than a per-spec race — and then one more boundary for React
  // to commit the settled body. Asked unconditionally: a case that drives an arrival in
  // later still finds the memo warm, and one that never opens a card pays a resolved
  // promise.
  await act(async () => {
    await inviteConfirmationMount.load();
    await crossMacrotaskBoundary();
  });
  return { body: container.ownerDocument.body, openSession, frameStore, unmount };
}

/** Press one control by the class it carries, letting whatever it dispatched settle. */
export async function press(root: HTMLElement, className: string): Promise<void> {
  const found = root.querySelector<HTMLButtonElement>(`.${className}`);
  if (found === null) {
    throw new Error(`no ${className}`);
  }
  await act(async () => {
    found.click();
    await crossMacrotaskBoundary();
  });
}

/**
 * Close the card the way the keyboard does, letting whatever it dispatched settle.
 *
 * Hoisted on the second use, with the backdrop below it. Two suites drive the three
 * close paths — which act each entry point reaches, and what a close does to a
 * reference main is still holding — and these two are the event sequences the dialog
 * library listens for rather than anything either suite owns. A second copy is two
 * files disagreeing about what "the backdrop was pressed" means, and the one that gets
 * it wrong closes nothing and then asserts an absence.
 */
export async function closeThroughEscape(root: HTMLElement): Promise<void> {
  const popup = openCard(root);
  await act(async () => {
    popup.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await crossMacrotaskBoundary();
  });
}

/** Close the card the way a press outside it does, letting that settle. */
export async function closeThroughBackdrop(root: HTMLElement): Promise<void> {
  openCard(root);
  const backdrop = root.querySelector(".meridian-invite-confirmation__backdrop");
  if (backdrop === null) {
    throw new Error("the open card has no backdrop");
  }
  await act(async () => {
    backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await crossMacrotaskBoundary();
  });
}

/**
 * The open card's own element, or a thrown explanation of why there is none.
 *
 * Both library-driven closes below address it, and a fallback to the document body
 * would send an Escape somewhere Base UI is not listening and read a card that never
 * opened as a card that declined to close.
 */
function openCard(root: HTMLElement): Element {
  const popup = root.querySelector(".meridian-invite-confirmation");
  if (popup === null) {
    throw new Error("no confirmation card is open");
  }
  return popup;
}
