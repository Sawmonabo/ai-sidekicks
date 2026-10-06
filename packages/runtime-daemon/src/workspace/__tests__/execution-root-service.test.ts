// Proves ExecutionRootService prepares a root only on a writable workspace and the requested
// branch, never rewrites another workspace's or an earlier run's branch context, runs git with
// hooks neutralized, and retires a worktree it created but could not hand over.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionMode, WorkspaceState } from "@ai-sidekicks/contracts/repo/mount";

import { EventLogService } from "../../events/log-service.js";
import {
  WorkspaceBranchMismatchError,
  WorkspaceBranchNameRequiredError,
  WorktreeCreateFailedError,
} from "../../git/worktree/errors.js";
import type { CreateWorktreeInput, CreatedWorktree } from "../../git/worktree/service.js";
import { openDatabase } from "../../session/migration-runner.js";
import { ExecutionRootService } from "../execution-root-service.js";
import type { GitRunner } from "../../git/process.js";
import type {
  ExecutionRootServiceDeps,
  ExecutionRootWorktreeProvisioner,
  WorkspaceLifecyclePrimitives,
} from "../execution-root-service.js";
import { WorkspaceEventEmitter } from "../event-emitter.js";
import type { FilesystemPathProbeFn } from "../row-guards.js";
import { WorkspaceStaleError } from "../errors.js";
import { WorkspaceService, type SessionExistenceReader } from "../service.js";

import { requireWorkspaceRow } from "../__fixtures__/rows.js";
import { captureRejection } from "../../__fixtures__/capture-failure.js";

// Real UUIDs: `deriveWorktreeBranchName` slices the last eight hex digits of the session and run
// ids, so the derived-name assertion is only exact with real ones.
const SESSION_ID: string = "0190fb10-1c2d-7e3f-8a4b-5c6d7e8f9a01";
const REPO_MOUNT_ID: string = "0190fb11-2d3e-7f40-9b5c-6d7e8f9a0b12";
const WORKSPACE_ID: string = "0190fb12-3e4f-7051-8c6d-7e8f9a0b1c23";
const RUN_ID: string = "0190fb14-5061-7273-8e8f-9a0b1c2d3e45";

const CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-exec-mount";
// A workspace's previous root, the one `beginRootPreparation` releases.
const PRIOR_ROOT: string = "/tmp/ai-sidekicks-fixture-exec-prior-root";
const EXECUTION_ROOTS_DIRECTORY: string = "/tmp/ai-sidekicks-fixture-exec-roots";

const MAIN_BRANCH: string = "main";
const FEATURE_BRANCH: string = "sidekicks/0190fb10/fix-login";
// `sidekicks/<session-short-8>/run-<run-short-8>`: hyphens are stripped before slicing, so these
// are the last eight hex digits of the UUIDs above.
const DERIVED_RUN_BRANCH: string = "sidekicks/7e8f9a01/run-1c2d3e45";

