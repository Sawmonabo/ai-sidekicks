// worktree-projector behavior.
//
// No database, no temp directory, no clock: the module under test performs no
// I/O, so every branch is driven by handing it rows directly.
//
// What is covered:
//   * The switcher lists the trees still standing: every state but `retired` is
//     carried in the order handed in, and a `retired` row is left out.
//   * The fold carries each field and figure across, and leaves an optional one
//     absent, by key, whether the caller sent `null` or never selected it.
//   * The read's folder binding: a row on another project's folder is refused.
//   * The parse boundary can fail: a state outside the closed vocabulary, a
//     non-ISO instant and a non-UUID id each throw with the `ZodError` as cause.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WorktreeStatusReadRequestSchema,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

import { projectWorktreeStatusRead } from "../worktree-projector.js";
import type { WorktreeStatusReading, WorktreeStatusRow } from "../worktree-projector.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Real UUIDs: every id is parsed through a branded UUID schema at the
// projection's parse boundary, so counters would fail for the wrong reason.
const SESSION_ID: string = randomUUID();
const CREATING_SESSION_ID: string = randomUUID();
const MOUNT_A_ID: string = randomUUID();
const MOUNT_B_ID: string = randomUUID();
const RUN_ID: string = randomUUID();

const CREATED_AT: string = "2026-08-04T12:00:00.000Z";
const UPDATED_AT: string = "2026-08-04T12:05:00.000Z";
const FETCHED_AT: string = "2026-08-04T11:40:00.000Z";

const REPO_ROOT = { path: "/Users/dev/code/beacon", branchName: "main" };
const NEW_WORKTREE = {
  fixedPart: "sidekicks/1a2b3c4d/",
  suggestedTail: "add-status-view",
  pathHint: "~/.ai-sidekicks/worktrees/beacon/1a2b3c4d-add-status-view",
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

/**
 * A row as a query that FORGOT a column hands it over: the key is absent, so
 * the field reads `undefined` rather than `null`. The row interface cannot
 * express that, hence the one cast in this file.
 */
function withColumnOmitted(
  row: WorktreeStatusRow,
  column: keyof WorktreeStatusRow,
): WorktreeStatusRow {
  const { [column]: _omittedColumn, ...withoutColumn } = row;
  return withoutColumn as WorktreeStatusRow;
}

/** A read of folder A, built through the contract's schema so its ids are real parses. */
function project(input: WorktreeStatusReading, sessionId?: string): WorktreeStatusReadResponse {
  const request = WorktreeStatusReadRequestSchema.parse(
    sessionId === undefined ? { repoMountId: MOUNT_A_ID } : { repoMountId: MOUNT_A_ID, sessionId },
  );
  return projectWorktreeStatusRead(request, input);
}

/** The single record of a one-row projection; throws rather than letting an absence check pass vacuously. */
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

  it("answers the repo-root row alone for a project with no trees", () => {
    expect(project(reading())).toEqual({ repoRoot: REPO_ROOT, worktrees: [] });
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

  it("leaves an optional field absent by key, whether null or never selected", () => {
    const nulls = onlyWorktreeRecord(project(reading([worktreeRow()])));
    // Seeded non-null before the column is dropped, so a helper that stopped
    // omitting would leave the value in place and fail here.
    const unselected = onlyWorktreeRecord(
      project(
        reading([
          withColumnOmitted(
            withColumnOmitted(
              withColumnOmitted(
                worktreeRow({ created_by_run_id: RUN_ID, ahead: 4, behind: 5 }),
                "ahead",
              ),
              "behind",
            ),
            "created_by_run_id",
          ),
        ]),
      ),
    );

    for (const record of [nulls, unselected]) {
      expect("ahead" in record).toBe(false);
      expect("behind" in record).toBe(false);
      expect("createdByRunId" in record).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// The folder binding — the fail-closed guard
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — the read's folder", () => {
  it("refuses a row on another project's folder, naming the row", () => {
    const foreign = worktreeRow({ repo_mount_id: MOUNT_B_ID });

    expect(() => project(reading([worktreeRow(), foreign]))).toThrow(
      new RegExp(`different project folder.*${foreign.id}`, "s"),
    );
  });

  it("refuses a retired row on another folder too: the binding is checked before the listing rule", () => {
    const foreign = worktreeRow({ repo_mount_id: MOUNT_B_ID, state: "retired" });

    expect(() => project(reading([foreign]))).toThrow(/different project folder/);
  });
});

// ----------------------------------------------------------------------------
// The parse boundary
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — the parse boundary", () => {
  it.each([
    ["a state outside the closed vocabulary", { state: "hibernating" }],
    ["a non-ISO instant", { created_at: "4 August 2026, just after lunch" }],
    ["an id that is not a UUID", { id: "worktree-7" }],
    ["a negative count", { uncommitted_file_count: -1 }],
  ])("refuses %s at the projection", (_label, overrides) => {
    expect(() => project(reading([worktreeRow(overrides)]))).toThrow(
      /WorktreeStatusReadResponse shape\s+refuses/,
    );
  });

  it("carries the validation failure as `cause`, with the array named", () => {
    let cause: unknown;
    try {
      project(reading([worktreeRow({ state: "hibernating" })]));
    } catch (error) {
      cause = error instanceof Error ? error.cause : undefined;
    }

    expect(cause).toBeInstanceOf(Error);
    expect(String((cause as Error).message)).toMatch(/worktrees/);
  });
});
