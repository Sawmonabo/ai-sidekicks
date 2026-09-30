// Contract enums against the daemon schema's CHECK constraints.
//
// Every member of a contract enum is inserted into the column that stores it,
// and must be admitted; a value outside the enum must be refused. The member
// lists are `Record<Union, true>` maps, so a member added to or renamed in the
// contract is a typecheck error here until its accept case exists, and that
// case then fails at runtime until the CHECK admits it.
//
// `repo_mounts` and `workspaces` are covered the same way in
// `workspace/__tests__/repo-workspace-migration.test.ts`, and the provider
// account tables in `accounts/__tests__/provider-account-schema-conformance.test.ts`.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type ExecutionMode,
  type IdempotencyClass,
  type InterventionState,
  type InterventionType,
  type QueueItemState,
  type WorktreeState,
} from "@ai-sidekicks/contracts";

import { applyMigrations, applyPragmas } from "../../session/migration-runner.js";

const TIMESTAMP = "2026-09-28T00:00:00.000Z";
const NON_MEMBER = "not-a-member";
const CHECK_FAILURE = /CHECK constraint failed/;

const WORKTREE_STATES: Record<WorktreeState, true> = {
  creating: true,
  ready: true,
  dirty: true,
  merged: true,
  retired: true,
  failed: true,
};

const QUEUE_ITEM_STATES: Record<QueueItemState, true> = {
  queued: true,
  admitted: true,
  superseded: true,
  canceled: true,
  not_delivered: true,
};

const INTERVENTION_TYPES: Record<InterventionType, true> = {
  steer: true,
  interrupt: true,
  cancel: true,
  faster_model_retry: true,
};

const INTERVENTION_STATES: Record<InterventionState, true> = {
  requested: true,
  accepted: true,
  applied: true,
  rejected: true,
  degraded: true,
  expired: true,
};

const IDEMPOTENCY_CLASSES: Record<IdempotencyClass, true> = {
  idempotent: true,
  compensable: true,
  manual_reconcile_only: true,
};

function membersOf<Member extends string>(members: Record<Member, true>): Member[] {
  return Object.keys(members) as Member[];
}

