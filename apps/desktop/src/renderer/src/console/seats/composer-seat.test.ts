// The composer seat: filled by one family, mounted by another.
//
// The seat is module-scope, so every case releases it in `afterEach`. That is not
// tidiness — a case that left the seat filled would make the negative control
// below pass for the wrong reason, and the negative control is what proves the
// empty read is a real answer rather than a coincidence of ordering.

import { afterEach, describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "../core/index.js";
import {
  composerSeatRenderer,
  registerComposerSeat,
  unregisterComposerSeat,
  type ComposerSeatRenderer,
} from "./composer-seat.js";

/** A body whose props are never read: these cases are about the seat. */
const composerBody: ComposerSeatRenderer = () => null;

afterEach(() => {
  unregisterComposerSeat();
});

describe("composer seat — one composer per session view", () => {
  it("hands the workspace the body itself, not a wrapper", () => {
    registerComposerSeat("composer-family", composerBody);
    expect(composerSeatRenderer()).toBe(composerBody);
  });

  it("replaces when the same owner re-registers", () => {
    // A hot reload re-runs the composer family's module. Keeping the FIRST body
    // would leave the window rendering the pre-edit composer.
    const replacement: ComposerSeatRenderer = () => null;
    registerComposerSeat("composer-family", composerBody);
    registerComposerSeat("composer-family", replacement);
    expect(composerSeatRenderer()).toBe(replacement);
  });

  it("refuses a second owner rather than swapping", () => {
    registerComposerSeat("composer-family", composerBody);
    expect(() => {
      registerComposerSeat("collaboration-family", () => null);
    }).toThrow(DuplicateRegistrationError);
    // The refusal must not have half-applied: the first body still renders.
    expect(composerSeatRenderer()).toBe(composerBody);
  });

  it("names both owners in the refusal, so the conflict is actionable", () => {
    registerComposerSeat("composer-family", composerBody);
    expect(() => {
      registerComposerSeat("workflows-family", () => null);
    }).toThrow(/composer-family[\s\S]*workflows-family/u);
  });
});

describe("composer seat — the empty answer", () => {
  it("negative control: an unfilled seat has no body", () => {
    // Every case above reads `composerSeatRenderer`, and all of them would pass
    // over a seat that answered with a body nobody registered. This is also the
    // state the workspace mounts against until T-023p-1C-3 lands: it renders
    // nothing rather than a placeholder that looks like a broken feature.
    expect(composerSeatRenderer()).toBeUndefined();
  });

  it("is empty again once released", () => {
    registerComposerSeat("composer-family", composerBody);
    expect(composerSeatRenderer()).toBe(composerBody);
    unregisterComposerSeat();
    expect(composerSeatRenderer()).toBeUndefined();
  });
});
