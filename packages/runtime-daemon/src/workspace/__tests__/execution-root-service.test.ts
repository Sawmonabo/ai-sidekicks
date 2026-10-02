// Proves ExecutionRootService prepares a root only on a writable workspace and the requested
// branch, carries a reused worktree's recorded base branch, refuses a busy or retired candidate,
// records one branch context per mode without writing the workspaces row itself, runs git with
// hooks neutralized, and retires a worktree it created but could not hand over.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionMode, WorkspaceState } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import {
  WorkspaceBranchMismatchError,
  WorkspaceBranchNameRequiredError,
  WorktreeCreateFailedError,
  WorktreeReuseConflictError,
} from "../../git/worktree-errors.js";
import type {
  CreateWorktreeInput,
  CreatedWorktree,
  ReusableWorktreeCandidate,
  ValidateWorktreeReuseInput,
} from "../../git/worktree-service.js";
import { openDatabase } from "../../session/migration-runner.js";
import { ExecutionRootService } from "../execution-root-service.js";
import type {
  ExecutionRootGitRunner,
  ExecutionRootServiceDeps,
  ExecutionRootWorktreeProvisioner,
  WorkspaceLifecyclePrimitives,
} from "../execution-root-service.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import type { FilesystemPathProbeFn } from "../workspace-row-guards.js";
import { WorkspaceBusyError, WorkspaceStaleError } from "../workspace-service-errors.js";
import { WorkspaceService, type SessionExistenceReader } from "../workspace-service.js";

import { captureRejection } from "./workspace.test-support.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Real UUIDs: `deriveWorktreeBranchName` slices the last eight hex digits of the session and run
// ids, so the derived-name assertion is only exact with real ones.
const SESSION_ID: string = "0190fb10-1c2d-7e3f-8a4b-5c6d7e8f9a01";
const REPO_MOUNT_ID: string = "0190fb11-2d3e-7f40-9b5c-6d7e8f9a0b12";
const WORKSPACE_ID: string = "0190fb12-3e4f-7051-8c6d-7e8f9a0b1c23";
const OTHER_WORKSPACE_ID: string = "0190fb13-4f50-7162-9d7e-8f9a0b1c2d34";
const RUN_ID: string = "0190fb14-5061-7273-8e8f-9a0b1c2d3e45";
const SEEDED_WORKTREE_ID: string = "0190fb15-6172-7384-9f90-0b1c2d3e4f56";
const SEEDED_CONTEXT_ID: string = "0190fb16-7283-7495-8a01-1c2d3e4f5067";

const CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-exec-mount";
// A workspace's previous root, the one `beginRootPreparation` releases.
const PRIOR_ROOT: string = "/tmp/ai-sidekicks-fixture-exec-prior-root";
const EXECUTION_ROOTS_DIRECTORY: string = "/tmp/ai-sidekicks-fixture-exec-roots";
// Where the fake provisioner would have placed the seeded worktree.
const SEEDED_WORKTREE_ROOT: string =
  `${EXECUTION_ROOTS_DIRECTORY}/${REPO_MOUNT_ID}/worktrees/` + SEEDED_WORKTREE_ID;

const MAIN_BRANCH: string = "main";
const FEATURE_BRANCH: string = "sidekicks/0190fb10/fix-login";
const SEEDED_BASE_BRANCH: string = "develop";
// `sidekicks/<session-short-8>/run-<run-short-8>`: hyphens are stripped before slicing, so these
// are the last eight hex digits of the UUIDs above.
const DERIVED_RUN_BRANCH: string = "sidekicks/7e8f9a01/run-1c2d3e45";

const EPOCH: string = "2026-08-07T00:00:00.000Z";
// Earlier than the clock, so a seeded row's `created_at` surviving a refresh tells "preserved"
// apart from "replaced by a new row with the same values".
const SEEDED_CONTEXT_STAMP: string = "2026-01-01T00:00:00.000Z";

// ----------------------------------------------------------------------------
// Deterministic identifiers
// ----------------------------------------------------------------------------

let mintedIdCount = 0;

/**
 * A deterministic, real-shaped UUID per call. The version nibble is `7` because
 * `branch_contexts.id` values are compared for identity across a refresh, and an id `mintUuidV7`
 * could not have produced would make that comparison about the fixture, not the upsert.
 */
function mintUuid(): string {
  mintedIdCount += 1;
  return `0190fc00-0000-7000-8000-${mintedIdCount.toString(16).padStart(12, "0")}`;
}

// ----------------------------------------------------------------------------
// The recording fake git
// ----------------------------------------------------------------------------

interface RecordedGitInvocation {
  readonly argv: readonly string[];
}

/**
 * The verb of a recorded invocation, found by skipping leading `-c` and `-C` option pairs, so a
 * change to the option prefix cannot make a fixed index read a directory as the verb.
 */
