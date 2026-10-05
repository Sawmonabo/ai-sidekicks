// The worktree status read the desktop renders: every standing tree in the caller's order, each
// row's fields folded onto the wire record.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WorktreeStatusReadRequestSchema,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts/worktree/worktree";

import { projectWorktreeStatusRead } from "../worktree-projector.js";
import type { WorktreeStatusReading, WorktreeStatusRow } from "../worktree-projector.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Real UUIDs: the projection parses every id through a UUID schema.
const SESSION_ID: string = randomUUID();
const CREATING_SESSION_ID: string = randomUUID();
const MOUNT_A_ID: string = randomUUID();
const RUN_ID: string = randomUUID();

const CREATED_AT: string = "2026-08-04T12:00:00.000Z";
const UPDATED_AT: string = "2026-08-04T12:05:00.000Z";
const FETCHED_AT: string = "2026-08-04T11:40:00.000Z";

const REPO_ROOT = { path: "/Users/dev/code/beacon", branchName: "main" };
const NEW_WORKTREE = {
  fixedPart: "sidekicks/1a2b3c4d/",
  suggestedTail: "add-status-view",
  folderBefore: "~/.ai-sidekicks/worktrees/beacon/1a2b3c4d-",
};

const BASE_WORKTREE_ROW: WorktreeStatusRow = {
  id: randomUUID(),
  repo_mount_id: MOUNT_A_ID,
  created_by_session_id: SESSION_ID,
  created_by_run_id: null,
  branch_name: "sidekicks/8f2a1c/add-status-view",
  fs_root: "/Users/dev/.ai-sidekicks/worktrees/beacon/8f2a1c-add-status-view",
  state: "ready",
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
  name: "8f2a1c-add-status-view",
  base_branch_name: "main",
  ahead: null,
  behind: null,
  uncommitted_file_count: 0,
  unpushed_commit_count: 0,
  occupying_session_ids: [],
  running_session_id: null,
};

/** A row with a fresh id, overridden field by field. */
function worktreeRow(overrides: Partial<WorktreeStatusRow> = {}): WorktreeStatusRow {
  return { ...BASE_WORKTREE_ROW, id: randomUUID(), ...overrides };
}

function reading(
  worktrees: readonly WorktreeStatusRow[] = [],
  overrides: Partial<WorktreeStatusReading> = {},
): WorktreeStatusReading {
  return { repoRoot: REPO_ROOT, worktrees, countsAsOf: null, newWorktree: null, ...overrides };
}

/** A read of folder A, with the request built through the contract's schema. */
function project(input: WorktreeStatusReading, sessionId?: string): WorktreeStatusReadResponse {
  const request = WorktreeStatusReadRequestSchema.parse(
    sessionId === undefined ? { repoMountId: MOUNT_A_ID } : { repoMountId: MOUNT_A_ID, sessionId },
  );
  return projectWorktreeStatusRead(request, input);
}

/** The single record of a one-row projection; throws so an absence check cannot pass vacuously. */
function onlyWorktreeRecord(
  response: WorktreeStatusReadResponse,
): WorktreeStatusReadResponse["worktrees"][number] {
  const [record] = response.worktrees;
  if (record === undefined || response.worktrees.length !== 1) {
    throw new Error(
      `expected exactly one projected worktree record, got ${String(response.worktrees.length)}`,
    );
  }
  return record;
}

// ----------------------------------------------------------------------------
// What is listed
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — the trees still standing", () => {
  it("lists every standing state in the caller's order and leaves a retired tree out", () => {
    const rows = [
      worktreeRow({ state: "merged" }),
      worktreeRow({ state: "retired" }),
      worktreeRow({ state: "creating" }),
      worktreeRow({ state: "dirty" }),
      worktreeRow({ state: "failed" }),
      worktreeRow({ state: "ready" }),
    ];

    const response = project(reading(rows));

    expect(response.worktrees.map((record) => record.state)).toEqual([
      "merged",
      "creating",
      "dirty",
      "failed",
      "ready",
    ]);
  });
});

// ----------------------------------------------------------------------------
// The fold
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — field by field", () => {
  it("carries each field and figure of a row, the fetch age and the form's suggestion", () => {
    const row = worktreeRow({
      state: "dirty",
      created_by_session_id: CREATING_SESSION_ID,
      created_by_run_id: RUN_ID,
      ahead: 2,
      behind: 1,
      uncommitted_file_count: 3,
      unpushed_commit_count: 2,
      occupying_session_ids: [SESSION_ID],
      running_session_id: SESSION_ID,
    });

    const response = project(
      reading([row], { countsAsOf: FETCHED_AT, newWorktree: NEW_WORKTREE }),
      SESSION_ID,
    );

    expect(response.countsAsOf).toBe(FETCHED_AT);
    expect(response.newWorktree).toEqual(NEW_WORKTREE);
    expect(onlyWorktreeRecord(response)).toEqual({
      worktreeId: row.id,
      repoMountId: MOUNT_A_ID,
      name: row.name,
      branchName: row.branch_name,
      baseBranchName: "main",
      fsRoot: row.fs_root,
      state: "dirty",
      ahead: 2,
      behind: 1,
      uncommittedFileCount: 3,
      unpushedCommitCount: 2,
      occupyingSessionIds: [SESSION_ID],
      runningSessionId: SESSION_ID,
      // The creating session, not the one reading: provenance survives.
      createdBySessionId: CREATING_SESSION_ID,
      createdByRunId: RUN_ID,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
  });
});
