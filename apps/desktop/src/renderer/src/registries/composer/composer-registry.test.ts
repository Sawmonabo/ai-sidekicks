// The composer registry: filled by one feature, mounted by another.
//
// The registry is module-scope, so every case releases it in `afterEach`. That is not
// tidiness — a case that left the registry filled would make the negative control
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

/** A body whose props are never read: these cases are about the registry. */
const composerBody: ComposerRenderer = () => null;

afterEach(() => {
  unregisterComposer();
});

describe("composer registry — one composer per session view", () => {
  it("hands the session screen the body itself, not a wrapper", () => {
    registerComposer("composer-feature", composerBody);
    expect(findComposerRenderer()).toBe(composerBody);
  });

  it("replaces when the same owner re-registers", () => {
    // A hot reload re-runs the composer feature's module. Keeping the FIRST body
    // would leave the window rendering the pre-edit composer.
    const replacement: ComposerRenderer = () => null;
    registerComposer("composer-feature", composerBody);
    registerComposer("composer-feature", replacement);
    expect(findComposerRenderer()).toBe(replacement);
  });

  it("refuses a second owner rather than swapping", () => {
    registerComposer("composer-feature", composerBody);
    expect(() => {
      registerComposer("second-owner", () => null);
    }).toThrow(DuplicateRegistrationError);
    // The refusal must not have half-applied: the first body still renders.
    expect(findComposerRenderer()).toBe(composerBody);
  });

  it("names both owners in the refusal, so the conflict is actionable", () => {
    registerComposer("composer-feature", composerBody);
    expect(() => {
      registerComposer("workflows-feature", () => null);
    }).toThrow(/composer-feature[\s\S]*workflows-feature/u);
  });
});

describe("composer registry — the empty answer", () => {
  it("negative control: an empty registry has no body", () => {
    // Every case above reads `findComposerRenderer`, and all of them would pass
    // over a registry that answered with a body nobody registered. This is also the
    // state the session screen mounts against until the composer feature lands: it
    // renders nothing rather than a placeholder that looks like a broken feature.
    expect(findComposerRenderer()).toBeUndefined();
  });

  it("is empty again once released", () => {
    registerComposer("composer-feature", composerBody);
    expect(findComposerRenderer()).toBe(composerBody);
    unregisterComposer();
    expect(findComposerRenderer()).toBeUndefined();
  });
});