function gitVerb(argv: readonly string[]): string | undefined {
  let index = 0;
  while (index < argv.length) {
    const token: string | undefined = argv[index];
    if (token === "-c" || token === "-C") {
      index += 2;
      continue;
    }
    return token;
  }
  return undefined;
}

class FakeGit {
  readonly invocations: RecordedGitInvocation[] = [];
  /** The branch the main checkout is on. */
  headBranch: string = MAIN_BRANCH;

  readonly run: ExecutionRootGitRunner = (argv) => {
    this.invocations.push({ argv: [...argv] });
    const verb: string | undefined = gitVerb(argv);

    if (verb === "symbolic-ref") {
      return Promise.resolve({ exitCode: 0, stdout: `${this.headBranch}\n`, stderr: "" });
    }

    return Promise.reject(new Error(`unexpected git verb in fixture: ${String(verb)}`));
  };

  verbs(): readonly (string | undefined)[] {
    return this.invocations.map((invocation) => gitVerb(invocation.argv));
  }
}

/** Records the directories the service asks to exist. */
class RecordingFilesystem {
  readonly createdDirectories: string[] = [];

  createDirectory(path: string): Promise<void> {
    this.createdDirectories.push(path);
    return Promise.resolve();
  }
}

// ----------------------------------------------------------------------------
// The recording mode provisioners
// ----------------------------------------------------------------------------

/**
 * Stands in for the worktree service and writes the `worktrees` row a real create would write.
 * `branch_contexts.worktree_id` references that row, and `validateReuse` answers out of it, so the
 * reuse cases read the same row the service's carry-over read does.
 */
class FakeWorktreeProvisioner implements ExecutionRootWorktreeProvisioner {
  readonly createInputs: CreateWorktreeInput[] = [];
  readonly reuseInputs: ValidateWorktreeReuseInput[] = [];
  /** The ids this fake minted, so compensation can be held to the one it created. */
  readonly createdWorktreeIds: string[] = [];
  /** Worktree ids compensation retired. */
  readonly retiredWorktreeIds: string[] = [];
  /** When set, `create` rejects with it. */
  createFailure: Error | null = null;

  create(input: CreateWorktreeInput): Promise<CreatedWorktree> {
    this.createInputs.push(input);
    if (this.createFailure !== null) {
      return Promise.reject(this.createFailure);
    }
    const worktreeId = mintUuid();
    const fsRoot = `${EXECUTION_ROOTS_DIRECTORY}/${input.repoMountId}/worktrees/${worktreeId}`;
    insertWorktreeRow({ worktreeId, branchName: input.branchName, fsRoot });
    this.createdWorktreeIds.push(worktreeId);
    return Promise.resolve({
      worktreeId,
      repoMountId: input.repoMountId,
      branchName: input.branchName,
      fsRoot,
      baseRef: input.baseRef ?? MAIN_BRANCH,
      state: "ready",
    });
  }

  validateReuse(input: ValidateWorktreeReuseInput): Promise<ReusableWorktreeCandidate> {
    this.reuseInputs.push(input);
    const row = readWorktreeRow(input.worktreeId);
    return Promise.resolve({
      worktreeId: row.id,
      repoMountId: row.repo_mount_id,
      branchName: row.branch_name,
      fsRoot: row.fs_root,
      state: "ready",
      createdBySessionId: row.created_by_session_id,
      createdByRunId: row.created_by_run_id,
      dirty: false,
    });
  }

  retire(worktreeId: string): Promise<unknown> {
    this.retiredWorktreeIds.push(worktreeId);
    return Promise.resolve({ worktreeId, state: "retired" });
  }
}

// ----------------------------------------------------------------------------
// Per-test lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  workspaces: WorkspaceService;
  worktrees: FakeWorktreeProvisioner;
  git: FakeGit;
  /** Paths the injected probe reports unreachable, which stales the workspace. */
  unreachablePaths: Set<string>;
  tmpDir: string;
}

let ctx: TestContext;

function clock(): string {
  return EPOCH;
}

/**
 * The reachability probe, injected so no `ready` fixture needs a directory on disk:
 * `assertWritable` probes `workspaces.fs_root` and stales the row when it does not answer.
 */
const probePath: FilesystemPathProbeFn = (path) =>
  Promise.resolve({
    probedPath: path,
    reachable: !ctx.unreachablePaths.has(path),
    checkedAt: EPOCH,
  });

/** No case here binds; the service still needs a session-existence reader. */
const KNOWN_SESSIONS: SessionExistenceReader = {
  replay: (sessionId) => (sessionId === SESSION_ID ? { sessionId } : null),
};

beforeEach(() => {
  mintedIdCount = 0;
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-execution-root-test-"));
  const db: DatabaseType = openDatabase(join(tmpDir, "test.db"));
  ctx = {
    db,
    workspaces: new WorkspaceService({
      database: db,
      events: new WorkspaceEventEmitter({
        sessionEvents: new EventLogService({
          db,
        }),
      }),
      sessions: KNOWN_SESSIONS,
      probePath,
      now: clock,
    }),
    worktrees: new FakeWorktreeProvisioner(),
    git: new FakeGit(),
    unreachablePaths: new Set<string>(),
    tmpDir,
  };
  insertAttachedMount();
});

