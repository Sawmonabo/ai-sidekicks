// The frame's `inert` guard, driven through the hook two real overlays use.
//
// `modal-surface-claims.test.ts` asserts the register's arithmetic. What is asserted
// here is the wiring a surface actually gets: that one mount is one claimant, that a
// close and an unmount both give up that claimant's claim and nobody else's, and that
// the cell the frame reads follows the register rather than the last caller.
//
// THE OVERLAP IS THE POINT. Both cases below mount two surfaces in ONE tree, because
// that is the window the defect lived in — the sign-in card open while the palette
// runs the onboarding command — and a case mounting one surface would have passed
// against the boolean this replaced. The single-surface case at the end is the
// control: it is the one that must still publish `false`, and without it a hook that
// never released anything would satisfy the first two.

import { render } from "@testing-library/react";
import { type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { FrameStore } from "../frame-store.js";
import { useModalSurfaceLifetime } from "./modal-surface-lifetime.js";

interface ModalSurfaceProbeProps {
  readonly frameStore: FrameStore;
  /** The same boolean the surface's own `Dialog.Root` would take as `open`. */
  readonly isOpen: boolean;
  readonly surfaceName: string;
}

/** A window-scoped overlay, reduced to the one thing this suite is about. */
function ModalSurfaceProbe({
  frameStore,
  isOpen,
  surfaceName,
}: ModalSurfaceProbeProps): ReactElement {
  useModalSurfaceLifetime(frameStore, isOpen);
  return <span data-testid={surfaceName}>{isOpen ? "open" : "closed"}</span>;
}

/** Whether the frame would hang `inert` on the background right now. */
function backgroundIsInert(frameStore: FrameStore): boolean {
  return frameStore.readable.getState().isModalSurfaceOpen;
}

describe("a modal surface's lifetime — one claim per mounted surface", () => {
  it("holds the guard while a second overlay is still open", () => {
    const frameStore = new FrameStore();
    const overlays = (isWalkthroughOpen: boolean): ReactElement => (
      <>
        <ModalSurfaceProbe frameStore={frameStore} isOpen surfaceName="sign-in" />
        <ModalSurfaceProbe
          frameStore={frameStore}
          isOpen={isWalkthroughOpen}
          surfaceName="walkthrough"
        />
      </>
    );
    const { rerender } = render(overlays(true));

    expect(backgroundIsInert(frameStore)).toBe(true);
    expect(frameStore.modalSurfaceClaims.heldClaimCount).toBe(2);

    rerender(overlays(false));

    // The sign-in card is still up and still trapping focus. A `false` here is the
    // whole defect: focus stays caught while the rail and the route surface behind
    // the card become reachable to anyone navigating by structure.
    expect(backgroundIsInert(frameStore)).toBe(true);
    expect(frameStore.modalSurfaceClaims.heldClaimCount).toBe(1);
  });

  it("holds it when one of two overlays is torn down rather than closed", () => {
    // The other ending, and the one a render React discards mid-ceremony takes. The
    // cleanup has to give up the unmounting surface's claim and no other.
    const frameStore = new FrameStore();
    const overlays = (isWalkthroughMounted: boolean): ReactElement => (
      <>
        <ModalSurfaceProbe frameStore={frameStore} isOpen surfaceName="sign-in" />
        {isWalkthroughMounted ? (
          <ModalSurfaceProbe frameStore={frameStore} isOpen surfaceName="walkthrough" />
        ) : null}
      </>
    );
    const { rerender } = render(overlays(true));

    expect(frameStore.modalSurfaceClaims.heldClaimCount).toBe(2);

    rerender(overlays(false));

    expect(backgroundIsInert(frameStore)).toBe(true);
    expect(frameStore.modalSurfaceClaims.heldClaimCount).toBe(1);
  });

  it("control: the last overlay to close releases the guard", () => {
    // Which is what makes the two cases above claims about the OTHER surface's claim
    // rather than about a guard that is never given up at all.
    const frameStore = new FrameStore();
    const { rerender, unmount } = render(
      <ModalSurfaceProbe frameStore={frameStore} isOpen surfaceName="sign-in" />,
    );

    expect(backgroundIsInert(frameStore)).toBe(true);

    rerender(<ModalSurfaceProbe frameStore={frameStore} isOpen={false} surfaceName="sign-in" />);
    expect(backgroundIsInert(frameStore)).toBe(false);

    unmount();
    expect(frameStore.modalSurfaceClaims.heldClaimCount).toBe(0);
  });
});
