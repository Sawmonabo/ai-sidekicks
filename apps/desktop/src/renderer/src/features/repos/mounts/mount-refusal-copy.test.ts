// The repo mounts' refusal copy answers only the codes it owns, and never an inherited property
// name, so the daemon's own detail stays the only true thing on screen for any other code. A
// mode's restriction reason is that mode's own, never another's.

import { describe, expect, it } from "vitest";

import { modeRestrictionReason, mountRefusalRemedy } from "./mount-refusal-copy.js";

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

describe("modeRestrictionReason", () => {
  it("reads the reason for the mode that was pressed", () => {
    expect(
      modeRestrictionReason(
        { "provisioned-worktree": "this workspace runs only in its own root" },
        "provisioned-worktree",
      ),
    ).toBe("this workspace runs only in its own root");
  });

  it("gives nothing for a mode a sparse map does not name", () => {
    // `restrictions` is sparse on the wire, so a reader that returned some other
    // mode's sentence would attribute one mode's reason to another.
    expect(
      modeRestrictionReason({ "provisioned-worktree": "its own root only" }, "bound-root"),
    ).toBeUndefined();
    expect(modeRestrictionReason(undefined, "bound-root")).toBeUndefined();
    expect(modeRestrictionReason({ "bound-root": "reason" }, undefined)).toBeUndefined();
  });
});