afterEach(() => {
  // The per-session append lock is a module singleton; a queue entry left behind would stall the
  // next case on the same session id.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

/** The real primitives, wired as a composition root would. */
function realPrimitives(): WorkspaceLifecyclePrimitives {
  return {
    assertWritable: (workspaceId) => ctx.workspaces.assertWritable(workspaceId),
    beginRootPreparation: (workspaceId, targetMode) =>
      ctx.workspaces.beginRootPreparation(workspaceId, targetMode),
    completeRootPreparation: (workspaceId, fsRoot) =>
      ctx.workspaces.completeRootPreparation(workspaceId, fsRoot),
    failRootPreparation: (workspaceId, detail) =>
      ctx.workspaces.failRootPreparation(workspaceId, detail),
  };
}

function makeService(overrides: Partial<ExecutionRootServiceDeps> = {}): ExecutionRootService {
  return new ExecutionRootService({
    database: ctx.db,
    workspaces: realPrimitives(),
    worktrees: ctx.worktrees,
    executionRootsDirectory: EXECUTION_ROOTS_DIRECTORY,
    git: ctx.git.run,
    filesystem: { createDirectory: () => Promise.resolve() },
    now: clock,
    newBranchContextId: mintUuid,
    ...overrides,
  });
}

// ----------------------------------------------------------------------------
// Row fixtures and reads
// ----------------------------------------------------------------------------

/** The suite's single attached git mount. `vcs_type` takes its `'git'` default. */
function insertAttachedMount(): void {
  ctx.db
    .prepare(
      `INSERT INTO repo_mounts (
         id, node_id, local_path, canonical_root, state, attached_at, updated_at
       ) VALUES (?, 'node-1', ?, ?, 'attached', ?, ?)`,
    )
    .run(REPO_MOUNT_ID, CANONICAL_ROOT, CANONICAL_ROOT, EPOCH, EPOCH);
}

/**
 * Seed a workspace with a raw INSERT: `WorkspaceService.bind` resolves a real directory through
 * the trust envelope, which would put a filesystem dependency on every case.
 */
function insertWorkspace(options: {
  readonly workspaceId?: string;
  readonly executionMode: ExecutionMode;
  readonly state: WorkspaceState;
  readonly fsRoot?: string | null;
}): void {
  ctx.db
    .prepare(
      `INSERT INTO workspaces (
         id, session_id, repo_mount_id, execution_mode, fs_root, state,
         metadata, created_at, updated_at
       ) VALUES (
         @id, @session_id, @repo_mount_id, @execution_mode, @fs_root, @state,
         '{}', @now, @now
       )`,
    )
    .run({
      id: options.workspaceId ?? WORKSPACE_ID,
      session_id: SESSION_ID,
      repo_mount_id: REPO_MOUNT_ID,
      execution_mode: options.executionMode,
      fs_root: options.fsRoot ?? null,
      state: options.state,
      now: EPOCH,
    });
}

function insertWorktreeRow(options: {
  readonly worktreeId: string;
  readonly branchName: string;
  readonly fsRoot: string;
}): void {
  ctx.db
    .prepare(
      `INSERT INTO worktrees (
         id, repo_mount_id, created_by_session_id, created_by_run_id,
         branch_name, fs_root, state, created_at, updated_at
       ) VALUES (
         @id, @repo_mount_id, @session_id, NULL, @branch_name, @fs_root, 'ready', @now, @now
       )`,
    )
    .run({
      id: options.worktreeId,
      repo_mount_id: REPO_MOUNT_ID,
      session_id: SESSION_ID,
      branch_name: options.branchName,
      fs_root: options.fsRoot,
      now: EPOCH,
    });
}

/** Seed a `branch_contexts` row the way an earlier prepare would have left it. */
function insertBranchContext(options: {
  readonly id: string;
  readonly workspaceId: string;
  readonly worktreeId: string | null;
  readonly baseBranch: string;
  readonly headBranch: string;
}): void {
  ctx.db
    .prepare(
      `INSERT INTO branch_contexts (
         id, workspace_id, worktree_id,
         base_branch, head_branch, created_at, updated_at
       ) VALUES (@id, @workspace_id, @worktree_id, @base_branch, @head_branch, @now, @now)`,
    )
    .run({
      id: options.id,
      workspace_id: options.workspaceId,
      worktree_id: options.worktreeId,
      base_branch: options.baseBranch,
      head_branch: options.headBranch,
      now: SEEDED_CONTEXT_STAMP,
    });
}

interface WorktreeTestRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
}

function readWorktreeRow(worktreeId: string): WorktreeTestRow {
  const row = ctx.db
    .prepare<[string], WorktreeTestRow>(
      `SELECT id, repo_mount_id, created_by_session_id, created_by_run_id, branch_name, fs_root
         FROM worktrees WHERE id = ?`,
    )
    .get(worktreeId);
  if (row === undefined) {
    throw new Error(`expected a worktrees row for ${worktreeId}`);
  }
  return row;
}

interface BranchContextTestRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly worktree_id: string | null;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function readBranchContexts(): readonly BranchContextTestRow[] {
  return ctx.db
    .prepare<[], BranchContextTestRow>(
      `SELECT id, workspace_id, worktree_id,
              base_branch, head_branch, created_at, updated_at
         FROM branch_contexts ORDER BY id ASC`,
    )
    .all();
}

function readBranchContext(branchContextId: string): BranchContextTestRow {
  const found = readBranchContexts().find((row) => row.id === branchContextId);
  if (found === undefined) {
    throw new Error(`expected a branch_contexts row for ${branchContextId}`);
  }
  return found;
}

interface WorkspaceTestRow {
  readonly state: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly metadata: string;
  readonly updated_at: string;
}

function readWorkspaceRow(workspaceId: string = WORKSPACE_ID): WorkspaceTestRow {
  const row = ctx.db
    .prepare<
      [string],
      WorkspaceTestRow
    >(`SELECT state, execution_mode, fs_root, metadata, updated_at FROM workspaces WHERE id = ?`)
    .get(workspaceId);
  if (row === undefined) {
    throw new Error(`expected a workspaces row for ${workspaceId}`);
  }
  return row;
}

function readWorkspaceLastError(workspaceId: string = WORKSPACE_ID): string | null {
  const row = ctx.db
    .prepare<
      [string],
      { readonly last_error: string | null }
    >(`SELECT json_extract(metadata, '$.lastError') AS last_error FROM workspaces WHERE id = ?`)
    .get(workspaceId);
  return row?.last_error ?? null;
}

function readEventTypes(): readonly string[] {
  return ctx.db
    .prepare<[string], { readonly type: string }>(
      `SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence ASC`,
    )
    .all(SESSION_ID)
    .map((row) => row.type);
}

describe("mode dispatch", () => {
  it("bound-root mode binds the shared main checkout when it already matches", async () => {
    insertWorkspace({ executionMode: "bound-root", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.headBranch = FEATURE_BRANCH;

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    expect(prepared.executionRoot).toBe(CANONICAL_ROOT);
    expect(prepared.executionMode).toBe("bound-root");
    expect(prepared.branchName).toBe(FEATURE_BRANCH);
    expect(prepared.worktreeId).toBeUndefined();
    expect(prepared.branchContextId).toBeDefined();
    // The one git call is a read of HEAD.
    expect(ctx.git.verbs()).toEqual(["symbolic-ref"]);
    expect(ctx.worktrees.createInputs).toHaveLength(0);
  });

  it("provisioned-worktree mode delegates to and reports the created root", async () => {
    insertWorkspace({ executionMode: "provisioned-worktree", state: "preparing" });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const createInput = ctx.worktrees.createInputs[0];
    expect(ctx.worktrees.createInputs).toHaveLength(1);
    expect(createInput?.repoMountId).toBe(REPO_MOUNT_ID);
    expect(createInput?.sessionId).toBe(SESSION_ID);
    expect(createInput?.branchName).toBe(FEATURE_BRANCH);
    expect(createInput?.onCollision).toBe("refuse");

    expect(prepared.executionMode).toBe("provisioned-worktree");
    expect(prepared.worktreeId).toBeDefined();
    expect(prepared.executionRoot).toBe(readWorktreeRow(prepared.worktreeId ?? "").fs_root);
    expect(ctx.git.invocations).toHaveLength(0);
  });
});

// ============================================================================
// Refusals that fire before the workspace is committed
// ============================================================================

describe("pre-bracket refusals", () => {
  it("refuses a stale workspace before any git call", async () => {
    // `bound-root` is the only mode that calls git, so "before any git call" has content here
    // and is vacuous elsewhere.
    insertWorkspace({ executionMode: "bound-root", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.unreachablePaths.add(PRIOR_ROOT);

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceStaleError);
    expect(ctx.git.invocations).toHaveLength(0);
    expect(readBranchContexts()).toHaveLength(0);
  });

  it("refuses a bound-root branch mismatch without mutating the checkout", async () => {
    insertWorkspace({ executionMode: "bound-root", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.headBranch = MAIN_BRANCH;

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceBranchMismatchError);
    // Both names, because the comparison is the repair: a caller told only that the branches
    // disagree cannot tell which side to move.
    expect(rejection).toMatchObject({
      workspaceId: WORKSPACE_ID,
      requestedBranchName: FEATURE_BRANCH,
      currentBranchName: MAIN_BRANCH,
    });

    // The only invocation was the read; a `switch` or `checkout` here would be the mutation.
    expect(ctx.git.verbs()).toEqual(["symbolic-ref"]);

    const row = readWorkspaceRow();
    expect(row.state).toBe("ready");
    expect(row.fs_root).toBe(PRIOR_ROOT);
    expect(readEventTypes()).toEqual([]);
    expect(readBranchContexts()).toHaveLength(0);
  });

  it("refuses a prepare carrying neither branchName nor runId, before any git call", async () => {
    insertWorkspace({ executionMode: "bound-root", state: "ready", fsRoot: PRIOR_ROOT });

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID }),
    );

    // Only the run-setup gate supplies a run id, so a prepare from the wire must name the branch.
    expect(rejection).toBeInstanceOf(WorkspaceBranchNameRequiredError);
    expect(ctx.git.invocations).toHaveLength(0);
    expect(ctx.worktrees.createInputs).toHaveLength(0);
    expect(readEventTypes()).toEqual([]);
  });
});

describe("branch-name resolution", () => {
  it("derives the run-<short-8> fallback and hands the mode service an explicit name", async () => {
    insertWorkspace({ executionMode: "provisioned-worktree", state: "preparing" });

    const prepared = await makeService().prepare({ workspaceId: WORKSPACE_ID, runId: RUN_ID });

    // The delegated service receives a resolved name; it holds no slug-rule inputs of its own.
    expect(ctx.worktrees.createInputs[0]?.branchName).toBe(DERIVED_RUN_BRANCH);
    expect(ctx.worktrees.createInputs[0]?.runId).toBe(RUN_ID);
    expect(prepared.branchName).toBe(DERIVED_RUN_BRANCH);
    expect(readBranchContext(prepared.branchContextId).head_branch).toBe(DERIVED_RUN_BRANCH);
  });
});

// ============================================================================
// Explicit reuse and the `branch_contexts` pair keying
// ============================================================================

describe("explicit worktree reuse", () => {
  it("scopes a cross-workspace bind to a fresh row, leaving the candidate's alone", async () => {
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: SEEDED_WORKTREE_ROOT,
    });
    // The candidate's workspace and its context row: the provenance the reuse carries a base
    // branch from.
    insertWorkspace({ executionMode: "provisioned-worktree", state: "ready", fsRoot: PRIOR_ROOT });
    insertBranchContext({
      id: SEEDED_CONTEXT_ID,
      workspaceId: WORKSPACE_ID,
      worktreeId: SEEDED_WORKTREE_ID,
      baseBranch: SEEDED_BASE_BRANCH,
      headBranch: FEATURE_BRANCH,
    });
    const candidateRowBefore = readBranchContext(SEEDED_CONTEXT_ID);

    insertWorkspace({
      workspaceId: OTHER_WORKSPACE_ID,
      executionMode: "provisioned-worktree",
      state: "preparing",
    });
    const prepared = await makeService().prepare({
      workspaceId: OTHER_WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      reuseWorktreeId: SEEDED_WORKTREE_ID,
    });

    // The worktree service checks mount consistency, so it must receive the binding workspace's
    // mount.
    expect(ctx.worktrees.reuseInputs[0]?.repoMountId).toBe(REPO_MOUNT_ID);

    const rows = readBranchContexts();
    expect(rows).toHaveLength(2);

    const boundRow = readBranchContext(prepared.branchContextId);
    expect(boundRow.id).not.toBe(SEEDED_CONTEXT_ID);
    expect(boundRow.workspace_id).toBe(OTHER_WORKSPACE_ID);
    expect(boundRow.worktree_id).toBe(SEEDED_WORKTREE_ID);
    // Carried over, not invented: the daemon cannot re-derive the branch the worktree was cut
    // from.
    expect(boundRow.base_branch).toBe(SEEDED_BASE_BRANCH);
    expect(boundRow.head_branch).toBe(FEATURE_BRANCH);

    // Untouched in every column, `updated_at` included; a bumped stamp would mean the write
    // reached another workspace's row.
    expect(readBranchContext(SEEDED_CONTEXT_ID)).toEqual(candidateRowBefore);
  });

  it("refreshes the pair row when a workspace re-binds a worktree it created", async () => {
    insertWorkspace({ executionMode: "provisioned-worktree", state: "preparing" });
    const service = makeService();

    // Create writes the pair row; a later reuse must find it rather than duplicate it.
    const created = await service.prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      baseRef: SEEDED_BASE_BRANCH,
    });
    expect(readBranchContexts()).toHaveLength(1);

    // A second prepare on the same workspace, naming the worktree it just made. The first
    // prepare's `completeRootPreparation` already left the row `ready` on that root, which is the
    // state a real re-bind starts from.
    const rebound = await service.prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      reuseWorktreeId: created.worktreeId ?? "",
    });

    // The partial-unique `(worktree_id, workspace_id)` index holds: one row, the same one.
    expect(readBranchContexts()).toHaveLength(1);
    expect(rebound.branchContextId).toBe(created.branchContextId);
    expect(readBranchContext(rebound.branchContextId).base_branch).toBe(SEEDED_BASE_BRANCH);
  });

  it("refuses a candidate whose directory a busy workspace holds, before the bracket", async () => {
    // The candidate's own workspace is busy in that directory and a second workspace asks to
    // bind the same working tree. The refusal must name the holder and fire before the bracket:
    // routed through the materialization catch, it would stale the requester over someone else's
    // live run.
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: SEEDED_WORKTREE_ROOT,
    });
    // The holder: the candidate's own workspace, busy in the candidate's root.
    insertWorkspace({
      executionMode: "provisioned-worktree",
      state: "busy",
      fsRoot: SEEDED_WORKTREE_ROOT,
    });
    insertBranchContext({
      id: SEEDED_CONTEXT_ID,
      workspaceId: WORKSPACE_ID,
      worktreeId: SEEDED_WORKTREE_ID,
      baseBranch: SEEDED_BASE_BRANCH,
      headBranch: FEATURE_BRANCH,
    });
    insertWorkspace({
      workspaceId: OTHER_WORKSPACE_ID,
      executionMode: "provisioned-worktree",
      state: "preparing",
    });

    const rejection = await captureRejection(() =>
      makeService().prepare({
        workspaceId: OTHER_WORKSPACE_ID,
        branchName: FEATURE_BRANCH,
        reuseWorktreeId: SEEDED_WORKTREE_ID,
      }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceBusyError);
    // The holder's id, not the requester's: what the caller must wait on.
    expect(rejection).toMatchObject({ workspaceId: WORKSPACE_ID });
    // Before the bracket: `validateReuse` was never consulted, no second pair row landed, and
    // the requester's row is unchanged.
    expect(ctx.worktrees.reuseInputs).toHaveLength(0);
    expect(readBranchContexts()).toHaveLength(1);
    const requesterState = ctx.db
      .prepare<[string], { state: string }>(`SELECT state FROM workspaces WHERE id = ?`)
      .get(OTHER_WORKSPACE_ID);
    expect(requesterState?.state).toBe("preparing");
  });

  it("refuses a candidate retired during validation, at the context write", async () => {
    // `validateReuse` decides across an await (its cleanliness probe spawns git), so a
    // retirement can commit between its verdict and the context write, leaving the bound
    // execution root a directory the sweep may delete under the adopting workspace. The bind-time
    // re-check runs in the same synchronous block as the upsert and refuses.
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: SEEDED_WORKTREE_ROOT,
    });
    insertWorkspace({ executionMode: "provisioned-worktree", state: "preparing" });
    insertBranchContext({
      id: SEEDED_CONTEXT_ID,
      workspaceId: WORKSPACE_ID,
      worktreeId: SEEDED_WORKTREE_ID,
      baseBranch: SEEDED_BASE_BRANCH,
      headBranch: FEATURE_BRANCH,
    });
    // Makes the race deterministic: the retirement lands on the shared connection while the
    // validation verdict is in flight.
    class RetireInjectingProvisioner extends FakeWorktreeProvisioner {
      override validateReuse(
        input: ValidateWorktreeReuseInput,
      ): Promise<ReusableWorktreeCandidate> {
        const verdict = super.validateReuse(input);
        ctx.db.prepare(`UPDATE worktrees SET state = 'retired' WHERE id = ?`).run(input.worktreeId);
        return verdict;
      }
    }

    const rejection = await captureRejection(() =>
      makeService({ worktrees: new RetireInjectingProvisioner() }).prepare({
        workspaceId: WORKSPACE_ID,
        branchName: FEATURE_BRANCH,
        reuseWorktreeId: SEEDED_WORKTREE_ID,
      }),
    );

    expect(rejection).toBeInstanceOf(WorktreeReuseConflictError);
    expect(rejection).toMatchObject({ code: "worktree.reuse_conflict", reason: "not_live" });
    // The refused bind landed nothing: only the seeded row, unchanged.
    expect(readBranchContexts()).toHaveLength(1);
    expect(readBranchContext(SEEDED_CONTEXT_ID).updated_at).toBe(SEEDED_CONTEXT_STAMP);
    // After the bracket opened, so the workspace parks `stale` with the detail rather than
    // adopting a doomed root.
    expect(readWorkspaceRow().state).toBe("stale");
  });

  it("preserves a same-workspace candidate's existing row without duplication", async () => {
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: SEEDED_WORKTREE_ROOT,
    });
    insertWorkspace({ executionMode: "provisioned-worktree", state: "ready", fsRoot: PRIOR_ROOT });
    insertBranchContext({
      id: SEEDED_CONTEXT_ID,
      workspaceId: WORKSPACE_ID,
      worktreeId: SEEDED_WORKTREE_ID,
      baseBranch: SEEDED_BASE_BRANCH,
      headBranch: FEATURE_BRANCH,
    });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      reuseWorktreeId: SEEDED_WORKTREE_ID,
    });

    const rows = readBranchContexts();
    expect(rows).toHaveLength(1);
    // Preserved (same identity, same provenance), not replaced by a new row with the same values.
    expect(prepared.branchContextId).toBe(SEEDED_CONTEXT_ID);
    expect(rows[0]?.base_branch).toBe(SEEDED_BASE_BRANCH);
    expect(rows[0]?.created_at).toBe(SEEDED_CONTEXT_STAMP);
  });
});

