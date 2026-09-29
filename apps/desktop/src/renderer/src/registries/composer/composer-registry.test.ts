// The composer seat: filled by one family, mounted by another.
//
// The seat is module-scope, so every case releases it in `afterEach`. That is not
// tidiness — a case that left the seat filled would make the negative control
// below pass for the wrong reason, and the negative control is what proves the
// empty read is a real answer rather than a coincidence of ordering.

import { afterEach, describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import {
  findComposerRenderer,
  registerComposer,
  unregisterComposer,
  type ComposerRenderer,
} from "./composer-registry.js";

/** A body whose props are never read: these cases are about the seat. */
const composerBody: ComposerRenderer = () => null;

afterEach(() => {
  unregisterComposer();
});

describe("composer seat — one composer per session view", () => {
  it("hands the session screen the body itself, not a wrapper", () => {
    registerComposer("composer-family", composerBody);
    expect(findComposerRenderer()).toBe(composerBody);
  });

  it("replaces when the same owner re-registers", () => {
    // A hot reload re-runs the composer family's module. Keeping the FIRST body
    // would leave the window rendering the pre-edit composer.
    const replacement: ComposerRenderer = () => null;
    registerComposer("composer-family", composerBody);
    registerComposer("composer-family", replacement);
    expect(findComposerRenderer()).toBe(replacement);
  });

  it("refuses a second owner rather than swapping", () => {
    registerComposer("composer-family", composerBody);
    expect(() => {
      registerComposer("second-owner", () => null);
    }).toThrow(DuplicateRegistrationError);
    // The refusal must not have half-applied: the first body still renders.
    expect(findComposerRenderer()).toBe(composerBody);
  });

  it("names both owners in the refusal, so the conflict is actionable", () => {
    registerComposer("composer-family", composerBody);
    expect(() => {
      registerComposer("workflows-family", () => null);
    }).toThrow(/composer-family[\s\S]*workflows-family/u);
  });
});

describe("composer seat — the empty answer", () => {
  it("negative control: an unfilled seat has no body", () => {
    // Every case above reads `findComposerRenderer`, and all of them would pass
    // over a seat that answered with a body nobody registered. This is also the
    // state the session screen mounts against until the composer family lands: it
    // renders nothing rather than a placeholder that looks like a broken feature.
    expect(findComposerRenderer()).toBeUndefined();
  });

  it("is empty again once released", () => {
    registerComposer("composer-family", composerBody);
    expect(findComposerRenderer()).toBe(composerBody);
    unregisterComposer();
    expect(findComposerRenderer()).toBeUndefined();
  });
});
