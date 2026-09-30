// The one reading of one capabilities reply into picker rows. The last case is the one that
// justifies a single implementation: a mode both available and restricted must keep the
// daemon's reason on every component.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { executionModeRows } from "./execution-mode-rows.js";

const OPEN_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "provisioned-worktree",
};

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
    // A malformed reply offers `bound-root` and also gives a reason for excluding it; the row
    // is offered (the reply is the authority on what is admitted) and carries the reason.
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