describe("branch_contexts polymorphism", () => {
  it("writes a worktree-referencing row for provisioned-worktree mode", async () => {
    insertWorkspace({ executionMode: "provisioned-worktree", state: "preparing" });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const row = readBranchContext(prepared.branchContextId);
    expect(row.worktree_id).toBe(prepared.worktreeId);
  });

  it("writes a root-less row for bound-root mode, one per prepare", async () => {
    insertWorkspace({ executionMode: "bound-root", state: "preparing" });
    ctx.git.headBranch = FEATURE_BRANCH;
    const service = makeService();

    const first = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH });
    const row = readBranchContext(first.branchContextId);
    // The main checkout has no root row, so the context references no worktree.
    expect(row.worktree_id).toBeNull();

    // A second bound-root prepare accumulates a row. Nothing needs a workspace-scoped "current
    // row": a run reaches its row through `run_execution_contexts.branch_context_id`. Refreshing
    // in place would destroy the previous binding's recorded branches, which differ once the user
    // moves the shared checkout.
    ctx.git.headBranch = MAIN_BRANCH;
    const second = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: MAIN_BRANCH });

    expect(readBranchContexts()).toHaveLength(2);
    expect(second.branchContextId).not.toBe(first.branchContextId);
    expect(readBranchContext(first.branchContextId).head_branch).toBe(FEATURE_BRANCH);
    expect(readBranchContext(second.branchContextId).head_branch).toBe(MAIN_BRANCH);
  });
});

