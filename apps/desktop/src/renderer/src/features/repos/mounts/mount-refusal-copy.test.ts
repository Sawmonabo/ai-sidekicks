// The repo mounts' refusal copy: one move per code, and the three-way distinction.
//
// EVERY CASE HERE FAILS WITHOUT THE TABLE. Without it the recovery field on the repo
// mounts' refusal shapes is empty, so a person meeting `repo.already_attached` reads the
// code and nothing else.

import { describe, expect, it } from "vitest";

import {
  MOUNT_REFUSAL_CODES,
  modeRestrictionReason,
  mountRefusalRemedy,
} from "./mount-refusal-copy.js";

describe("mountRefusalRemedy — every registered code has a move", () => {
  it.each(MOUNT_REFUSAL_CODES)("answers %s with a non-empty next move", (code) => {
    const recovery = mountRefusalRemedy(code);
    expect(recovery).toBeDefined();
    expect(recovery?.nextMove.trim().length).toBeGreaterThan(0);
  });

  it("negative control: a code the repo mounts do not own gets nothing invented for it", () => {
    // The console must not answer a refusal it has no copy for with a generic
    // sentence: the daemon's own detail is then the only true thing on screen.
    expect(mountRefusalRemedy("session.not_found")).toBeUndefined();
  });

  it("negative control: an inherited property name is not a registered code", () => {
    // Read through `Object.hasOwn` rather than a bare index, so `toString` and
    // `constructor` are misses rather than functions rendered as recovery copy.
    expect(mountRefusalRemedy("toString")).toBeUndefined();
    expect(mountRefusalRemedy("constructor")).toBeUndefined();
  });
});

describe("mountRefusalRemedy — already attached routes to the mount that exists", () => {
  it("says the repository is already on the session and where to find it", () => {
    const recovery = mountRefusalRemedy("repo.already_attached");
    expect(recovery?.nextMove).toContain("already attached");
    // NOT a link and NOT a mount id: the refusal carries neither, and comparing paths
    // in the renderer is exactly what the trust envelope reserves to the daemon. The
    // move sends a person to the mount that already holds the repository
    // rather than fabricating a route to a row.
    expect(recovery?.nextMove).toContain("the mount that already holds it");
  });
});

describe("mountRefusalRemedy — the reuse conflict's three-way distinction", () => {
  it("separates the three states a candidate can be in", () => {
    const recovery = mountRefusalRemedy("worktree.reuse_conflict");
    expect(recovery?.distinctions).toHaveLength(3);
    expect(recovery?.distinctions.every((line) => line.trim().length > 0)).toBe(true);
  });

  it("negative control: an ordinary code carries no distinctions at all", () => {
    // The list is rendered as a list, so a code that filled it with one restatement of
    // its own move would put a bullet under every refusal the repo mounts raise.
    expect(mountRefusalRemedy("worktree.not_found")?.distinctions).toHaveLength(0);
  });
});

describe("mountRefusalRemedy — a folder with no repository in it", () => {
  it("says the attach failed because the folder is not a git repository", () => {
    const recovery = mountRefusalRemedy("repo.root_resolution_failed", {
      resolutionReason: "not_a_git_repository",
    });
    expect(recovery?.nextMove).toBe("Could not attach: not a git repository");
  });

  it("negative control: another resolution reason takes the table's arm", () => {
    const recovery = mountRefusalRemedy("repo.root_resolution_failed", {
      resolutionReason: "path_not_found",
    });
    expect(recovery?.nextMove).toContain("Nothing was attached");
  });
});

describe("mountRefusalRemedy — the unsupported mode answers from the mount", () => {
  it("quotes the mount's own restriction reason when the caller has one", () => {
    const recovery = mountRefusalRemedy("workspace.mode_unsupported", {
      restrictionReason: "no git repository at the mount root",
    });
    expect(recovery?.nextMove).toBe("no git repository at the mount root");
  });

  it("falls back to the table when the capabilities read named no reason", () => {
    const recovery = mountRefusalRemedy("workspace.mode_unsupported");
    expect(recovery?.nextMove).not.toBe("no git repository at the mount root");
    expect(recovery?.nextMove.trim().length).toBeGreaterThan(0);
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

  it("negative control: a sparse map gives nothing for a mode it does not name", () => {
    // `restrictions` is sparse on the wire, so a reader that returned some other
    // mode's sentence would attribute one mode's reason to another.
    expect(
      modeRestrictionReason({ "provisioned-worktree": "its own root only" }, "bound-root"),
    ).toBeUndefined();
    expect(modeRestrictionReason(undefined, "bound-root")).toBeUndefined();
    expect(modeRestrictionReason({ "bound-root": "reason" }, undefined)).toBeUndefined();
  });
});
