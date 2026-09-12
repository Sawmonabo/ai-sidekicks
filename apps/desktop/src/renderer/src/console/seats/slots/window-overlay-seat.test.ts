// The window overlay seat: one occupant, owner-scoped, and empty until somebody claims it.
//
// The three properties are `SingleSlotSeat`'s and they are asserted through THIS seat
// rather than re-derived: what this module owns is which seat name and which duplicate
// hint a refusal carries, and a case that drove the primitive directly would prove
// nothing about the seat the frame actually reads.

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenario/flagship/flagship.js";
import { FrameStore, modalSurfaceClaimFor } from "../../store/index.js";
import {
  registerWindowOverlaySeat,
  unregisterWindowOverlaySeat,
  windowOverlayRenderer,
} from "./window-overlay-seat.js";

const OWNER = "a-test";

afterEach(() => {
  unregisterWindowOverlaySeat();
});

describe("the window overlay seat", () => {
  it("is empty until somebody claims it", () => {
    expect(windowOverlayRenderer()).toBeUndefined();
  });

  it("hands back exactly what the owner registered", () => {
    const render = (): null => null;
    registerWindowOverlaySeat(OWNER, render);
    expect(windowOverlayRenderer()).toBe(render);
  });

  it("lets the same owner replace its own body", () => {
    // A hot reload re-runs the owning family's module, and a seat that refused would
    // leave the window rendering the retired body.
    registerWindowOverlaySeat(OWNER, () => null);
    const replacement = (): null => null;
    registerWindowOverlaySeat(OWNER, replacement);
    expect(windowOverlayRenderer()).toBe(replacement);
  });

  it("refuses a second owner rather than letting import order decide", () => {
    registerWindowOverlaySeat(OWNER, () => null);
    expect(() => {
      registerWindowOverlaySeat("another-test", () => null);
    }).toThrow(/window overlay/u);
  });

  it("carries a working modal-surface claim through to the body it seats", () => {
    // The seat is where the frame's props for the body are declared, so an act that
    // arrives as a name and moves no window is a `modal="trap-focus"` card with a live
    // background behind it. Driven end to end — the real act, over a real store — so
    // the case cannot pass on a stand-in the body would never be handed.
    const frameStore = new FrameStore();
    registerWindowOverlaySeat(OWNER, (props) => {
      props.claimModalSurface("a-seated-card", true);
      return null;
    });

    windowOverlayRenderer()?.({
      bridge: createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }),
      openSession: () => undefined,
      claimModalSurface: modalSurfaceClaimFor(frameStore),
    });

    expect(frameStore.getState().isModalSurfaceOpen).toBe(true);
    expect(frameStore.modalSurfaceClaims.heldClaimCount).toBe(1);
  });

  it("negative control: a seated body that claims nothing leaves the window live", () => {
    // Without this the case above would pass over a store that reported a modal
    // surface whether or not anything had claimed one.
    const frameStore = new FrameStore();
    registerWindowOverlaySeat(OWNER, () => null);

    windowOverlayRenderer()?.({
      bridge: createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }),
      openSession: () => undefined,
      claimModalSurface: modalSurfaceClaimFor(frameStore),
    });

    expect(frameStore.getState().isModalSurfaceOpen).toBe(false);
  });

  it("negative control: releasing it empties the seat for the next claimant", () => {
    // Without this the refusal above would be indistinguishable from a seat nothing
    // can ever be registered into twice, including by the owner that released it.
    registerWindowOverlaySeat(OWNER, () => null);
    unregisterWindowOverlaySeat();
    expect(windowOverlayRenderer()).toBeUndefined();
    registerWindowOverlaySeat("another-test", () => null);
    expect(windowOverlayRenderer()).not.toBeUndefined();
  });
});