describe("no raw workspaces write", () => {
  it("leaves the workspaces row byte-identical when the primitives are stubbed out", async () => {
    // With the primitives replaced by recording no-ops, any change to the row could only come
    // from this module's own SQL, so an unchanged row is a direct observation.
    insertWorkspace({ executionMode: "provisioned-worktree", state: "preparing" });
    const before = readWorkspaceRow();

    const calls: string[] = [];
    const stubbed: WorkspaceLifecyclePrimitives = {
      assertWritable: (workspaceId) => {
        calls.push(`assertWritable:${workspaceId}`);
        return Promise.resolve();
      },
      beginRootPreparation: (workspaceId) => {
        calls.push(`beginRootPreparation:${workspaceId}`);
        return Promise.resolve();
      },
      completeRootPreparation: (workspaceId, fsRoot) => {
        calls.push(`completeRootPreparation:${workspaceId}:${fsRoot}`);
        return Promise.resolve();
      },
      failRootPreparation: (workspaceId) => {
        calls.push(`failRootPreparation:${workspaceId}`);
        return Promise.resolve();
      },
    };

    const prepared = await makeService({ workspaces: stubbed }).prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    // The service did the work; otherwise "the row is unchanged" would hold for a service that
    // did nothing.
    expect(prepared.executionRoot).toContain("/worktrees/");
    expect(readBranchContexts()).toHaveLength(1);
    // It asked the primitive to adopt the root rather than writing it.
    expect(calls).toEqual([`completeRootPreparation:${WORKSPACE_ID}:${prepared.executionRoot}`]);
    expect(readWorkspaceRow()).toEqual(before);
    expect(readEventTypes()).toEqual([]);
  });
});

