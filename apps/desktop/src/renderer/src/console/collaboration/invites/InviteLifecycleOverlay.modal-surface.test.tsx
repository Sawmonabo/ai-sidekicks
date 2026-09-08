// The window's background, while the deep-link confirmation is on screen.
//
// ITS OWN FILE BECAUSE THE SUBJECT RENDERS NOTHING. Everything next door is about what
// the overlay draws and which act each entry point dispatches, and every one of those
// cases reads the document. This one reads the frame store's cell, because the fact it
// is about — whether the shell hangs `inert` on the app root — has no mark on screen at
// all: the card is `modal="trap-focus"`, so the library traps the keyboard and leaves
// the structural half to the shell, and a card that never says it is up leaves the rail
// and the whole route surface walkable underneath it with nothing looking wrong.
//
// The register's own arithmetic is `store/modal-surface-claims.test.ts` and the hook's
// wiring is `store/modal-surface-lifetime.test.tsx`. What is asserted here is the one
// thing neither can see: that THIS body, handed the act through the window overlay
// seat, arms the guard on the card and gives it back on every ending the card has.

import { describe, expect, it } from "vitest";

import { FrameStore } from "../../store/index.js";
import { mountOverlay, press } from "./invite-lifecycle-overlay.test-support.js";

/** Whether the frame would hang `inert` on the background right now. */
function backgroundIsInert(frameStore: FrameStore): boolean {
  return frameStore.getState().isModalSurfaceOpen;
}

describe("the invite lifecycle — the window is inert for exactly the card's lifetime", () => {
  it("claims the window while the confirmation is up, and gives it back on the close", async () => {
    const { body, frameStore } = await mountOverlay();

    await press(body, "meridian-invite-notice__open");
    expect(backgroundIsInert(frameStore)).toBe(true);

    await press(body, "meridian-invite-confirmation__dismiss");
    expect(backgroundIsInert(frameStore)).toBe(false);
    expect(frameStore.modalSurfaceClaims.heldClaimCount).toBe(0);
  });

  it("negative control: an arrival nobody has looked at leaves the window alone", async () => {
    // The half a claim armed on the ARRIVAL would fail. A notice is meant to be
    // ignorable — it is drawn on somebody else's schedule — so a window inert behind
    // one would take the screen the notice exists to avoid taking.
    const { body, frameStore } = await mountOverlay();
    expect(body.querySelector(".meridian-invite-notice")).not.toBeNull();
    expect(backgroundIsInert(frameStore)).toBe(false);
  });

  it("gives the claim back when the overlay is torn down with the card still open", async () => {
    // The other ending, and the one a render React discards mid-arrival takes. A window
    // left inert with nothing on screen to close is worse than one never inerted.
    const { body, frameStore, unmount } = await mountOverlay();
    await press(body, "meridian-invite-notice__open");
    expect(backgroundIsInert(frameStore)).toBe(true);

    unmount();

    expect(backgroundIsInert(frameStore)).toBe(false);
    expect(frameStore.modalSurfaceClaims.heldClaimCount).toBe(0);
  });
});
