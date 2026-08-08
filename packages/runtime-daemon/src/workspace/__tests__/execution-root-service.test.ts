// ExecutionRootService — Plan-010 Phase 2, T2.4.
//
// Drives the real service over a real test SQLite database (the same lifecycle
// as the T2.1-T2.3 suites: `openDatabase` factory -> per-test tmp file ->
// `afterEach` close + remove), against the REAL Plan-009 `WorkspaceService` and
// RECORDING fakes for the two provisioners below this seam.
//
// Three harness choices carry the evidential weight:
//
//   * The Plan-009 primitives are REAL. Every claim about the reprovision
//     bracket is a claim about what `beginReprovision` / `completeReprovision` /
//     `failReprovision` actually do to a row and to the timeline, and only the
//     real service can be wrong about that. A stub would let this suite agree
//     with itself about a bracket that does not exist.
//   * The mode provisioners are FAKES that write REAL rows. `branch_contexts`
//     carries foreign keys to `worktrees` and `ephemeral_clones`, so a fake that
//     returned an id without a row would make every polymorphism assertion below
//     an assertion about an unconstrained column.
//   * The fake git RECORDS argv and REJECTS unknown verbs. argv is the whole
//     invocation (the seam takes no `cwd`), so a recorded argv is the complete
//     claim about what git was asked to do — which is what makes "refuses BEFORE
//     any git call" and "never mutates the main checkout" assertable rather than
//     asserted. A fixture that shrugged at an unknown verb would let a new git
//     call into the service with no case noticing.
//
// Coverage map (the cites are the contract, not just the ACs):
//   * `Spec-010 §Required Behavior` — dispatch is on the workspace's ONE selected mode.
//   * `Spec-010 §Required Behavior` — `branch` mode overrides onto the EXISTING checkout.
//   * `Spec-010 §Required Behavior` — no arm falls back to the main checkout; failures refuse.
//   * `Spec-010 §Fallback Behavior` — a failed materialization blocks the run in setup
//     (`stale` + `lastError`), and the original typed cause reaches the caller.
//   * `Spec-010 §Fallback Behavior` — a stale workspace refuses, before any process is spawned,
//     and the read-only arm drives the SAME gate so that a vanished root is
//     recorded rather than only refused.
//   * `Spec-010 §State And Data Implications` — the branch context is
//     persisted per WRITABLE mode, and its shape is polymorphic in which root
//     it names.
//   * `Spec-010 §Resolved Questions and V1 Scope Decisions` — `branch`-mode
//     bind-only verification, and its refusal.
//
// Verifies invariant: I-010-5 (one row, at most one root id — all four modes),
// I-010-6 (the branch-mode arm's only git call is a read, and a mismatch leaves
// the checkout and the row untouched), I-010-7 (each mode returns ITS root; no
// arm substitutes another), I-010-10 (the neutralizing `-c core.hooksPath` pair
// leads the argv, and the directory it names is created first), I-010-11
// (asserted twice: a source scan with its own negative control, AND a full
// prepare with the primitives stubbed out leaving the `workspaces` row
// byte-identical), I-010-12 (the gate precedes every writable prepare that finds
// the CP-010-2 bracket closed, and precedes every git call).
//
// Two areas here are about what happens when a step that CANNOT be refused fails
// anyway. `git invocation` pins the split between an answer (a detached HEAD,
// which exits 1 quietly) and an infrastructure fault (exit 128, or a process that
// never ran) — the collapse of those two was reporting unreadable repositories to
// callers as branch disagreements. `compensation` pins the undo for a root that
// was materialized and then could not be handed over, which nothing else reclaims:
// T2.2's sweep retires worktrees whose MOUNT detached and cleans rows already
// retired, and an orphan on an attached mount is in neither set.
//
// Also pinned here, each as a negative control for a neighbouring claim: a
// supplied `branchName` is NOT re-derived (without which "the fallback fired"
// does not discriminate), an empty `runId` does not unlock the fallback, and a
// first bind does not double-begin.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionMode, SessionId, WorkspaceState } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import type {
  PrepareEphemeralCloneInput,
  PreparedEphemeralClone,
} from "../../git/ephemeral-clone-service.js";
import {
  WorkspaceBranchMismatchError,
  WorkspaceBranchNameRequiredError,
  WorktreeCreateFailedError,
} from "../../git/worktree-errors.js";
import type {
  CreateWorktreeInput,
  CreatedWorktree,
  ReusableWorktreeCandidate,
  ValidateWorktreeReuseInput,
} from "../../git/worktree-service.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { openDatabase } from "../../session/migration-runner.js";
import { ExecutionRootService } from "../execution-root-service.js";
import type {
  ExecutionRootClonePreparer,
  ExecutionRootGitRunner,
  ExecutionRootServiceDeps,
  ExecutionRootWorktreeProvisioner,
  PreparedExecutionRoot,
  WorkspaceLifecyclePrimitives,
} from "../execution-root-service.js";
import { RepoMountNotFoundError } from "../repo-errors.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import type { FilesystemPathProbeFn } from "../workspace-service.js";
import {
  WorkspaceBusyError,
  WorkspaceNotFoundError,
  WorkspaceService,
  WorkspaceStaleError,
} from "../workspace-service.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Real UUIDs throughout: session ids travel branded schemas at the emission
// boundary, and `deriveWorktreeBranchName` slices the first eight hex digits of
// the session and run ids — so the derived-name assertion below is only exact
// because these are real ones.
const SESSION_ID: string = "0190fb10-1c2d-7e3f-8a4b-5c6d7e8f9a01";
const REPO_MOUNT_ID: string = "0190fb11-2d3e-7f40-9b5c-6d7e8f9a0b12";
const WORKSPACE_ID: string = "0190fb12-3e4f-7051-8c6d-7e8f9a0b1c23";
const OTHER_WORKSPACE_ID: string = "0190fb13-4f50-7162-9d7e-8f9a0b1c2d34";
const RUN_ID: string = "0190fb14-5061-7273-8e8f-9a0b1c2d3e45";
const SEEDED_WORKTREE_ID: string = "0190fb15-6172-7384-9f90-0b1c2d3e4f56";
const SEEDED_CONTEXT_ID: string = "0190fb16-7283-7495-8a01-1c2d3e4f5067";
const UNKNOWN_WORKSPACE_ID: string = "0190fb17-8394-75a6-9b12-2d3e4f506178";

const CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-exec-mount";
// The subdirectory a READ-ONLY bind resolved. Deliberately NOT the mount root:
// answering with the mount root would widen the CP-009-8 approval scope, and a
// fixture where the two are equal could not tell the two answers apart.
const READ_ONLY_BIND_ROOT: string = `${CANONICAL_ROOT}/packages/api`;
// A writable workspace's PREVIOUS root — the one `beginReprovision` releases.
const PRIOR_ROOT: string = "/tmp/ai-sidekicks-fixture-exec-prior-root";
const EXECUTION_ROOTS_DIRECTORY: string = "/tmp/ai-sidekicks-fixture-exec-roots";

const MAIN_BRANCH: string = "main";
const FEATURE_BRANCH: string = "sidekicks/0190fb10/fix-login";
const SEEDED_BASE_BRANCH: string = "develop";
// `sidekicks/<session-short-8>/run-<run-short-8>` — `deriveWorktreeBranchName`
// strips hyphens before slicing, so these are the first eight hex digits of the
// UUIDs above and nothing else.
const DERIVED_RUN_BRANCH: string = "sidekicks/0190fb10/run-0190fb14";