describe("contract enums against the daemon schema", () => {
  let db: DatabaseType;
  let nextId = 0;
  const newId = (prefix: string): string => `${prefix}-${(nextId += 1)}`;

  // Parent rows the foreign keys need: one mount, one workspace, one worktree,
  // and one branch context bound to that worktree.
  const MOUNT_ID = "mount-1";
  const WORKSPACE_ID = "workspace-1";
  const WORKTREE_ID = "worktree-parent";
  const BRANCH_CONTEXT_ID = "branch-context-1";

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO repo_mounts
         (id, node_id, local_path, canonical_root, attached_at, updated_at)
       VALUES (?, 'node-1', '/repo', '/repo', ?, ?)`,
    ).run(MOUNT_ID, TIMESTAMP, TIMESTAMP);
    db.prepare(
      `INSERT INTO workspaces
         (id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at)
       VALUES (?, 'session-1', ?, 'provisioned-worktree', '/roots/one', 'ready', ?, ?)`,
    ).run(WORKSPACE_ID, MOUNT_ID, TIMESTAMP, TIMESTAMP);
    insertWorktree(WORKTREE_ID, "ready");
    db.prepare(
      `INSERT INTO branch_contexts
         (id, workspace_id, worktree_id, base_branch, head_branch, created_at, updated_at)
       VALUES (?, ?, ?, 'main', 'feature', ?, ?)`,
    ).run(BRANCH_CONTEXT_ID, WORKSPACE_ID, WORKTREE_ID, TIMESTAMP, TIMESTAMP);
  });

  afterEach(() => {
    db.close();
  });

  // Each worktree gets its own branch so the active-branch unique index never
  // refuses a row for a reason other than its state.
  function insertWorktree(id: string, state: string): void {
    db.prepare(
      `INSERT INTO worktrees
         (id, repo_mount_id, created_by_session_id, branch_name, fs_root, state, created_at,
          updated_at)
       VALUES (?, ?, 'session-1', ?, ?, ?, ?, ?)`,
    ).run(id, MOUNT_ID, `branch-${id}`, `/roots/${id}`, state, TIMESTAMP, TIMESTAMP);
  }

  function insertRunExecutionContext(
    mode: string,
    worktreeId: string | null,
    branchContextId: string | null,
  ): void {
    db.prepare(
      `INSERT INTO run_execution_contexts
         (run_id, session_id, workspace_id, execution_mode, execution_root, git_common_dir,
          worktree_id, branch_context_id, created_at)
       VALUES (?, 'session-1', ?, ?, '/roots/one', '/repo/.git', ?, ?, ?)`,
    ).run(newId("run"), WORKSPACE_ID, mode, worktreeId, branchContextId, TIMESTAMP);
  }

  function insertQueueItem(state: string): void {
    db.prepare(
      `INSERT INTO queue_items (id, session_id, state, created_at, updated_at)
       VALUES (?, 'session-1', ?, ?, ?)`,
    ).run(newId("queue-item"), state, TIMESTAMP, TIMESTAMP);
  }

  function insertIntervention(type: string, state: string): void {
    db.prepare(
      `INSERT INTO interventions
         (id, target_run_id, type, state, expected_run_version, client_idempotency_key, origin,
          created_at)
       VALUES (?, 'run-1', ?, ?, 1, ?, 'user', ?)`,
    ).run(newId("intervention"), type, state, newId("key"), TIMESTAMP);
  }

  it("admits every worktree state and refuses any other", () => {
    for (const state of membersOf(WORKTREE_STATES)) {
      expect(() => insertWorktree(newId("worktree"), state)).not.toThrow();
    }
    expect(() => insertWorktree(newId("worktree"), NON_MEMBER)).toThrow(CHECK_FAILURE);
  });

  it("admits every execution mode with the root ids that mode names, and refuses any other", () => {
    // The mode-conditional CHECK: which of the worktree and branch-context ids a
    // row carries is fixed by its mode.
    const rootIdsByMode: Record<ExecutionMode, [string | null, string | null]> = {
      "bound-root": [null, BRANCH_CONTEXT_ID],
      "provisioned-worktree": [WORKTREE_ID, BRANCH_CONTEXT_ID],
    };
    for (const [mode, [worktreeId, branchContextId]] of Object.entries(rootIdsByMode)) {
      expect(() => insertRunExecutionContext(mode, worktreeId, branchContextId)).not.toThrow();
    }
    expect(() => insertRunExecutionContext(NON_MEMBER, null, null)).toThrow(CHECK_FAILURE);
    expect(() =>
      insertRunExecutionContext("provisioned-worktree", null, BRANCH_CONTEXT_ID),
    ).toThrow(CHECK_FAILURE);
    expect(() => insertRunExecutionContext("bound-root", WORKTREE_ID, BRANCH_CONTEXT_ID)).toThrow(
      CHECK_FAILURE,
    );
    expect(() => insertRunExecutionContext("bound-root", null, null)).toThrow(CHECK_FAILURE);
  });

  it("admits every queue item state and refuses any other", () => {
    for (const state of membersOf(QUEUE_ITEM_STATES)) {
      expect(() => insertQueueItem(state)).not.toThrow();
    }
    expect(() => insertQueueItem(NON_MEMBER)).toThrow(CHECK_FAILURE);
  });

  it("admits every intervention type and state and refuses any other", () => {
    for (const type of membersOf(INTERVENTION_TYPES)) {
      expect(() => insertIntervention(type, "requested")).not.toThrow();
    }
    for (const state of membersOf(INTERVENTION_STATES)) {
      expect(() => insertIntervention("steer", state)).not.toThrow();
    }
    expect(() => insertIntervention(NON_MEMBER, "requested")).toThrow(CHECK_FAILURE);
    expect(() => insertIntervention("steer", NON_MEMBER)).toThrow(CHECK_FAILURE);
  });

  it("admits every driver capability flag and refuses any other", () => {
    const insertFlag = db.prepare(
      `INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
       VALUES ('claude', ?, 1, ?)`,
    );
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(() => insertFlag.run(flag, TIMESTAMP)).not.toThrow();
    }
    expect(() => insertFlag.run(NON_MEMBER, TIMESTAMP)).toThrow(CHECK_FAILURE);
  });

  it("admits every tool idempotency class and refuses any other", () => {
    const insertTool = db.prepare(
      `INSERT INTO driver_tools (driver_name, tool_name, idempotency_class, refreshed_at)
       VALUES ('claude', ?, ?, ?)`,
    );
    for (const idempotencyClass of membersOf(IDEMPOTENCY_CLASSES)) {
      expect(() => insertTool.run(newId("tool"), idempotencyClass, TIMESTAMP)).not.toThrow();
    }
    expect(() => insertTool.run(newId("tool"), NON_MEMBER, TIMESTAMP)).toThrow(CHECK_FAILURE);
  });
});
