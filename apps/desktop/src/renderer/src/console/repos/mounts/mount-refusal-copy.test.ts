// The mounts family's refusal copy: one move per code, and the three-way distinction.
//
// EVERY CASE HERE FAILS WITHOUT THE TABLE. The recovery slot on this family's refusal
// shapes was empty before it, so a person meeting `repo.already_attached` read the code
// and nothing else.

import { describe, expect, it } from "vitest";

import {
  MOUNT_REFUSAL_CODES,
  modeRestrictionReason,
  mountRefusalRecovery,
} from "./mount-refusal-copy.js";

describe("mountRefusalRecovery — every registered code has a move", () => {
  it.each(MOUNT_REFUSAL_CODES)("answers %s with a non-empty next move", (code) => {
    const recovery = mountRefusalRecovery(code);
    expect(recovery).toBeDefined();
    expect(recovery?.nextMove.trim().length).toBeGreaterThan(0);
  });

  it("negative control: a code this family does not own gets nothing invented for it", () => {
    // The console must not answer a refusal it has no copy for with a generic
    // sentence: the daemon's own detail is then the only true thing on screen.
    expect(mountRefusalRecovery("session.not_found")).toBeUndefined();
  });

  it("negative control: an inherited property name is not a registered code", () => {
    // Read through `Object.hasOwn` rather than a bare index, so `toString` and
    // `constructor` are misses rather than functions rendered as recovery copy.
    expect(mountRefusalRecovery("toString")).toBeUndefined();
    expect(mountRefusalRecovery("constructor")).toBeUndefined();
  });
});

describe("mountRefusalRecovery — already attached routes to the mount that exists", () => {
  it("says the repository is already on the session and where to find it", () => {
    const recovery = mountRefusalRecovery("repo.already_attached");
    expect(recovery?.nextMove).toContain("already attached");
    // NOT a link and NOT a mount id: the refusal carries neither, and comparing paths
    // in the renderer is exactly what `Spec-009 §Local Trust Envelope (V1 Definition)` reserves to
    // daemon. The move sends a person to the mount that already holds the repository
    // rather than fabricating a route to a row.
    expect(recovery?.nextMove).toContain("the mount that already holds it");
  });
});

describe("mountRefusalRecovery — the reuse conflict's three-way distinction", () => {
  it("separates the three states a candidate can be in", () => {
    const recovery = mountRefusalRecovery("worktree.reuse_conflict");
    expect(recovery?.distinctions).toHaveLength(3);
    expect(recovery?.distinctions.every((line) => line.trim().length > 0)).toBe(true);
  });

  it("negative control: an ordinary code carries no distinctions at all", () => {
    // The list is rendered as a list, so a code that filled it with one restatement of
    // its own move would put a bullet under every refusal in the family.
    expect(mountRefusalRecovery("worktree.not_found")?.distinctions).toHaveLength(0);
  });
});

describe("mountRefusalRecovery — the unsupported mode answers from the mount", () => {
  it("quotes the mount's own restriction reason when the caller has one", () => {
    const recovery = mountRefusalRecovery("workspace.mode_unsupported", {
      restrictionReason: "no git repository at the mount root",
    });
    expect(recovery?.nextMove).toBe("no git repository at the mount root");
  });

  it("falls back to the table when the capabilities read named no reason", () => {
    const recovery = mountRefusalRecovery("workspace.mode_unsupported");
    expect(recovery?.nextMove).not.toBe("no git repository at the mount root");
    expect(recovery?.nextMove.trim().length).toBeGreaterThan(0);
  });
});

describe("modeRestrictionReason", () => {
  it("reads the reason for the mode that was pressed", () => {
    expect(
      modeRestrictionReason({ worktree: "no git repository at the mount root" }, "worktree"),
    ).toBe("no git repository at the mount root");
  });

  it("negative control: a sparse map gives nothing for a mode it does not name", () => {
    // `restrictions` is sparse on the wire, so a reader that returned some other
    // mode's sentence would attribute one mode's reason to another.
    expect(modeRestrictionReason({ worktree: "no git repository" }, "branch")).toBeUndefined();
    expect(modeRestrictionReason(undefined, "branch")).toBeUndefined();
    expect(modeRestrictionReason({ branch: "reason" }, undefined)).toBeUndefined();
  });
});