const EPOCH: string = "2026-08-07T00:00:00.000Z";
// Deliberately EARLIER than the clock: a seeded row's `created_at` surviving a
// refresh is how "the row was preserved, not replaced" is told apart from "a new
// row happened to carry the same values".
const SEEDED_CONTEXT_STAMP: string = "2026-01-01T00:00:00.000Z";

/** A fixed-key signing source — enough for a suite that only ever signs. */
const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(9) as Ed25519PrivateKey;

class FixedDaemonSigningKeySource implements DaemonSigningKeySource {
  readonly #privateKey: Ed25519PrivateKey = FIXED_DAEMON_PRIVATE_KEY;

  read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    return Promise.resolve(this.#privateKey);
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    return Promise.reject(
      new Error("FixedDaemonSigningKeySource.create is not used by this suite"),
    );
  }
}

// ----------------------------------------------------------------------------
// Deterministic identifiers
// ----------------------------------------------------------------------------

let mintedIdCount = 0;

/**
 * A deterministic, real-shaped UUID per call.
 *
 * Counters would be simpler, but `branch_contexts.id` values are compared for
 * IDENTITY across a refresh below ("the row kept its id"), and an id that could
 * not have come from `randomUUID` would make that comparison a claim about the
 * fixture rather than about the upsert.
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
  readonly timeoutMs: number;
}

/**
 * The verb of a recorded invocation, found by SKIPPING leading option pairs.
 *
 * Every invocation this service makes carries `-c core.hooksPath=<dir>` and
 * `-C <root>`, so a fixed index would work — but it would work by accident, and
 * would silently read a directory as a verb the first time the prefix changed.
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
  /** The branch the main checkout is on. `null` models a detached HEAD. */
  headBranch: string | null = MAIN_BRANCH;
  /** When set, the command RUNS and exits with this status — infrastructure. */
  failureExitCode: number | null = null;
  /** When set, the seam REJECTS: the process produced no status at all. */
  invocationFailure: Error | null = null;

  readonly run: ExecutionRootGitRunner = (argv, options) => {
    this.invocations.push({ argv: [...argv], timeoutMs: options.timeoutMs });
    const verb: string | undefined = gitVerb(argv);

    if (verb === "symbolic-ref") {
      if (this.invocationFailure !== null) {
        return Promise.reject(this.invocationFailure);
      }
      if (this.failureExitCode !== null) {
        // git's real shape for a repository it cannot read: a status, plus a
        // diagnostic on `stderr` that NAMES THE PATH — which is precisely what
        // the service must not carry outward.
        return Promise.resolve({
          exitCode: this.failureExitCode,
          stdout: "",
          stderr: `fatal: not a git repository: ${CANONICAL_ROOT}/.git`,
        });
      }
      if (this.headBranch === null) {
        // What `symbolic-ref --quiet` does on a detached HEAD: exit 1, no output,
        // and NO diagnostic — `--quiet` is what makes it a status rather than an
        // error, and the service reads it as an answer.
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: `${this.headBranch}\n`, stderr: "" });
    }

    return Promise.reject(new Error(`unexpected git verb in fixture: ${String(verb)}`));
  };

  verbs(): readonly (string | undefined)[] {
    return this.invocations.map((invocation) => gitVerb(invocation.argv));
  }
}

/**
 * Records the directories the service asks to exist.
 *
 * The default fake resolves and forgets, which cannot tell "created the hook
 * neutralization directory" from "never created anything" — and I-010-10 is
 * discharged by that directory EXISTING before git is invoked against it.
 */
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
 * Stands in for T2.2, and WRITES the `worktrees` row a real create would write.
 *
 * The row is not decoration: `branch_contexts.worktree_id` references it, and
 * `validateReuse` answers out of it rather than out of a field on this fake — so
 * the reuse arms below read the same row the service's carry-over read does.
 */
class FakeWorktreeProvisioner implements ExecutionRootWorktreeProvisioner {
  readonly createInputs: CreateWorktreeInput[] = [];
  readonly reuseInputs: ValidateWorktreeReuseInput[] = [];
  /** The ids this fake minted, so compensation can be held to the one it created. */
  readonly createdWorktreeIds: string[] = [];
  /** Compensation's target — the orphan-retire leg records here. */
  readonly retiredWorktreeIds: string[] = [];
  /** When set, `create` rejects with it — the `Spec-010 §Fallback Behavior` failure arm. */
  createFailure: Error | null = null;
  /** When set, `retire` rejects — the swallowed-compensation arm. */
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
    if (this.retireFailure !== null) {
      return Promise.reject(this.retireFailure);
    }
    return Promise.resolve({ worktreeId, state: "retired" });
  }
}

/** Stands in for T2.3, and writes the `ephemeral_clones` row a real prepare writes. */
class FakeClonePreparer implements ExecutionRootClonePreparer {
  readonly inputs: PrepareEphemeralCloneInput[] = [];
  /** The ids this fake minted, so disposal can be held to the one it prepared. */
  readonly preparedCloneIds: string[] = [];
  /** Compensation's target for clone mode. */
  readonly disposedCloneIds: string[] = [];
  /**
   * The base T2.3 OBSERVED, or `null` for a source HEAD commit no branch
   * references.
   *
   * `null` is the case where the clone's own HEAD lands detached and T2.3
   * reports the field absent — a lawful outcome for it, and the one case where
   * this service still self-anchors.
   */
  observedBaseBranch: string | null = SEEDED_BASE_BRANCH;

  prepare(input: PrepareEphemeralCloneInput): Promise<PreparedEphemeralClone> {
    this.inputs.push(input);
    const cloneId = mintUuid();
    const cloneRoot = `${EXECUTION_ROOTS_DIRECTORY}/${REPO_MOUNT_ID}/clones/${cloneId}`;
    insertCloneRow({
      cloneId,
      workspaceId: input.workspaceId,
      cloneRoot,
      branchName: input.branchName,
    });
    this.preparedCloneIds.push(cloneId);
    return Promise.resolve({
      cloneId,
      workspaceId: input.workspaceId,
      cloneRoot,
      branchName: input.branchName,
      // Conditional spread, matching T2.3's own contract: `exactOptionalPropertyTypes`
      // makes an absent key and an explicit `undefined` different values, and the
      // detached-clone-HEAD case is ABSENT.
      ...(this.observedBaseBranch === null ? {} : { baseBranch: this.observedBaseBranch }),
      cleanupPolicy: "on_run_complete",
      expiresAt: EPOCH,
      state: "ready",
    });
  }

  dispose(cloneId: string): Promise<unknown> {
    this.disposedCloneIds.push(cloneId);
    return Promise.resolve({ cloneId, state: "retired" });
  }
}

// ----------------------------------------------------------------------------
// Per-test lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  workspaces: WorkspaceService;
  worktrees: FakeWorktreeProvisioner;
  clones: FakeClonePreparer;
  git: FakeGit;
  /** Paths the injected probe reports UNREACHABLE — the stale lever. */
  unreachablePaths: Set<string>;
  tmpDir: string;
}

let ctx: TestContext;

function clock(): string {
  return EPOCH;
}

