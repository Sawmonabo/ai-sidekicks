// The composer registry is module-scope, so every case releases it in `afterEach`; a leftover
// entry would make the empty-registry negative control pass for the wrong reason.

import { afterEach, describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import {
  findComposerRenderer,
  registerComposer,
  unregisterComposer,
  type ComposerRenderer,
} from "./composer-registry.js";

/** A body whose props are never read. */
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
    // A hot reload re-runs the feature's module; keeping the first body would render the stale
    // composer.
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
    // The refusal must not half-apply.
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
    // Every case above would pass over a registry that answered with a body nobody registered.
    expect(findComposerRenderer()).toBeUndefined();
  });

  it("is empty again once released", () => {
    registerComposer("composer-feature", composerBody);
    expect(findComposerRenderer()).toBe(composerBody);
    unregisterComposer();
    expect(findComposerRenderer()).toBeUndefined();
  });
});
