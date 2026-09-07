// The one reading of one capabilities reply into picker rows.
//
// THE CASE THAT MADE THIS ONE FUNCTION IS THE LAST ONE BELOW. Two copies of this
// derivation existed — one in the mode picker, one in the bind dialog — and they
// disagreed about a mode the reply names as BOTH available and restricted: one kept
// the daemon's reason on the row and the other blanked it, so the same malformed reply
// disclosed a restriction on one surface and hid it on the other. That arm is now the
// gate on the single implementation.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { executionModeRows } from "./mode-row.js";

/** A git mount's answer: every mode, nothing restricted. */
const GIT_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
  defaultMode: "worktree",
};

/** A plain directory's answer: one mode, three excluded with reasons. */
const PLAIN_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only"],
  defaultMode: "read-only",
  restrictions: {
    branch: "This mount is not a git repository, so there is no branch to create.",
    worktree: "This mount is not a git repository, so no worktree can be added.",
    "ephemeral clone": "This mount is not a git repository, so there is nothing to clone.",
  },
};

describe("executionModeRows", () => {
  it("offers every available mode in the reply's own order", () => {
    const rows = executionModeRows(GIT_CAPABILITIES);
    expect(rows.map((row) => row.mode)).toStrictEqual([
      "read-only",
      "branch",
      "worktree",
      "ephemeral clone",
    ]);
    expect(rows.every((row) => row.available)).toBe(true);
  });

  it("renders an excluded mode with the mount's own reason rather than dropping it", () => {
    const rows = executionModeRows(PLAIN_CAPABILITIES);
    const excluded = rows.filter((row) => !row.available);
    expect(excluded.map((row) => row.mode)).toStrictEqual([
      "branch",
      "worktree",
      "ephemeral clone",
    ]);
    expect(excluded[0]?.restrictionReason).toContain("not a git repository");
  });

  it("keeps an available-AND-restricted mode's reason visible, on one row", () => {
    // The reply is malformed: it offers `branch` and also gives a reason for excluding
    // it. Hiding either half would be the renderer deciding which one was true, so the
    // row is offered — the reply is the authority on what is admitted — AND carries
    // what the daemon said about it. This is the arm the deleted second copy failed.
    const rows = executionModeRows({
      availableModes: ["read-only", "branch"],
      defaultMode: "branch",
      restrictions: { branch: "stale" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.available)).toBe(true);
    expect(rows.find((row) => row.mode === "branch")?.restrictionReason).toBe("stale");
  });

  it("negative control: no restrictions map at all yields only the available rows", () => {
    const rows = executionModeRows(GIT_CAPABILITIES);
    expect(rows.filter((row) => !row.available)).toStrictEqual([]);
    expect(rows.every((row) => row.restrictionReason === undefined)).toBe(true);
  });
});