/**
 * The reachability probe, INJECTED rather than left to the real filesystem.
 *
 * `assertWritable` probes `workspaces.fs_root` and transitions the row to
 * `stale` when it does not answer. With the real probe, every `ready` fixture
 * would need a directory on disk or would be staled out from under its case —
 * and the stale-refusal case would need a deliberately-absent one anyway. One
 * injected seam gives both, per case, with no filesystem involved.
 */
const probePath: FilesystemPathProbeFn = (path) =>
  Promise.resolve({
    probedPath: path,
    reachable: !ctx.unreachablePaths.has(path),
    checkedAt: EPOCH,
  });

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
          signingKeySource: new FixedDaemonSigningKeySource(),
        }),
      }),
      probePath,
      now: clock,
    }),
    worktrees: new FakeWorktreeProvisioner(),
    clones: new FakeClonePreparer(),
    git: new FakeGit(),
    unreachablePaths: new Set<string>(),
    tmpDir,
  };
  insertAttachedMount();
});

afterEach(() => {
  // The per-session append lock is a MODULE SINGLETON — a case that left a queue
  // entry behind would stall the next case on the same session id.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

/** The REAL Plan-009 primitives, wired exactly as a composition root would. */
function realPrimitives(): WorkspaceLifecyclePrimitives {
  return {
    assertWritable: (workspaceId) => ctx.workspaces.assertWritable(workspaceId),
    beginReprovision: (workspaceId, targetMode) =>
      ctx.workspaces.beginReprovision(workspaceId, targetMode),
    completeReprovision: (workspaceId, fsRoot) =>
      ctx.workspaces.completeReprovision(workspaceId, fsRoot),
    failReprovision: (workspaceId, detail) => ctx.workspaces.failReprovision(workspaceId, detail),
  };
}

function makeService(overrides: Partial<ExecutionRootServiceDeps> = {}): ExecutionRootService {
  return new ExecutionRootService({
    database: ctx.db,
    workspaces: realPrimitives(),
    worktrees: ctx.worktrees,
    clones: ctx.clones,
    executionRootsDirectory: EXECUTION_ROOTS_DIRECTORY,
    git: ctx.git.run,
    filesystem: { createDirectory: () => Promise.resolve() },
    now: clock,
    newBranchContextId: mintUuid,
    ...overrides,
  });
}

async function captureRejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (rejection) {
    return rejection;
  }
  throw new Error("expected the call to reject, but it resolved");
}

// ----------------------------------------------------------------------------
// Row fixtures and reads
// ----------------------------------------------------------------------------

/** The suite's single attached git mount. `vcs_type` takes its `'git'` default. */
function insertAttachedMount(): void {
  ctx.db
    .prepare(
      `INSERT INTO repo_mounts (
         id, session_id, node_id, local_path, canonical_root, state, attached_at, updated_at
       ) VALUES (?, ?, 'node-1', ?, ?, 'attached', ?, ?)`,
    )
    .run(REPO_MOUNT_ID, SESSION_ID, CANONICAL_ROOT, CANONICAL_ROOT, EPOCH, EPOCH);
}

/**
 * Seed a workspace directly.
 *
 * Raw INSERT rather than `WorkspaceService.bind`: bind resolves a real directory
 * through the trust envelope, which would put a filesystem dependency on every
 * case. Every case that cares about a TRANSITION still drives the real Plan-009
 * primitives — through the service under test, which is the point.
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
       ) VALUES (@id, @repo_mount_id, @session_id, NULL, @branch_name, @fs_root, 'ready', @now, @now)`,
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

function insertCloneRow(options: {
  readonly cloneId: string;
  readonly workspaceId: string;
  readonly cloneRoot: string;
  readonly branchName: string;
}): void {
  ctx.db
    .prepare(
      `INSERT INTO ephemeral_clones (
         id, workspace_id, clone_root, branch_name, cleanup_policy, state,
         expires_at, created_at, updated_at
       ) VALUES (
         @id, @workspace_id, @clone_root, @branch_name, 'on_run_complete', 'ready',
         @now, @now, @now
       )`,
    )
    .run({
      id: options.cloneId,
      workspace_id: options.workspaceId,
      clone_root: options.cloneRoot,
      branch_name: options.branchName,
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
         id, workspace_id, worktree_id, ephemeral_clone_id,
         base_branch, head_branch, created_at, updated_at
       ) VALUES (@id, @workspace_id, @worktree_id, NULL, @base_branch, @head_branch, @now, @now)`,
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

function readCloneRoot(cloneId: string): string {
  const row = ctx.db
    .prepare<
      [string],
      { readonly clone_root: string }
    >(`SELECT clone_root FROM ephemeral_clones WHERE id = ?`)
    .get(cloneId);
  if (row === undefined) {
    throw new Error(`expected an ephemeral_clones row for ${cloneId}`);
  }
  return row.clone_root;
}

interface BranchContextTestRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly worktree_id: string | null;
  readonly ephemeral_clone_id: string | null;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function readBranchContexts(): readonly BranchContextTestRow[] {
  return ctx.db
    .prepare<[], BranchContextTestRow>(
      `SELECT id, workspace_id, worktree_id, ephemeral_clone_id,
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

// ============================================================================
// Mode dispatch (`Spec-010 §Required Behavior`, I-010-7)
// ============================================================================

describe("mode dispatch", () => {
  it("read-only resolves the bind root and materializes nothing", async () => {
    insertWorkspace({ executionMode: "read-only", state: "ready", fsRoot: READ_ONLY_BIND_ROOT });

    const prepared: PreparedExecutionRoot = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
    });

    // The BIND root, not the mount root. Widening to `CANONICAL_ROOT` would hand
    // Plan-012 an approval scope covering the whole repository (CP-009-8).
    expect(prepared.executionRoot).toBe(READ_ONLY_BIND_ROOT);
    expect(prepared.executionMode).toBe("read-only");
    expect(prepared.state).toBe("ready");
    expect(prepared.branchName).toBeUndefined();
    expect(prepared.worktreeId).toBeUndefined();
    expect(prepared.ephemeralCloneId).toBeUndefined();
    // `Spec-010 §State And Data Implications` scopes the branch context to the
    // three WRITABLE modes.
    expect(prepared.branchContextId).toBeUndefined();
    expect(readBranchContexts()).toHaveLength(0);
    // No bracket: nothing was reprovisioned, so nothing was evented.
    expect(readEventTypes()).toEqual([]);
    expect(ctx.git.invocations).toHaveLength(0);
  });

  it("read-only resolves its bind root while held busy, and reports that position", async () => {
    // Pins the decision, which is not the writable one. `assertWritable` PASSES
    // `busy` on purpose, and its docblock says why: the precise `workspace.busy`
    // refusal belongs to `markBusy`, the call that actually contends for the hold,
    // and duplicating it in the gate would refuse a caller that never takes one.
    // A read-only prepare is exactly that caller — it hands no root off, so it is
    // not in contention (the busy-handoff subject of
    // `Spec-010 §State And Data Implications`) with the run holding this
    // workspace. The response carries the OBSERVED position: "the position after
    // the bracket" has no bracket to describe here, and answering `ready` for a
    // held workspace would be the fabrication.
    insertWorkspace({ executionMode: "read-only", state: "ready", fsRoot: READ_ONLY_BIND_ROOT });
    await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);

    const prepared = await makeService().prepare({ workspaceId: WORKSPACE_ID });

    expect(prepared.executionRoot).toBe(READ_ONLY_BIND_ROOT);
    expect(prepared.state).toBe("busy");
    expect(readBranchContexts()).toHaveLength(0);
  });

  it("branch mode binds the shared main checkout when the checkout already matches", async () => {
    insertWorkspace({ executionMode: "branch", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.headBranch = FEATURE_BRANCH;

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    // `Spec-010 §Required Behavior` / `Spec-010 §Turn-Boundary Snapshots` —
    // the execution root IS the shared main checkout.
    expect(prepared.executionRoot).toBe(CANONICAL_ROOT);
    expect(prepared.executionMode).toBe("branch");
    expect(prepared.branchName).toBe(FEATURE_BRANCH);
    expect(prepared.worktreeId).toBeUndefined();
    expect(prepared.ephemeralCloneId).toBeUndefined();
    expect(prepared.branchContextId).toBeDefined();
    // I-010-6: the single invocation is a READ of HEAD. Nothing switched.
    expect(ctx.git.verbs()).toEqual(["symbolic-ref"]);
    // Nothing was delegated — branch mode creates no worktree and no clone.
    expect(ctx.worktrees.createInputs).toHaveLength(0);
    expect(ctx.clones.inputs).toHaveLength(0);
  });

  it("worktree mode delegates to T2.2 and reports the created root", async () => {
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const createInput = ctx.worktrees.createInputs[0];
    expect(ctx.worktrees.createInputs).toHaveLength(1);
    expect(createInput?.repoMountId).toBe(REPO_MOUNT_ID);
    expect(createInput?.sessionId).toBe(SESSION_ID);
    expect(createInput?.branchName).toBe(FEATURE_BRANCH);
    // D-010-15 / the request default: a collision REFUSES unless asked otherwise,
    // because a silent suffix changes the branch the run publishes from.
    expect(createInput?.onCollision).toBe("refuse");

    expect(prepared.executionMode).toBe("worktree");
    expect(prepared.worktreeId).toBeDefined();
    expect(prepared.executionRoot).toBe(readWorktreeRow(prepared.worktreeId ?? "").fs_root);
    expect(prepared.ephemeralCloneId).toBeUndefined();
    // The main checkout is never consulted for a worktree prepare (I-010-6).
    expect(ctx.git.invocations).toHaveLength(0);
  });

  it("ephemeral clone mode delegates to T2.3 and reports the clone root", async () => {
    insertWorkspace({ executionMode: "ephemeral clone", state: "provisioning" });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    expect(ctx.clones.inputs).toEqual([{ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }]);
    expect(prepared.executionMode).toBe("ephemeral clone");
    expect(prepared.ephemeralCloneId).toBeDefined();
    // The root T2.3 PERSISTED, not merely a path shaped like one — a substring
    // check would pass on a root this service invented for itself.
    expect(prepared.executionRoot).toBe(readCloneRoot(prepared.ephemeralCloneId ?? ""));
    expect(prepared.worktreeId).toBeUndefined();
    expect(ctx.git.invocations).toHaveLength(0);
  });
});

// ============================================================================
// The read-only arm's gate (`Spec-010 §Fallback Behavior`, CP-009-8)
// ============================================================================

describe("read-only gate", () => {
  it("persists the stale transition it observes, rather than only refusing", async () => {
    // THE case that justifies calling a write-named gate from a read-only path.
    // Observing a vanished root obliges the daemon to RECORD it, and that record
    // is a `workspaces` write I-010-11 forbids this module from making — so the
    // gate is not decoration over a local probe, it is the only lawful way to make
    // the finding durable. Without it the next `list` answers `ready` for a
    // workspace this call already knows is gone, and CP-009-8 hands that root to
    // Plan-012 as an approval scope.
    insertWorkspace({ executionMode: "read-only", state: "ready", fsRoot: READ_ONLY_BIND_ROOT });
    ctx.unreachablePaths.add(READ_ONLY_BIND_ROOT);

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceStaleError);
    // The DURABLE half — a refusal alone would leave this row `ready`.
    expect(readWorkspaceRow().state).toBe("stale");
    expect(readEventTypes()).toEqual(["workspace.stale"]);
  });

  it("refuses a stale read-only workspace", async () => {
    insertWorkspace({ executionMode: "read-only", state: "stale", fsRoot: READ_ONLY_BIND_ROOT });

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceStaleError);
  });

  it("refuses a released root as stale rather than as a defect", async () => {
    // `fs_root IS NULL` under a `ready` read-only row: something released the root
    // (`beginReprovision` is the only writer that does). Refused BEFORE the gate,
    // because Plan-009's health projector treats a NULL root under a probe-bearing
    // state as its own precondition failure — which would answer a gone root with
    // an unrelated defect instead of the `workspace.stale` whose repair fits.
    insertWorkspace({ executionMode: "read-only", state: "ready", fsRoot: null });

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceStaleError);
  });

  it("reports an archived read-only workspace as this module's own defect", async () => {
    // Refused BEFORE the gate too, but for the opposite reason: `assertWritable`
    // answers `archived` with Plan-009's anonymous `illegal_state_transition`,
    // where this module has a kind that names the actual condition — a read-only
    // workspace that cannot serve a root.
    // No root on the fixture on purpose: the STATE alone decides here, ahead of
    // the released-root check, so a row without one still takes this arm.
    insertWorkspace({ executionMode: "read-only", state: "archived" });

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID }),
    );

    expect(rejection).toMatchObject({
      kind: "read_only_workspace_unusable",
      workspaceId: WORKSPACE_ID,
    });
    // Not a wire refusal: no caller argument produces this, so it earns no code.
    expect(rejection).not.toBeInstanceOf(DaemonDomainError);
  });
});

// ============================================================================
// Refusals that fire before the workspace is committed
// ============================================================================

describe("pre-bracket refusals", () => {
  it("refuses a stale workspace before any git call (`Spec-010 §Fallback Behavior`, I-010-12)", async () => {
    // `branch` mode deliberately: it is the ONLY mode that calls git, so "before
    // any git call" is a claim with content here and vacuous elsewhere.
    insertWorkspace({ executionMode: "branch", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.unreachablePaths.add(PRIOR_ROOT);

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceStaleError);
    expect(ctx.git.invocations).toHaveLength(0);
    expect(readBranchContexts()).toHaveLength(0);
  });

  it("refuses a branch-mode mismatch without mutating the checkout (D-010-9)", async () => {
    insertWorkspace({ executionMode: "branch", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.headBranch = MAIN_BRANCH;

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceBranchMismatchError);
    // Both names, because the comparison IS the repair affordance: a caller told
    // only that the branches disagree cannot tell which side to move.
    expect(rejection).toMatchObject({
      workspaceId: WORKSPACE_ID,
      requestedBranchName: FEATURE_BRANCH,
      currentBranchName: MAIN_BRANCH,
    });

    // I-010-6, the whole point: the ONLY invocation was the read, so no checkout
    // command ran at all. A `switch`/`checkout` here would be the mutation.
    expect(ctx.git.verbs()).toEqual(["symbolic-ref"]);

    // And the ROW is untouched: a mismatch is a caller disagreement, not a fault,
    // so `Spec-010 §Fallback Behavior`'s `stale` disposition must not fire.
    const row = readWorkspaceRow();
    expect(row.state).toBe("ready");
    expect(row.fs_root).toBe(PRIOR_ROOT);
    expect(readEventTypes()).toEqual([]);
    expect(readBranchContexts()).toHaveLength(0);
  });

  it("refuses a detached main checkout as a mismatch, naming it unambiguously", async () => {
    insertWorkspace({ executionMode: "branch", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.headBranch = null;

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceBranchMismatchError);
    // A space is not a legal git ref character, so this label can never be
    // mistaken for a branch the caller could switch to.
    expect(rejection).toMatchObject({ currentBranchName: "(detached HEAD)" });
    expect(readWorkspaceRow().state).toBe("ready");
  });

  it("refuses a writable prepare carrying neither branchName nor runId, before any git call", async () => {
    insertWorkspace({ executionMode: "branch", state: "ready", fsRoot: PRIOR_ROOT });

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID }),
    );

    // D-010-19: the slug rule's inputs are gate-only, so a wire-originated
    // pre-run prepare must carry the branch.
    expect(rejection).toBeInstanceOf(WorkspaceBranchNameRequiredError);
    expect(ctx.git.invocations).toHaveLength(0);
    expect(ctx.worktrees.createInputs).toHaveLength(0);
    expect(readEventTypes()).toEqual([]);
  });

  it("treats an empty runId as absent rather than deriving from it", async () => {
    // The negative control for the case above AND for the fallback below: an
    // empty string is not a run id, and letting it through would answer a caller
    // error with `worktree.create_failed`'s underivable-name defect instead.
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, runId: "   " }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceBranchNameRequiredError);
    expect(ctx.worktrees.createInputs).toHaveLength(0);
  });

  it("refuses a busy workspace with the holding run id (`Spec-010 §State And Data Implications`)", async () => {
    insertWorkspace({ executionMode: "worktree", state: "ready", fsRoot: PRIOR_ROOT });
    // Through the REAL primitive, so the metadata this service reads is metadata
    // Plan-009 wrote.
    await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toBeInstanceOf(WorkspaceBusyError);
    // The attribution is the whole repair affordance: a caller told only "busy"
    // cannot tell whose run to wait for. Reading it back out of the metadata
    // Plan-009 wrote is what makes a `null` here a real regression.
    expect(rejection).toMatchObject({ workspaceId: WORKSPACE_ID, holdingRunId: RUN_ID });
    expect(ctx.worktrees.createInputs).toHaveLength(0);
    expect(readWorkspaceRow().state).toBe("busy");
  });

  it("refuses when the workspace's mount is no longer attached", async () => {
    // A detached mount is not a provisioning target, and the refusal lands before
    // the bracket so a re-attach is all the repair a caller needs.
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });
    ctx.db.prepare(`UPDATE repo_mounts SET state = 'detached' WHERE id = ?`).run(REPO_MOUNT_ID);

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toBeInstanceOf(RepoMountNotFoundError);
    expect(ctx.worktrees.createInputs).toHaveLength(0);
    expect(readWorkspaceRow().state).toBe("provisioning");
  });
});

// ============================================================================
// The git invocation (I-010-10, I-010-6)
// ============================================================================

const HOOK_NEUTRALIZATION_DIRECTORY: string = join(
  EXECUTION_ROOTS_DIRECTORY,
  ".hook-neutralization",
);

describe("git invocation", () => {
  it("neutralizes hooks on its one invocation, and creates that directory first", async () => {
    insertWorkspace({ executionMode: "branch", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.headBranch = FEATURE_BRANCH;
    const filesystem = new RecordingFilesystem();

    await makeService({ filesystem }).prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const invocation = ctx.git.invocations[0];
    expect(ctx.git.invocations).toHaveLength(1);
    // FIRST in the argv, which is what makes it win: a command-line `-c` outranks
    // repository, global and system config, so a repo-local `core.hooksPath` in
    // the user's own checkout cannot take it back.
    expect(invocation?.argv.slice(0, 2)).toEqual([
      "-c",
      `core.hooksPath=${HOOK_NEUTRALIZATION_DIRECTORY}`,
    ]);
    // And the directory must EXIST — git ignores a `core.hooksPath` that does not
    // resolve, which would silently restore the hooks this flag disables.
    expect(filesystem.createdDirectories).toEqual([HOOK_NEUTRALIZATION_DIRECTORY]);
    expect(invocation?.timeoutMs).toBe(120_000);
  });

  it("reports an unreadable repository as a defect, never as a branch mismatch", async () => {
    // git RAN and answered 128. Collapsing that into the mismatch refusal would
    // hand the caller a repair — "switch your checkout" — that cannot work.
    insertWorkspace({ executionMode: "branch", state: "ready", fsRoot: PRIOR_ROOT });
    ctx.git.failureExitCode = 128;

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toMatchObject({
      kind: "branch_verification_failed",
      workspaceId: WORKSPACE_ID,
    });
    expect(rejection).not.toBeInstanceOf(WorkspaceBranchMismatchError);
    // The STATUS and nothing else. The fixture's `stderr` names the repository
    // path, and this carrier reaches logs.
    const message = rejection instanceof Error ? rejection.message : "";
    expect(message).toContain("128");
    expect(message).not.toContain(CANONICAL_ROOT);
    // Pre-bracket, so the row is exactly where it started.
    expect(readWorkspaceRow().state).toBe("ready");
  });

  it("reports a git that never ran as a defect, without echoing its message", async () => {
    insertWorkspace({ executionMode: "branch", state: "ready", fsRoot: PRIOR_ROOT });
    // A spawn failure carries a path in its own message — the seam rejects, and
    // nothing may read a field off the thrown value into a carrier.
    ctx.git.invocationFailure = new Error(`spawn ENOENT: no git at ${CANONICAL_ROOT}/bin/git`);

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    expect(rejection).toMatchObject({ kind: "branch_verification_failed" });
    const message = rejection instanceof Error ? rejection.message : "";
    expect(message).not.toContain(CANONICAL_ROOT);
  });
});

// ============================================================================
// Branch-name resolution (D-010-19)
// ============================================================================

describe("branch-name resolution", () => {
  it("resolves the run-<short-8> fallback and hands the mode service an explicit name", async () => {
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });

    const prepared = await makeService().prepare({ workspaceId: WORKSPACE_ID, runId: RUN_ID });

    // The delegated service receives a RESOLVED name — it holds no slug-rule
    // inputs of its own, which is why T2.4 must resolve before dispatch.
    expect(ctx.worktrees.createInputs[0]?.branchName).toBe(DERIVED_RUN_BRANCH);
    expect(ctx.worktrees.createInputs[0]?.runId).toBe(RUN_ID);
    expect(prepared.branchName).toBe(DERIVED_RUN_BRANCH);
    expect(readBranchContext(prepared.branchContextId ?? "").head_branch).toBe(DERIVED_RUN_BRANCH);
  });

  it("passes a supplied branchName through verbatim (negative control)", async () => {
    // Without this, "the fallback fired" is indistinguishable from "the service
    // always derives".
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      runId: RUN_ID,
    });

    expect(ctx.worktrees.createInputs[0]?.branchName).toBe(FEATURE_BRANCH);
    expect(prepared.branchName).toBe(FEATURE_BRANCH);
    expect(prepared.branchName).not.toBe(DERIVED_RUN_BRANCH);
  });

  it("normalizes a padded runId ONCE, for the branch and for the delegated call", async () => {
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      runId: `  ${RUN_ID}  `,
    });

    // Trimming per use site was the defect: branch-name resolution trimmed and the
    // create did not, so the branch derived from the trimmed id while the PADDED
    // one went to T2.2 to be persisted as `created_by_run_id` — provenance naming
    // a run that does not exist. Both readers must see the same value.
    expect(prepared.branchName).toBe(DERIVED_RUN_BRANCH);
    expect(ctx.worktrees.createInputs[0]?.runId).toBe(RUN_ID);
  });
});

// ============================================================================
// Request options reaching the mode services
// ============================================================================

describe("request pass-through", () => {
  it("passes an explicit onCollision to the create", async () => {
    // The negative control for the `refuse` default asserted in mode dispatch:
    // without this, "defaults to refuse" and "ignores the field" look identical.
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });

    await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      onCollision: "suffix",
    });

    expect(ctx.worktrees.createInputs[0]?.onCollision).toBe("suffix");
  });

  it("passes the dirty-candidate acknowledgement to the reuse", async () => {
    // D-010-15's separate consent. T2.2 decides what to do with it; this service
    // must not decide FOR it by dropping the field.
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: `${EXECUTION_ROOTS_DIRECTORY}/${REPO_MOUNT_ID}/worktrees/${SEEDED_WORKTREE_ID}`,
    });
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });
    insertBranchContext({
      id: SEEDED_CONTEXT_ID,
      workspaceId: WORKSPACE_ID,
      worktreeId: SEEDED_WORKTREE_ID,
      baseBranch: SEEDED_BASE_BRANCH,
      headBranch: FEATURE_BRANCH,
    });

    await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      reuseWorktreeId: SEEDED_WORKTREE_ID,
      acknowledgeDirtyCandidate: true,
    });

    expect(ctx.worktrees.reuseInputs[0]?.acknowledgeDirtyCandidate).toBe(true);
  });
});

// ============================================================================
// Explicit reuse and the `branch_contexts` pair keying (D-010-15)
// ============================================================================

describe("explicit worktree reuse", () => {
  it("scopes a cross-workspace bind to a fresh row, leaving the candidate's alone", async () => {
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: `${EXECUTION_ROOTS_DIRECTORY}/${REPO_MOUNT_ID}/worktrees/${SEEDED_WORKTREE_ID}`,
    });
    // The CANDIDATE's workspace and its context row — the provenance the reuse
    // carries a base branch from.
    insertWorkspace({ executionMode: "worktree", state: "ready", fsRoot: PRIOR_ROOT });
    insertBranchContext({
      id: SEEDED_CONTEXT_ID,
      workspaceId: WORKSPACE_ID,
      worktreeId: SEEDED_WORKTREE_ID,
      baseBranch: SEEDED_BASE_BRANCH,
      headBranch: FEATURE_BRANCH,
    });
    const candidateRowBefore = readBranchContext(SEEDED_CONTEXT_ID);

    // A DIFFERENT workspace binds the same worktree.
    insertWorkspace({
      workspaceId: OTHER_WORKSPACE_ID,
      executionMode: "worktree",
      state: "provisioning",
    });
    const prepared = await makeService().prepare({
      workspaceId: OTHER_WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      reuseWorktreeId: SEEDED_WORKTREE_ID,
    });

    // Mount consistency is T2.2's obligation, and it can only discharge it if the
    // binding WORKSPACE's mount is what it receives.
    expect(ctx.worktrees.reuseInputs[0]?.repoMountId).toBe(REPO_MOUNT_ID);

    const rows = readBranchContexts();
    expect(rows).toHaveLength(2);

    const boundRow = readBranchContext(prepared.branchContextId ?? "");
    expect(boundRow.id).not.toBe(SEEDED_CONTEXT_ID);
    expect(boundRow.workspace_id).toBe(OTHER_WORKSPACE_ID);
    expect(boundRow.worktree_id).toBe(SEEDED_WORKTREE_ID);
    // Carried over, not invented: this daemon cannot re-derive the branch the
    // worktree was cut from.
    expect(boundRow.base_branch).toBe(SEEDED_BASE_BRANCH);
    expect(boundRow.head_branch).toBe(FEATURE_BRANCH);

    // UNTOUCHED — every column, `updated_at` included. A bumped stamp would mean
    // the write reached a row belonging to another workspace.
    expect(readBranchContext(SEEDED_CONTEXT_ID)).toEqual(candidateRowBefore);
  });

  it("refreshes the existing pair row when a workspace re-binds a worktree it created", async () => {
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });
    const service = makeService();

    // The full round trip: create writes the pair row, then a later reuse must
    // find it rather than duplicating it.
    const created = await service.prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      baseRef: SEEDED_BASE_BRANCH,
    });
    expect(readBranchContexts()).toHaveLength(1);

    // A second prepare on the SAME workspace, naming the worktree it just made.
    // No fixture surgery in between: the first prepare's `completeReprovision`
    // already left the row `ready` on that root, which is the state a real
    // re-bind starts from.
    const rebound = await service.prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
      reuseWorktreeId: created.worktreeId ?? "",
    });

    // The partial-unique `(worktree_id, workspace_id)` index holds: one row, and
    // it is the SAME row.
    expect(readBranchContexts()).toHaveLength(1);
    expect(rebound.branchContextId).toBe(created.branchContextId);
    expect(readBranchContext(rebound.branchContextId ?? "").base_branch).toBe(SEEDED_BASE_BRANCH);
  });

  it("preserves a same-workspace candidate's existing row without duplication", async () => {
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: `${EXECUTION_ROOTS_DIRECTORY}/${REPO_MOUNT_ID}/worktrees/${SEEDED_WORKTREE_ID}`,
    });
    insertWorkspace({ executionMode: "worktree", state: "ready", fsRoot: PRIOR_ROOT });
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
    // The row was PRESERVED — same identity, same provenance — not replaced by a
    // freshly-minted one carrying the same values.
    expect(prepared.branchContextId).toBe(SEEDED_CONTEXT_ID);
    expect(rows[0]?.base_branch).toBe(SEEDED_BASE_BRANCH);
    expect(rows[0]?.created_at).toBe(SEEDED_CONTEXT_STAMP);
  });

  it("fails closed when a reuse candidate carries no branch context", async () => {
    // A worktree with no `branch_contexts` row is one this daemon did not
    // provision — this service is the sole writer and writes a row for every
    // worktree it creates. Any base branch invented here would be PERSISTED as a
    // provenance claim about a cut point nobody can verify.
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: `${EXECUTION_ROOTS_DIRECTORY}/${REPO_MOUNT_ID}/worktrees/${SEEDED_WORKTREE_ID}`,
    });
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });

    const rejection = await captureRejection(() =>
      makeService().prepare({
        workspaceId: WORKSPACE_ID,
        branchName: FEATURE_BRANCH,
        reuseWorktreeId: SEEDED_WORKTREE_ID,
      }),
    );

    expect(rejection).toMatchObject({
      kind: "reuse_candidate_without_branch_context",
      workspaceId: WORKSPACE_ID,
    });
    expect(readBranchContexts()).toHaveLength(0);
  });
});

// ============================================================================
// `branch_contexts` polymorphism (`Spec-010 §State And Data Implications`, I-010-5)
// ============================================================================

describe("branch_contexts polymorphism", () => {
  it("writes a worktree-referencing row for worktree mode", async () => {
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const row = readBranchContext(prepared.branchContextId ?? "");
    expect(row.worktree_id).toBe(prepared.worktreeId);
    expect(row.ephemeral_clone_id).toBeNull();
  });

  it("writes a clone-referencing row for ephemeral clone mode", async () => {
    insertWorkspace({ executionMode: "ephemeral clone", state: "provisioning" });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const row = readBranchContext(prepared.branchContextId ?? "");
    expect(row.ephemeral_clone_id).toBe(prepared.ephemeralCloneId);
    expect(row.worktree_id).toBeNull();
    // The base T2.3 OBSERVED, not a self-anchor. This service cannot see the source
    // HEAD; the one that cloned it can, and reporting its measurement is the whole
    // reason the field exists.
    expect(row.base_branch).toBe(SEEDED_BASE_BRANCH);
    expect(row.base_branch).not.toBe(row.head_branch);
  });

  it("self-anchors a clone whose source commit no branch references", async () => {
    // The ONLY case left where the recorded base is not a measurement. T2.3 omits
    // the field when the clone's own HEAD lands detached — lawful there, not a
    // failure — and `base_branch` is TEXT NOT NULL, so something must be written.
    // The head branch is the one true statement available: a clone whose HEAD
    // landed detached has no branch it descends from.
    insertWorkspace({ executionMode: "ephemeral clone", state: "provisioning" });
    ctx.clones.observedBaseBranch = null;

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const row = readBranchContext(prepared.branchContextId ?? "");
    expect(row.base_branch).toBe(FEATURE_BRANCH);
    expect(row.base_branch).toBe(row.head_branch);
  });

  it("writes a root-less row for branch mode, one per prepare", async () => {
    insertWorkspace({ executionMode: "branch", state: "provisioning" });
    ctx.git.headBranch = FEATURE_BRANCH;
    const service = makeService();

    const first = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH });
    const row = readBranchContext(first.branchContextId ?? "");
    // The main checkout carries no Plan-010 root row, so the context references
    // NEITHER — which is exactly what makes it a branch-mode row.
    expect(row.worktree_id).toBeNull();
    expect(row.ephemeral_clone_id).toBeNull();

    // A second branch-mode prepare ACCUMULATES. Nothing needs a workspace-scoped
    // "current row" — `BranchContextReadRequest` has no workspace-only arm, and
    // Plan-011 reaches a specific row through `run_execution_contexts`. Refreshing
    // in place would instead destroy the previous binding's recorded branches.
    // The user moves the shared checkout, which is the scenario where the two rows
    // differ and the history is worth something.
    ctx.git.headBranch = MAIN_BRANCH;
    const second = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: MAIN_BRANCH });

    expect(readBranchContexts()).toHaveLength(2);
    expect(second.branchContextId).not.toBe(first.branchContextId);
    // The FIRST row still carries what it recorded — the history that refreshing
    // in place would have overwritten.
    expect(readBranchContext(first.branchContextId ?? "").head_branch).toBe(FEATURE_BRANCH);
    expect(readBranchContext(second.branchContextId ?? "").head_branch).toBe(MAIN_BRANCH);
  });

  it("writes no row at all for read-only mode", async () => {
    insertWorkspace({ executionMode: "read-only", state: "ready", fsRoot: READ_ONLY_BIND_ROOT });

    const prepared = await makeService().prepare({ workspaceId: WORKSPACE_ID });

    expect(prepared.branchContextId).toBeUndefined();
    expect(readBranchContexts()).toHaveLength(0);
  });
});

// ============================================================================
// The reprovision bracket (CP-010-2)
// ============================================================================

describe("the reprovision bracket", () => {
  it("completes reprovision with the prepared root", async () => {
    insertWorkspace({ executionMode: "worktree", state: "ready", fsRoot: PRIOR_ROOT });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    const row = readWorkspaceRow();
    expect(row.state).toBe("ready");
    // The PREPARED root, not the one the workspace arrived with.
    expect(row.fs_root).toBe(prepared.executionRoot);
    expect(row.fs_root).not.toBe(PRIOR_ROOT);
    expect(prepared.state).toBe("ready");
    // The bracket rode the Plan-009 primitives, which is what put these on the
    // timeline. A raw row write would have produced neither (I-010-11).
    expect(readEventTypes()).toEqual(["workspace.provisioning", "workspace.ready"]);
  });

  it("fail-reprovisions on a materialization failure and records the detail", async () => {
    insertWorkspace({ executionMode: "worktree", state: "ready", fsRoot: PRIOR_ROOT });
    const failure = new WorktreeCreateFailedError("base_ref_unresolved");
    ctx.worktrees.createFailure = failure;

    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    // The ORIGINAL typed cause reaches the caller — D-010-16 makes wrapping the
    // run-setup gate's job, and it wraps by code.
    expect(rejection).toBe(failure);

    // `Spec-010 §Fallback Behavior` — the run blocks in setup rather than degrading.
    const row = readWorkspaceRow();
    expect(row.state).toBe("stale");
    expect(row.fs_root).toBeNull();
    expect(readWorkspaceLastError()).toContain("worktree.create_failed");
    expect(readEventTypes()).toEqual(["workspace.provisioning", "workspace.stale"]);
    // Nothing half-written: the branch context is on the same side of the failure.
    expect(readBranchContexts()).toHaveLength(0);
  });

  it("does not double-begin a first-bind workspace", async () => {
    // A writable bind lands `provisioning` and stays there for this call, so
    // beginning again would fail Plan-009's `ready | stale` compare-and-swap.
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });

    const prepared = await makeService().prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    expect(readWorkspaceRow().fs_root).toBe(prepared.executionRoot);
    // ONLY the completion is evented: no second `workspace.provisioning`.
    expect(readEventTypes()).toEqual(["workspace.ready"]);
  });

  it("swallows a failReprovision throw and still reports the original cause", async () => {
    insertWorkspace({ executionMode: "worktree", state: "ready", fsRoot: PRIOR_ROOT });
    const failure = new WorktreeCreateFailedError("base_ref_unresolved");
    ctx.worktrees.createFailure = failure;
    const bookkeepingFailure = new Error("failReprovision could not reach the database");

    const rejection = await captureRejection(() =>
      makeService({
        workspaces: {
          ...realPrimitives(),
          failReprovision: (): Promise<void> => Promise.reject(bookkeepingFailure),
        },
      }).prepare({ workspaceId: WORKSPACE_ID, branchName: FEATURE_BRANCH }),
    );

    // The materialization failure, not the bookkeeping one. What the caller needs
    // is the thing that actually went wrong, and a workspace left in `provisioning`
    // is the open-bracket arm a later prepare already handles.
    expect(rejection).toBe(failure);
    expect(rejection).not.toBe(bookkeepingFailure);
    expect(readWorkspaceRow().state).toBe("provisioning");
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
      completeReprovision: (): Promise<void> => Promise.reject(failure),
    };
  }

  const COMPLETION_FAILURE_MESSAGE = "completeReprovision could not reach the database";

  it("retires a worktree this call created, and first removes the row binding it", async () => {
    // Without compensation this leaks permanently: T2.2's sweep retires worktrees
    // whose MOUNT detached and cleans rows already `retired`, and an orphan on an
    // attached mount is in neither set.
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });
    const failure = new Error(COMPLETION_FAILURE_MESSAGE);

    const rejection = await captureRejection(() =>
      makeService({ workspaces: primitivesFailingCompletion(failure) }).prepare({
        workspaceId: WORKSPACE_ID,
        branchName: FEATURE_BRANCH,
      }),
    );

    // The caller is owed the failure that actually happened.
    expect(rejection).toBe(failure);
    // The row goes first: T2.2's retirement refuses while a `busy` workspace is
    // bound to the worktree, and it finds that binding by joining `branch_contexts`
    // on `worktree_id`. Ours is a binding for a handover that never happened.
    expect(readBranchContexts()).toHaveLength(0);
    // Against the id this call MINTED, not against whatever rows exist: the claim
    // is that compensation retires its own root, and a count would also pass if it
    // had retired someone else's.
    expect(ctx.worktrees.retiredWorktreeIds).toEqual(ctx.worktrees.createdWorktreeIds);
    expect(ctx.worktrees.createdWorktreeIds).toHaveLength(1);
  });

  it("disposes a clone this call minted", async () => {
    insertWorkspace({ executionMode: "ephemeral clone", state: "provisioning" });
    const failure = new Error(COMPLETION_FAILURE_MESSAGE);

    const rejection = await captureRejection(() =>
      makeService({ workspaces: primitivesFailingCompletion(failure) }).prepare({
        workspaceId: WORKSPACE_ID,
        branchName: FEATURE_BRANCH,
      }),
    );

    expect(rejection).toBe(failure);
    expect(ctx.clones.disposedCloneIds).toEqual(ctx.clones.preparedCloneIds);
    expect(ctx.clones.preparedCloneIds).toHaveLength(1);
    expect(readBranchContexts()).toHaveLength(0);
  });

  it("leaves a REUSED worktree and its existing row untouched", async () => {
    // The gate that makes compensation safe. A pre-existing worktree may be bound
    // by other workspaces, so retiring it would destroy state this call never
    // created — and its `branch_contexts` row was UPDATED rather than inserted, so
    // deleting it would take a previous binding's provenance with it.
    insertWorktreeRow({
      worktreeId: SEEDED_WORKTREE_ID,
      branchName: FEATURE_BRANCH,
      fsRoot: `${EXECUTION_ROOTS_DIRECTORY}/${REPO_MOUNT_ID}/worktrees/${SEEDED_WORKTREE_ID}`,
    });
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });
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

  it("still reports the completion failure when the compensation itself fails", async () => {
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });
    const failure = new Error(COMPLETION_FAILURE_MESSAGE);
    ctx.worktrees.retireFailure = new Error("retire could not reach the database either");

    const rejection = await captureRejection(() =>
      makeService({ workspaces: primitivesFailingCompletion(failure) }).prepare({
        workspaceId: WORKSPACE_ID,
        branchName: FEATURE_BRANCH,
      }),
    );

    // Swallowed: a compensation that fails leaves things no worse than not
    // compensating, and replacing the cause would hide the step that broke.
    expect(rejection).toBe(failure);
    expect(ctx.worktrees.retiredWorktreeIds).toEqual(ctx.worktrees.createdWorktreeIds);
  });
});

// ============================================================================
// I-010-11 — every workspace write rides the Plan-009 primitives
// ============================================================================

/**
 * Write statements against `workspaces`, in every spelling SQLite accepts.
 *
 * Deliberately NOT anchored to a template literal or to `database.prepare(`:
 * the claim is about the whole FILE, so a write smuggled into a helper, a
 * comment-adjacent string, or a second prepare site is caught the same way.
 */
const WORKSPACES_WRITE_PATTERN =
  /\b(?:UPDATE|DELETE\s+FROM|(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO)\s+workspaces\b/i;

const serviceSource: string = readFileSync(
  new URL("../execution-root-service.ts", import.meta.url),
  "utf8",
);

describe("I-010-11 — no raw workspaces write", () => {
  it("contains no write statement against the workspaces table", () => {
    expect(WORKSPACES_WRITE_PATTERN.test(serviceSource)).toBe(false);
    // The file DOES read the table — without this the assertion above would also
    // pass on a file that never mentions `workspaces` at all, which would make it
    // a claim about the wrong module.
    expect(serviceSource).toContain("FROM workspaces");
  });

  it("detects a workspaces write in every spelling when one is present (negative control)", () => {
    const smuggled: readonly string[] = [
      `UPDATE workspaces SET state = 'ready' WHERE id = @id`,
      `update workspaces set fs_root = NULL`,
      `INSERT INTO workspaces (id) VALUES (@id)`,
      `INSERT OR REPLACE INTO workspaces (id) VALUES (@id)`,
      `DELETE FROM workspaces WHERE id = @id`,
    ];
    for (const statement of smuggled) {
      expect(WORKSPACES_WRITE_PATTERN.test(statement)).toBe(true);
    }

    // And it does NOT fire on the statements this module legitimately owns —
    // without which the positive assertion above would be satisfied by a pattern
    // that matches everything.
    const permitted: readonly string[] = [
      `UPDATE branch_contexts SET base_branch = @base_branch`,
      `INSERT INTO branch_contexts (id) VALUES (@id)`,
      `SELECT id FROM workspaces WHERE id = @workspace_id`,
    ];
    for (const statement of permitted) {
      expect(WORKSPACES_WRITE_PATTERN.test(statement)).toBe(false);
    }
  });

  it("leaves the workspaces row byte-identical when the primitives are stubbed out", async () => {
    // The structural half. With the primitives replaced by recording no-ops, any
    // change to the row could only have come from this module's own SQL — so an
    // unchanged row is a direct observation, not a proxy for one.
    insertWorkspace({ executionMode: "worktree", state: "provisioning" });
    const before = readWorkspaceRow();

    const calls: string[] = [];
    const stubbed: WorkspaceLifecyclePrimitives = {
      assertWritable: (workspaceId) => {
        calls.push(`assertWritable:${workspaceId}`);
        return Promise.resolve();
      },
      beginReprovision: (workspaceId) => {
        calls.push(`beginReprovision:${workspaceId}`);
        return Promise.resolve();
      },
      completeReprovision: (workspaceId, fsRoot) => {
        calls.push(`completeReprovision:${workspaceId}:${fsRoot}`);
        return Promise.resolve();
      },
      failReprovision: (workspaceId) => {
        calls.push(`failReprovision:${workspaceId}`);
        return Promise.resolve();
      },
    };

    const prepared = await makeService({ workspaces: stubbed }).prepare({
      workspaceId: WORKSPACE_ID,
      branchName: FEATURE_BRANCH,
    });

    // The service did the work — otherwise "the row is unchanged" would be true
    // of a service that did nothing at all.
    expect(prepared.executionRoot).toContain("/worktrees/");
    expect(readBranchContexts()).toHaveLength(1);
    // It asked the primitive to adopt the root, rather than writing it.
    expect(calls).toEqual([`completeReprovision:${WORKSPACE_ID}:${prepared.executionRoot}`]);
    expect(readWorkspaceRow()).toEqual(before);
    expect(readEventTypes()).toEqual([]);
  });
});

// ============================================================================
// Not-found
// ============================================================================

describe("unknown workspace", () => {
  it("refuses an id that resolves to no row", async () => {
    const rejection = await captureRejection(() =>
      makeService().prepare({ workspaceId: UNKNOWN_WORKSPACE_ID }),
    );

    // Plan-009's carrier, not a Plan-010 re-mint — one code with two classes
    // would make `instanceof` depend on which module a throw site imported.
    expect(rejection).toBeInstanceOf(WorkspaceNotFoundError);
  });
});
