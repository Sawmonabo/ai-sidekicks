// The window overlay seat: one occupant, owner-scoped, and empty until somebody claims it.
//
// The three properties are `SingleSlotSeat`'s and they are asserted through THIS seat
// rather than re-derived: what this module owns is which seat name and which duplicate
// hint a refusal carries, and a case that drove the primitive directly would prove
// nothing about the seat the frame actually reads.

import { afterEach, describe, expect, it } from "vitest";

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