const HOOK_NEUTRALIZATION_DIRECTORY: string = join(
  EXECUTION_ROOTS_DIRECTORY,
  ".hook-neutralization",
);

describe("git invocation", () => {
  it("neutralizes hooks on its one invocation, and creates that directory first", async () => {
    insertWorkspace({ executionMode: "bound-root", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.headBranch = FEATURE_BRANCH;
    const filesystem = new RecordingFilesystem();

    await makeService({ filesystem }).prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const invocation = ctx.git.invocations[0];
    expect(ctx.git.invocations).toHaveLength(1);
    // First in the argv, so it wins: a command-line `-c` outranks repository, global and system
    // config, so a repo-local `core.hooksPath` or `core.fsmonitor` cannot take either back.
    expect(invocation?.argv.slice(0, 4)).toEqual([
      "-c",
      `core.hooksPath=${HOOK_NEUTRALIZATION_DIRECTORY}`,
      "-c",
      "core.fsmonitor=false",
    ]);
    // The directory must exist: git ignores a `core.hooksPath` that does not resolve, which would
    // silently restore the hooks this flag disables.
    expect(filesystem.createdDirectories).toEqual([HOOK_NEUTRALIZATION_DIRECTORY]);
  });
});

describe("the reprovision bracket", () => {
  it("completes reprovision with the prepared root", async () => {
    insertWorkspace({ executionMode: "provisioned-worktree", state: "ready", fsRoot: PRIOR_ROOT });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const row = readWorkspaceRow();
    expect(row.state).toBe("ready");
    // The prepared root, not the one the workspace arrived with.
    expect(row.fs_root).toBe(prepared.executionRoot);
    expect(row.fs_root).not.toBe(PRIOR_ROOT);
    expect(prepared.state).toBe("ready");
    // The bracket rides the primitives, which is what puts these on the timeline; a raw row
    // write would produce neither.
    expect(readEventTypes()).toEqual(["workspace.preparing", "workspace.ready"]);
  });

  it("fail-reprovisions on a materialization failure and records the detail", async () => {
    insertWorkspace({ executionMode: "provisioned-worktree", state: "ready", fsRoot: PRIOR_ROOT });
    const failure = new WorktreeCreateFailedError("base_ref_unresolved");
    ctx.worktrees.createFailure = failure;

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    // The original typed cause reaches the caller; the run-setup gate wraps it by code.
    expect(rejection).toBe(failure);

    // The run blocks in setup rather than degrading.
    const row = readWorkspaceRow();
    expect(row.state).toBe("stale");
    expect(row.fs_root).toBeNull();
    expect(readWorkspaceLastError()).toContain("worktree.create_failed");
    expect(readEventTypes()).toEqual(["workspace.preparing", "workspace.stale"]);
    // Nothing half-written: the branch context is on the same side of the failure.
    expect(readBranchContexts()).toHaveLength(0);
  });
});

// ============================================================================
// Compensation for a root nothing will adopt
// ============================================================================

describe("compensation", () => {
  /** The real primitives, except that closing the bracket fails. */
  function primitivesFailingCompletion(failure: Error): WorkspaceLifecyclePrimitives {
    return {
      ...realPrimitives(),
      completeRootPreparation: (): Promise<void> => Promise.reject(failure),
    };
  }

  const COMPLETION_FAILURE_MESSAGE = "completeRootPreparation could not reach the database";

  it("retires a worktree this call created, and first removes the row binding it", async () => {
    // Without compensation this leaks permanently: the sweep retires worktrees whose mount
    // detached and cleans rows already `retired`, and an orphan on an attached mount is in
    // neither set.
    insertWorkspace({ executionMode: "provisioned-worktree", state: "preparing" });
    const failure = new Error(COMPLETION_FAILURE_MESSAGE);

    const rejection = await captureRejection(() =>
      makeService({ workspaces: primitivesFailingCompletion(failure) }).prepare({
        workspaceId: WORKSPACE_ID,
        branchName: FEATURE_BRANCH,
      }),
    );

    expect(rejection).toBe(failure);
    // The row is deleted because it records a handover that never happened. Retirement does not
    // read it; its busy probe joins `workspaces` on `fs_root`.
    expect(readBranchContexts()).toHaveLength(0);
    // Compared with the id this call minted, not a row count: a count would also pass if
    // compensation had retired someone else's root.
    expect(ctx.worktrees.retiredWorktreeIds).toEqual(ctx.worktrees.createdWorktreeIds);
    expect(ctx.worktrees.createdWorktreeIds).toHaveLength(1);
  });

  it("leaves a REUSED worktree and its existing row untouched", async () => {
    // The gate that makes compensation safe. Other workspaces may be bound to a pre-existing
    // worktree, and its `branch_contexts` row was updated rather than inserted, so retiring or
    // deleting either would destroy state this call never created.
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: SEEDED_WORKTREE_ROOT,
    });
    insertWorkspace({ executionMode: "provisioned-worktree", state: "preparing" });
    insertBranchContext({
      id: SEEDED_CONTEXT_ID,
      workspaceId: WORKSPACE_ID,
      worktreeId: SEEDED_WORKTREE_ID,
      baseBranch: SEEDED_BASE_BRANCH,
      headBranch: FEATURE_BRANCH,
    });
    const failure = new Error(COMPLETION_FAILURE_MESSAGE);

    const rejection = await captureRejection(() =>
      makeService({ workspaces: primitivesFailingCompletion(failure) }).prepare({
        workspaceId: WORKSPACE_ID,
        branchName: FEATURE_BRANCH,
        reuseWorktreeId: SEEDED_WORKTREE_ID,
      }),
    );

    expect(rejection).toBe(failure);
    expect(ctx.worktrees.retiredWorktreeIds).toEqual([]);
    expect(readBranchContexts()).toHaveLength(1);
    expect(readBranchContext(SEEDED_CONTEXT_ID).base_branch).toBe(SEEDED_BASE_BRANCH);
  });
});
