// Every member of a contract enum is admitted by the SQLite CHECK on the column that stores it, and
// a value outside the enum is refused; a session's step limit and a link's use count are refused
// below one. The `Record<Union, true>` member maps make a contract member added without an accept
// case a typecheck error here.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DRIVER_CAPABILITY_FLAGS } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { type InterventionType } from "@ai-sidekicks/contracts/provider/driver/intervention";
import { type IdempotencyClass } from "@ai-sidekicks/contracts/provider/driver/tools";
import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/mount";
import type { InterventionState } from "@ai-sidekicks/contracts/run/control";
import type { QueueItemState } from "@ai-sidekicks/contracts/run/queue";
import type { ChildRunProvenance } from "@ai-sidekicks/contracts/run/queued";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { SessionLinkKind } from "@ai-sidekicks/contracts/session/links";
import type { SessionShape, SessionState } from "@ai-sidekicks/contracts/session/methods";
import type { WorktreeState } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { applyMigrations, applyPragmas } from "../migration-runner.js";
import type { SessionRunOutcome } from "../records.js";

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
  faster_model_retry: true,
};

const INTERVENTION_STATES: Record<InterventionState, true> = {
  requested: true,
  accepted: true,
  applied: true,
  rejected: true,
  degraded: true,
  expired: true,
  failed: true,
};

const RUN_STATES: Record<RunState, true> = {
  queued: true,
  starting: true,
  running: true,
  waiting_for_approval: true,
  waiting_for_input: true,
  pausing: true,
  paused: true,
  completed: true,
  interrupted: true,
  stopped: true,
  failed: true,
};

const CHILD_RUN_PROVENANCES: Record<ChildRunProvenance, true> = {
  provider_subagent: true,
  bridge_run: true,
  workflow_step: true,
};

const IDEMPOTENCY_CLASSES: Record<IdempotencyClass, true> = {
  idempotent: true,
  compensable: true,
  manual_reconcile_only: true,
};

const EXECUTION_MODES: Record<ExecutionMode, true> = {
  "bound-root": true,
  "provisioned-worktree": true,
};

const SESSION_SHAPES: Record<SessionShape, true> = { chat: true, project: true };

const SESSION_STATES: Record<SessionState, true> = {
  provisioning: true,
  active: true,
  archived: true,
  closed: true,
  purge_requested: true,
};

const RUN_OUTCOMES: Record<SessionRunOutcome, true> = { done: true, failed: true, idle: true };

const LINK_KINDS: Record<SessionLinkKind, true> = {
  started: true,
  copied_from: true,
  messaged: true,
  asked: true,
  mentioned: true,
  related: true,
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

  // A valid row; each case overrides the one column it checks.
  function insertSession(
    overrides: { shape?: string; state?: string; lastRunOutcome?: string } = {},
  ): void {
    db.prepare(
      `INSERT INTO sessions
         (id, shape, state, last_run_outcome, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("session"),
      overrides.shape ?? "chat",
      overrides.state ?? "active",
      overrides.lastRunOutcome ?? "idle",
      TIMESTAMP,
      TIMESTAMP,
      TIMESTAMP,
    );
  }

  function insertIntervention(type: string, state: string): void {
    db.prepare(
      `INSERT INTO interventions
         (id, target_run_id, type, state, expected_run_version, client_idempotency_key,
          device_id, created_at)
       VALUES (?, 'run-1', ?, ?, 1, ?, 'device-1', ?)`,
    ).run(newId("intervention"), type, state, newId("key"), TIMESTAMP);
  }

  function insertRun(state: string, reachedBy: string | null): void {
    db.prepare(
      `INSERT INTO runs (run_id, session_id, reached_by, state, run_version)
       VALUES (?, 'session-1', ?, ?, 0)`,
    ).run(newId("run"), reachedBy, state);
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

  it("admits every run state and child run provenance and refuses any other", () => {
    for (const state of membersOf(RUN_STATES)) {
      expect(() => insertRun(state, null)).not.toThrow();
    }
    for (const reachedBy of membersOf(CHILD_RUN_PROVENANCES)) {
      expect(() => insertRun("queued", reachedBy)).not.toThrow();
    }
    expect(() => insertRun(NON_MEMBER, null)).toThrow(CHECK_FAILURE);
    expect(() => insertRun("queued", NON_MEMBER)).toThrow(CHECK_FAILURE);
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

  it("admits every session shape, state and run outcome, and refuses any other", () => {
    for (const shape of membersOf(SESSION_SHAPES)) {
      expect(() => insertSession({ shape })).not.toThrow();
    }
    for (const state of membersOf(SESSION_STATES)) {
      expect(() => insertSession({ state })).not.toThrow();
    }
    for (const lastRunOutcome of membersOf(RUN_OUTCOMES)) {
      expect(() => insertSession({ lastRunOutcome })).not.toThrow();
    }
    expect(() => insertSession({ shape: NON_MEMBER })).toThrow(CHECK_FAILURE);
    expect(() => insertSession({ state: NON_MEMBER })).toThrow(CHECK_FAILURE);
    // A live reading is never a run's outcome.
    expect(() => insertSession({ lastRunOutcome: "running" })).toThrow(CHECK_FAILURE);
  });

  it("admits every execution mode a session's create records, and refuses any other", () => {
    const insertCreateRequest = db.prepare(
      `INSERT INTO session_create_requests
         (client_idempotency_key, session_id, repo_mount_id, execution_mode)
       VALUES (?, ?, ?, ?)`,
    );
    for (const executionMode of membersOf(EXECUTION_MODES)) {
      expect(() =>
        insertCreateRequest.run(newId("key"), newId("session"), MOUNT_ID, executionMode),
      ).not.toThrow();
    }
    expect(() =>
      insertCreateRequest.run(newId("key"), newId("session"), MOUNT_ID, NON_MEMBER),
    ).toThrow(CHECK_FAILURE);
  });

  it("bounds a session's own step limit from below at one, and lets it be unset", () => {
    const insertConsoleState = db.prepare(
      `INSERT INTO session_console_state (session_id, max_steps_per_turn, updated_at)
       VALUES (?, ?, ?)`,
    );
    expect(() => insertConsoleState.run(newId("session"), null, TIMESTAMP)).not.toThrow();
    expect(() => insertConsoleState.run(newId("session"), 1, TIMESTAMP)).not.toThrow();
    expect(() => insertConsoleState.run(newId("session"), 0, TIMESTAMP)).toThrow(CHECK_FAILURE);
  });

  it("admits every link kind with a use count of at least one, and refuses any other", () => {
    const insertLink = db.prepare(
      `INSERT INTO session_links
         (source_session_id, target_session_id, kind, use_count, first_at, last_at)
       VALUES ('session-1', ?, ?, ?, ?, ?)`,
    );
    for (const kind of membersOf(LINK_KINDS)) {
      expect(() => insertLink.run(newId("session"), kind, 1, TIMESTAMP, TIMESTAMP)).not.toThrow();
    }
    expect(() => insertLink.run(newId("session"), NON_MEMBER, 1, TIMESTAMP, TIMESTAMP)).toThrow(
      CHECK_FAILURE,
    );
    expect(() => insertLink.run(newId("session"), "related", 0, TIMESTAMP, TIMESTAMP)).toThrow(
      CHECK_FAILURE,
    );
  });
});
