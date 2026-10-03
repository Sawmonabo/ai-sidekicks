// The repo mounts' refusal copy answers only the codes it owns, and never an inherited property
// name, so the daemon's own detail stays the only true thing on screen for any other code.

import { describe, expect, it } from "vitest";

import { mountRefusalRemedy } from "./mount-refusal-copy.js";

describe("mountRefusalRemedy — only the codes it owns", () => {
  it("invents nothing for a code the repo mounts do not own", () => {
    // The console must not answer a refusal it has no copy for with a generic sentence: the
    // daemon's own detail is then the only true thing on screen.
    expect(mountRefusalRemedy("session.not_found")).toBeUndefined();
  });

  it("reads an inherited property name as no registered code", () => {
    // Read through `Object.hasOwn` rather than a bare index, so `toString` and
    // `constructor` are misses rather than functions rendered as recovery copy.
    expect(mountRefusalRemedy("toString")).toBeUndefined();
    expect(mountRefusalRemedy("constructor")).toBeUndefined();
  });
});
