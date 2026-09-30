// The worktree contract's identity edges: a worktree id and a branch-context id are distinct
// brands no raw string satisfies, a prepare request cannot carry the run provenance the daemon
// stamps, and the switcher's read never lists a retired tree.
import { describe, expect, it } from "vitest";

import {
  ExecutionRootPrepareRequestSchema,
  WorktreeIdSchema,
  WorktreeStatusReadResponseSchema,
  type BranchContextId,
  type WorktreeId,
} from "../worktree.js";

// Real RFC 9562 UUIDs (v4 and v7): the schemas validate the version nibble and variant bits,
// so lookalike strings would not parse.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const BRANCH_CONTEXT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f14";
const RUN_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f15";
const EXECUTION_ROOT = "/Users/dev/.ai-sidekicks/execution-roots/mount-0190f8a0/worktrees/wt-01";
const BRANCH_NAME = "sidekicks/550e8400/add-worktree-wire-pairs";
const CREATED_AT = "2026-07-26T09:30:00.000Z";
const UPDATED_AT = "2026-07-26T09:31:00.000Z";

// Compile-time pins, never executed: `tsc -p tsconfig.test.json` fails if a brand decays to a
// plain string or the two brands collapse into one.
const brandNominalityPin = (): void => {
  // @ts-expect-error — a raw string is not a WorktreeId without a parse.
  const unbrandedWorktreeId: WorktreeId = WORKTREE_ID;
  void unbrandedWorktreeId;
  // @ts-expect-error — a raw string is not a BranchContextId without a parse.
  const unbrandedBranchContextId: BranchContextId = BRANCH_CONTEXT_ID;
  void unbrandedBranchContextId;
  // @ts-expect-error — a parsed WorktreeId is not a BranchContextId.
  const crossBrand: BranchContextId = WorktreeIdSchema.parse(WORKTREE_ID);
  void crossBrand;
};
void brandNominalityPin;

const parsePrepareRequest = (overrides: Record<string, unknown> = {}) =>
  ExecutionRootPrepareRequestSchema.safeParse({ workspaceId: WORKSPACE_ID, ...overrides });

describe("ExecutionRootPrepare request (create or bind)", () => {
  it("accepts the full explicit-reuse shape", () => {
    expect(
      parsePrepareRequest({
        branchName: BRANCH_NAME,
        baseRef: "main",
        reuseWorktreeId: WORKTREE_ID,
        acknowledgeDirtyCandidate: true,
      }).success,
    ).toBe(true);
  });

  it("carries no wire runId, since the daemon supplies run provenance", () => {
    // The run-setup gate calls the service directly and supplies the run id. A wire `runId`
    // would let a caller forge provenance, so `.strict()` refuses the key.
    expect(parsePrepareRequest({ runId: RUN_ID }).success).toBe(false);
  });
});

// A live, run-created checkout, with the figures its switcher row draws.
const buildWorktreeStatusRecord = () => ({
  worktreeId: WORKTREE_ID,
  repoMountId: REPO_MOUNT_ID,
  name: "1a2b3c4d-fix-login-bug",
  branchName: BRANCH_NAME,
  baseBranchName: "main",
  fsRoot: EXECUTION_ROOT,
  state: "ready",
  ahead: 2,
  behind: 1,
  uncommittedFileCount: 3,
  unpushedCommitCount: 2,
  occupyingSessionIds: [SESSION_ID],
  runningSessionId: null,
  createdBySessionId: SESSION_ID,
  createdByRunId: RUN_ID,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
});
const buildWorktreeStatusReadResponse = () => ({
  repoRoot: { path: "/Users/dev/code/beacon", branchName: "main" },
  worktrees: [buildWorktreeStatusRecord()],
  countsAsOf: CREATED_AT,
  newWorktree: {
    fixedPart: "sidekicks/1a2b3c4d/",
    suggestedTail: "fix-login-bug",
    folderBefore: "~/.ai-sidekicks/worktrees/beacon/1a2b3c4d-",
  },
});
const parseStatusReadWithWorktree = (overrides: Record<string, unknown> = {}) =>
  WorktreeStatusReadResponseSchema.safeParse({
    ...buildWorktreeStatusReadResponse(),
    worktrees: [{ ...buildWorktreeStatusRecord(), ...overrides }],
  });

describe("WorktreeStatusRead (the switcher's one read, keyed by the project's folder)", () => {
  it("carries the repo-root row, each tree's figures, the fetch age and the form's suggestion", () => {
    expect(
      WorktreeStatusReadResponseSchema.safeParse(buildWorktreeStatusReadResponse()).success,
    ).toBe(true);
  });

  it("never lists a retired tree", () => {
    expect(parseStatusReadWithWorktree({ state: "retired" }).success).toBe(false);
    expect(parseStatusReadWithWorktree({ state: "failed" }).success).toBe(true);
  });
});