const EPOCH: string = "2026-08-07T00:00:00.000Z";

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

  readonly run: GitRunner = (argv) => {
    this.invocations.push({ argv: [...argv] });
    const verb: string | undefined = gitVerb(argv);

    if (verb === "symbolic-ref") {
      return Promise.resolve({ stdout: Buffer.from(`${this.headBranch}\n`, "utf8"), stderr: "" });
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

/**
 * Stands in for the worktree service and writes the `worktrees` row a real create would write,
 * because `branch_contexts.worktree_id` references that row.
 */
class FakeWorktreeProvisioner implements ExecutionRootWorktreeProvisioner {
  readonly createInputs: CreateWorktreeInput[] = [];
  /** The ids this fake minted, so compensation can be held to the one it created. */
  readonly createdWorktreeIds: string[] = [];
  /** Worktree ids compensation retired. */
  readonly retiredWorktreeIds: string[] = [];
  /** When set, `create` rejects with it. */
  createFailure: Error | null = null;
  /** When set, `retire` rejects with it. */
  retireFailure: Error | null = null;

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

  retire(worktreeId: string): Promise<unknown> {
    if (this.retireFailure !== null) {
      return Promise.reject(this.retireFailure);
    }
    this.retiredWorktreeIds.push(worktreeId);
    return Promise.resolve({ worktreeId, state: "retired" });
  }
}

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
  rebuildSession: (sessionId) => (sessionId === SESSION_ID ? { sessionId } : null),
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

function readWorktreeRow(worktreeId: string): { readonly fs_root: string } {
  const row = ctx.db
    .prepare<[string], { fs_root: string }>(`SELECT fs_root FROM worktrees WHERE id = ?`)
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

describe("prepare", () => {
  it("provisions a worktree on the derived run branch and adopts it", async () => {
    insertWorkspace({ executionMode: "provisioned-worktree", state: "ready", fsRoot: PRIOR_ROOT });

    const prepared = await makeService().prepare({ workspaceId: WORKSPACE_ID, runId: RUN_ID });

    // A create that clobbered an existing branch would destroy someone's work.
    expect(ctx.worktrees.createInputs).toEqual([
      expect.objectContaining({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        branchName: DERIVED_RUN_BRANCH,
        onCollision: "refuse",
      }),
    ]);
    expect(prepared.branchName).toBe(DERIVED_RUN_BRANCH);
    expect(prepared.executionRoot).toBe(readWorktreeRow(prepared.worktreeId ?? "").fs_root);

    const row = requireWorkspaceRow(ctx.db, WORKSPACE_ID);
    expect(row.state).toBe("ready");
    expect(row.fs_root).toBe(prepared.executionRoot);
    // The bracket rides the primitives, which is what puts these in the session's event log.
    expect(readEventTypes()).toEqual(["workspace.preparing", "workspace.ready"]);

    const context = readBranchContext(prepared.branchContextId);
    expect(context.worktree_id).toBe(prepared.worktreeId);
    expect(context.head_branch).toBe(DERIVED_RUN_BRANCH);
  });

  it("binds the main checkout and keeps every earlier binding's branches", async () => {
    insertWorkspace({ executionMode: "bound-root", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.headBranch = FEATURE_BRANCH;
    const service = makeService();

    const first = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH });
    expect(first.executionRoot).toBe(CANONICAL_ROOT);
    expect(first.worktreeId).toBeUndefined();
    expect(ctx.worktrees.createInputs).toHaveLength(0);
    // The main checkout has no root row, so the context references no worktree.
    expect(readBranchContext(first.branchContextId).worktree_id).toBeNull();

    // A run reaches its row through `run_execution_contexts.branch_context_id`, so refreshing in
    // place would rewrite the branches an earlier run recorded once the user moves the checkout.
    ctx.git.headBranch = MAIN_BRANCH;
    const second = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: MAIN_BRANCH });

    expect(readBranchContexts()).toHaveLength(2);
    expect(readBranchContext(first.branchContextId).head_branch).toBe(FEATURE_BRANCH);
    expect(readBranchContext(second.branchContextId).head_branch).toBe(MAIN_BRANCH);
  });
});

describe("refusals before the workspace is committed", () => {
  it.each([
    {
      refusal: "a stale workspace",
      branchName: FEATURE_BRANCH as string | undefined,
      unreachable: true,
      error: WorkspaceStaleError,
      stateAfter: "stale",
    },
    {
      // Only the run-setup gate supplies a run id, so a prepare from the wire must name a branch.
      refusal: "a prepare naming neither a branch nor a run",
      branchName: undefined,
      unreachable: false,
      error: WorkspaceBranchNameRequiredError,
      stateAfter: "ready",
    },
  ])("refuses $refusal before any git call", async (refusalCase) => {
    insertWorkspace({ executionMode: "bound-root", state: "ready", fsRoot: PRIOR_ROOT });
    if (refusalCase.unreachable) {
      ctx.unreachablePaths.add(PRIOR_ROOT);
    }

    const rejection = await captureRejection(() =>
      makeService().prepare({
        workspaceId: WORKSPACE_ID,
        ...(refusalCase.branchName === undefined ? {} : { branchName: refusalCase.branchName }),
      }),
    );

    expect(rejection).toBeInstanceOf(refusalCase.error);
    expect(ctx.git.invocations).toHaveLength(0);
    expect(ctx.worktrees.createInputs).toHaveLength(0);
    expect(readBranchContexts()).toHaveLength(0);
    expect(requireWorkspaceRow(ctx.db, WORKSPACE_ID).state).toBe(refusalCase.stateAfter);
  });

  it("refuses a bound-root branch mismatch without mutating the checkout", async () => {
    insertWorkspace({ executionMode: "bound-root", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.headBranch = MAIN_BRANCH;

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceBranchMismatchError);
    // Both names, because a caller told only that the branches disagree cannot tell which side
    // to move.
    expect(rejection).toMatchObject({
      workspaceId: WORKSPACE_ID,
      requestedBranchName: FEATURE_BRANCH,
      currentBranchName: MAIN_BRANCH,
    });
    // The only invocation was the read; a `switch` or `checkout` here would be the mutation.
    expect(ctx.git.verbs()).toEqual(["symbolic-ref"]);

    const row = requireWorkspaceRow(ctx.db, WORKSPACE_ID);
    expect(row.state).toBe("ready");
    expect(row.fs_root).toBe(PRIOR_ROOT);
    expect(readEventTypes()).toEqual([]);
    expect(readBranchContexts()).toHaveLength(0);
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

describe("a failed preparation", () => {
  /** The real primitives, except that closing the bracket fails. */
  function primitivesFailingCompletion(failure: Error): WorkspaceLifecyclePrimitives {
    return {
      ...realPrimitives(),
      completeRootPreparation: (): Promise<void> => Promise.reject(failure),
    };
  }

  it("parks the workspace stale with the detail when materialization fails", async () => {
    insertWorkspace({ executionMode: "provisioned-worktree", state: "ready", fsRoot: PRIOR_ROOT });
    const failure = new WorktreeCreateFailedError("base_ref_unresolved");
    ctx.worktrees.createFailure = failure;

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    // The original typed cause reaches the caller; the run-setup gate wraps it by code.
    expect(rejection).toBe(failure);
    // The run blocks in setup rather than degrading.
    const row = requireWorkspaceRow(ctx.db, WORKSPACE_ID);
    expect(row.state).toBe("stale");
    expect(row.fs_root).toBeNull();
    expect(readWorkspaceLastError()).toContain("worktree.create_failed");
    expect(readEventTypes()).toEqual(["workspace.preparing", "workspace.stale"]);
    expect(readBranchContexts()).toHaveLength(0);
  });

  it.each([
    { retire: "succeeds", retireFailure: null },
    { retire: "fails", retireFailure: new Error("retire could not reach the database") },
  ])(
    "retires a worktree it created but could not hand over, when the retire $retire",
    async ({ retireFailure }) => {
      // Without compensation the orphan leaks: the sweep only retires worktrees whose mount
      // detached and cleans rows already `retired`.
      insertWorkspace({ executionMode: "provisioned-worktree", state: "preparing" });
      const failure = new Error("completeRootPreparation could not reach the database");
      ctx.worktrees.retireFailure = retireFailure;

      const rejection = await captureRejection(() =>
        makeService({ workspaces: primitivesFailingCompletion(failure) }).prepare({
          workspaceId: WORKSPACE_ID,
          branchName: FEATURE_BRANCH,
        }),
      );

      // The completion failure is what is thrown, so its code reaches the caller.
      expect(rejection).toBe(failure);
      // The row records a handover that never happened.
      expect(readBranchContexts()).toHaveLength(0);
      expect(ctx.worktrees.createdWorktreeIds).toHaveLength(1);
      if (retireFailure === null) {
        // Compared with the id this call minted, so retiring someone else's root would fail.
        expect(ctx.worktrees.retiredWorktreeIds).toEqual(ctx.worktrees.createdWorktreeIds);
      } else {
        // A dropped retire failure would hide a live worktree that nothing reclaims.
        expect(failure.cause).toBe(retireFailure);
      }
    },
  );
});
