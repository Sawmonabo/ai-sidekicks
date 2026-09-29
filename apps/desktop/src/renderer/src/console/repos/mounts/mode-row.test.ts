// The one reading of one capabilities reply into picker rows.
//
// THE CASE THAT MAKES THIS ONE FUNCTION IS THE LAST ONE BELOW. A mode the reply names as
// BOTH available and restricted must keep the daemon's reason on the row on every
// surface: two derivations could disagree, one keeping the reason and the other blanking
// it, so the same malformed reply would disclose a restriction on one surface and hide it
// on the other. That arm is what holds the single implementation to it.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { executionModeRows } from "./mode-row.js";

/** An open mount's answer: both modes, nothing restricted. */
const OPEN_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "provisioned-worktree",
};

/** A restricted answer: one mode, the other excluded with the mount's reason. */
const RESTRICTED_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root"],
  defaultMode: "bound-root",
  restrictions: {
    "provisioned-worktree": "This workspace runs only in its own root, so no worktree is added.",
  },
};

describe("executionModeRows", () => {
  it("offers every available mode in the reply's own order", () => {
    const rows = executionModeRows(OPEN_CAPABILITIES);
    expect(rows.map((row) => row.mode)).toStrictEqual(["bound-root", "provisioned-worktree"]);
    expect(rows.every((row) => row.available)).toBe(true);
  });

  it("renders an excluded mode with the mount's own reason rather than dropping it", () => {
    const rows = executionModeRows(RESTRICTED_CAPABILITIES);
    const excluded = rows.filter((row) => !row.available);
    expect(excluded.map((row) => row.mode)).toStrictEqual(["provisioned-worktree"]);
    expect(excluded[0]?.restrictionReason).toContain("its own root");
  });

  it("keeps an available-AND-restricted mode's reason visible, on one row", () => {
    // The reply is malformed: it offers `bound-root` and also gives a reason for excluding
    // it. Hiding either half would be the renderer deciding which one was true, so the
    // row is offered — the reply is the authority on what is admitted — AND carries
    // what the daemon said about it.
    const rows = executionModeRows({
      availableModes: ["bound-root", "provisioned-worktree"],
      defaultMode: "bound-root",
      restrictions: { "bound-root": "stale" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.available)).toBe(true);
    expect(rows.find((row) => row.mode === "bound-root")?.restrictionReason).toBe("stale");
  });

  it("negative control: no restrictions map at all yields only the available rows", () => {
    const rows = executionModeRows(OPEN_CAPABILITIES);
    expect(rows.filter((row) => !row.available)).toStrictEqual([]);
    expect(rows.every((row) => row.restrictionReason === undefined)).toBe(true);
  });
});
