// The worktree status read the desktop renders: every standing tree in the caller's order.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { projectWorktreeStatusRead } from "../projector.js";
import type { WorktreeRecordRow, WorktreeStatusReading, WorktreeStatusRow } from "../projector.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Real UUIDs: the projection parses every id through a UUID schema.
const SESSION_ID: string = randomUUID();
const MOUNT_A_ID: string = randomUUID();

const CREATED_AT: string = "2026-08-04T12:00:00.000Z";
const UPDATED_AT: string = "2026-08-04T12:05:00.000Z";

const REPO_ROOT = { path: "/Users/dev/code/beacon", branchName: "main" };

const BASE_RECORD: WorktreeRecordRow = {
  id: randomUUID(),
  repo_mount_id: MOUNT_A_ID,
  created_by_session_id: SESSION_ID,
  created_by_run_id: null,
  state: "ready",
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
  base_branch_name: "main",
};

const BASE_WORKTREE_ROW: WorktreeStatusRow = {
  path: "/Users/dev/.ai-sidekicks/worktrees/beacon/8f2a1c-add-status-view",
  name: "8f2a1c-add-status-view",
  branchName: "sidekicks/8f2a1c/add-status-view",
  ahead: null,
  behind: null,
  uncommittedFileCount: 0,
  unpushedCommitCount: 0,
  occupyingSessionIds: [],
  runningSessionId: null,
  record: BASE_RECORD,
};

/** An app-made row with a fresh record id, its record overridden field by field. */
function appMadeRow(recordOverrides: Partial<WorktreeRecordRow> = {}): WorktreeStatusRow {
  return {
    ...BASE_WORKTREE_ROW,
    record: { ...BASE_RECORD, id: randomUUID(), ...recordOverrides },
  };
}

function reading(worktrees: readonly WorktreeStatusRow[]): WorktreeStatusReading {
  return {
    repoMountId: MOUNT_A_ID,
    repoRoot: REPO_ROOT,
    worktrees,
    countsAsOf: null,
    newWorktree: null,
  };
}

// ----------------------------------------------------------------------------
// What is listed
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — the trees still standing", () => {
  it("lists every standing state in the caller's order and leaves a retired tree out", () => {
    const rows = [
      appMadeRow({ state: "merged" }),
      appMadeRow({ state: "retired" }),
      appMadeRow({ state: "creating" }),
      appMadeRow({ state: "dirty" }),
      appMadeRow({ state: "failed" }),
      appMadeRow({ state: "ready" }),
    ];

    const response = projectWorktreeStatusRead(reading(rows));

    expect(
      response.worktrees.map((record) => (record.madeBy === "app" ? record.state : null)),
    ).toEqual(["merged", "creating", "dirty", "failed", "ready"]);
  });
});
