// Drives the real WorktreeService over a real SQLite test database, with the event log as the
// durable append path and a recording fake git runner in place of the child process. The git
// seam takes no `cwd`, so a recorded argv is the whole claim about what git was asked to do.
//
// Covered: the branch-name pattern and slug rules, both collision policies, reuse validation,
// retirement, the cleanup pass, and the typed error vocabulary.
//
// The race cases use a subclassed `WorktreeEventEmitter` whose emit method performs the
// interfering write and then delegates to `super`: the write commits on the same synchronous
// connection just before the append transaction opens, the window a check made outside that
// transaction cannot see.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonRpcErrorCode, WORKTREE_GIT_REF_MAX_LEN } from "@ai-sidekicks/contracts";
import type { WorkspaceState } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import type { EventLogAppendReceipt } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { DaemonDomainError } from "../../ipc/domain-error.js";
import { openDatabase } from "../../session/migration-runner.js";
import { RepoMountNotFoundError } from "../../workspace/repo-errors.js";
import { WorktreeEventEmitter } from "../worktree-event-emitter.js";
import type {
  EmitWorktreeEventInput,
  WorktreeEventEmitterDeps,
} from "../worktree-event-emitter.js";
import {
  WORKSPACE_ERROR_CODES,
  WORKTREE_ERROR_CODES,
  WorkspaceBranchMismatchError,
  WorkspaceBranchNameRequiredError,
  WorkspaceExecutionRootUnresolvedError,
  WorktreeBranchCollisionError,
  WorktreeCreateFailedError,
  WorktreeNotFoundError,
  WorktreeRetireConflictError,
  WorktreeReuseConflictError,
} from "../worktree-errors.js";
import type { WorktreeCreateFailureReason } from "../worktree-errors.js";
import { WorktreeService, deriveWorktreeBranchName } from "../worktree-service.js";
import type {
  CreateWorktreeInput,
  CreatedWorktree,
  WorktreeFilesystem,
  WorktreeGitInvocationResult,
  WorktreeGitRunner,
  WorktreeServiceDeps,
} from "../worktree-service.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// The emitter and `retire` parse ids through UUID schemas, so every fixture id is a real UUID.
const SESSION_ID: string = "0190f8b0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const REPO_MOUNT_ID: string = "0190f8b2-2d4e-7f7b-9a32-3d8e7c5f0b21";
const OTHER_REPO_MOUNT_ID: string = "0190f8b5-5a7b-7c9d-8e54-6f0a9e82d354";
const WORKSPACE_ID: string = "0190f8b3-3e5f-7a8c-8b43-4e9f8d60c132";
const RUN_ID: string = "0190f8b4-4f60-7b9d-9c54-5f0a9e71c243";
const BRANCH_CONTEXT_ID: string = "0190f8b6-6b8c-7d0e-8f65-7a1b0f93e465";
const UNKNOWN_WORKTREE_ID: string = "0190f8b7-7c9d-7e1f-9a76-8b2c1a04f576";
// A real UUID, because an injected id is still parsed by the emitter's `WorktreeIdSchema`;
// a counter would fail there rather than at the constraint the case is about.
const FIXED_WORKTREE_ID: string = "0190f8b8-8d0e-7f20-8b87-9c3d2b15a687";

// `idx_repo_mounts_active_root` is UNIQUE over (node_id, canonical_root) for attached rows, so a
// second mount on the same node needs a root of its own.
const CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-mount";
const OTHER_CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-other-mount";
const HEAD_BRANCH: string = "main";
const NOW: string = "2026-08-04T00:00:00.000Z";

// The name a caller derives for these fixtures before handing `create` an explicit name; the
// service itself holds no summary and derives nothing. Calling the helper keeps the collision
// cases on the real two-step path.
const DERIVED_BRANCH_NAME: string = deriveWorktreeBranchName({
  sessionId: SESSION_ID,
  runId: RUN_ID,
  taskSummary: "Fix login",
});

// The git verbs that would mutate the mount's main checkout.
const MAIN_CHECKOUT_MUTATING_VERBS: readonly string[] = [
  "checkout",
  "switch",
  "branch",
  "merge",
  "rebase",
  "reset",
  "stash",
  "commit",
  "pull",
];

// ----------------------------------------------------------------------------
// The recording fake git
// ----------------------------------------------------------------------------

interface RecordedGitInvocation {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

function resolveGit(stdout: string): Promise<WorktreeGitInvocationResult> {
  return Promise.resolve({ stdout, stderr: "" });
}

/**
 * Records every invocation and answers the verbs the service issues: `symbolic-ref`, `status`,
 * and `worktree` with `add` or `prune`.
 *
 * `worktree add` creates the target directory, because the cleanup pass must be seen removing a
 * real root and a retire must be seen leaving one. An unrecognized verb or `worktree`
 * subcommand rejects, so a new git call added to the service cannot slip past the
 * every-invocation assertions below.
 */
class FakeGit {
  readonly invocations: RecordedGitInvocation[] = [];
  headBranch: string | null = HEAD_BRANCH;
  statusOutput: string = "";
  statusFails: boolean = false;
  worktreeAddFails: boolean = false;
  worktreePruneFails: boolean = false;

  readonly run: WorktreeGitRunner = (argv, options) => {
    this.invocations.push({ argv: [...argv], timeoutMs: options.timeoutMs });
    // argv is `-c core.hooksPath=… -c core.fsmonitor=false -C <dir> <verb> …`: the verb is
    // index 6 and a `worktree` subcommand is index 7.
    const verb: string | undefined = argv[6];

    if (verb === "symbolic-ref") {
      if (this.headBranch === null) {
        return Promise.reject(new Error("fatal: ref HEAD is not a symbolic ref"));
      }
      return resolveGit(`${this.headBranch}\n`);
    }

    if (verb === "worktree") {
      const subcommand: string | undefined = argv[7];
      if (subcommand === "prune") {
        if (this.worktreePruneFails) {
          return Promise.reject(new Error("fatal: not a git repository"));
        }
        return resolveGit("");
      }
      if (subcommand === "add") {
        if (this.worktreeAddFails) {
          return Promise.reject(new Error("fatal: could not create worktree"));
        }
        const targetRoot: string | undefined = argv[10];
        if (targetRoot !== undefined) {
          mkdirSync(targetRoot, { recursive: true });
          writeFileSync(join(targetRoot, "README.md"), "fixture\n");
        }
        return resolveGit("");
      }
      return Promise.reject(
        new Error(`unexpected git worktree subcommand in fixture: ${String(subcommand)}`),
      );
    }

    if (verb === "status") {
      if (this.statusFails) {
        return Promise.reject(new Error("fatal: not a git repository"));
      }
      return resolveGit(this.statusOutput);
    }

    return Promise.reject(new Error(`unexpected git verb in fixture: ${String(verb)}`));
  };

  verbs(): readonly (string | undefined)[] {
    return this.invocations.map((invocation) => invocation.argv[6]);
  }

  argvFor(verb: string): readonly string[] {
    const found = this.invocations.find((invocation) => invocation.argv[6] === verb);
    if (found === undefined) {
      throw new Error(`no recorded git invocation for verb "${verb}"`);
    }
    return found.argv;
  }

  /** Every recorded `git worktree <subcommand>` argv, in invocation order. */
  worktreeSubcommandArgvs(subcommand: string): readonly (readonly string[])[] {
    return this.invocations
      .filter(
        (invocation) => invocation.argv[6] === "worktree" && invocation.argv[7] === subcommand,
      )
      .map((invocation) => invocation.argv);
  }
}

// ----------------------------------------------------------------------------
// Per-test lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  eventLog: EventLogService;
  emitter: WorktreeEventEmitter;
  git: FakeGit;
  executionRootsDirectory: string;
  hookNeutralizationDirectory: string;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-worktree-service-test-"));
  const db: DatabaseType = openDatabase(join(tmpDir, "test.db"));
  const eventLog = new EventLogService({
    db,
  });
  const executionRootsDirectory: string = join(tmpDir, "execution-roots");
  ctx = {
    db,
    eventLog,
    emitter: new WorktreeEventEmitter({ sessionEvents: eventLog }),
    git: new FakeGit(),
    executionRootsDirectory,
    hookNeutralizationDirectory: join(executionRootsDirectory, ".hook-neutralization"),
    tmpDir,
  };
  insertMount({ repoMountId: REPO_MOUNT_ID });
});

afterEach(() => {
  // The per-session append lock is a module singleton; a leftover queue entry would stall the
  // next case on the same session id.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeService(overrides: Partial<WorktreeServiceDeps> = {}): WorktreeService {
  return new WorktreeService({
    database: ctx.db,
    events: ctx.emitter,
    executionRootsDirectory: ctx.executionRootsDirectory,
    git: ctx.git.run,
    ...overrides,
  });
}

// ----------------------------------------------------------------------------
// Row fixtures and reads
// ----------------------------------------------------------------------------

// Options objects rather than positionals: same-named seeders in other suites take a bare
// `(string)` with a different meaning, so a miscopied positional call would type-check while
// seeding garbage.
function insertMount(options: {
  readonly repoMountId: string;
  readonly state?: string;
  readonly canonicalRoot?: string;
}): void {
  const canonicalRoot = options.canonicalRoot ?? CANONICAL_ROOT;
  const statement = ctx.db.prepare(
    `INSERT INTO repo_mounts (
       id, node_id, local_path, canonical_root, state, attached_at, updated_at
     ) VALUES (?, 'node-1', ?, ?, ?, ?, ?)`,
  );
  statement.run(
    options.repoMountId,
    canonicalRoot,
    canonicalRoot,
    options.state ?? "attached",
    NOW,
    NOW,
  );
}

function insertWorkspace(options: {
  readonly state: WorkspaceState;
  readonly fsRoot?: string;
}): void {
  const statement = ctx.db.prepare(
    `INSERT INTO workspaces (
       id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at
     ) VALUES (?, ?, ?, 'provisioned-worktree', ?, ?, ?, ?)`,
  );
  statement.run(
    WORKSPACE_ID,
    SESSION_ID,
    REPO_MOUNT_ID,
    options.fsRoot ?? CANONICAL_ROOT,
    options.state,
    NOW,
    NOW,
  );
}

function insertBranchContext(worktreeId: string): void {
  const statement = ctx.db.prepare(
    `INSERT INTO branch_contexts (
       id, workspace_id, worktree_id, base_branch, head_branch, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  statement.run(BRANCH_CONTEXT_ID, WORKSPACE_ID, worktreeId, HEAD_BRANCH, "feature", NOW, NOW);
}

interface WorktreeTestRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  readonly state: string;
  readonly cleaned_at: string | null;
}

function readWorktreeRow(worktreeId: string): WorktreeTestRow {
  const statement = ctx.db.prepare<[string], WorktreeTestRow>(
    `SELECT id, repo_mount_id, created_by_session_id, created_by_run_id, branch_name,
            fs_root, state, cleaned_at
       FROM worktrees
      WHERE id = ?`,
  );
  const row = statement.get(worktreeId);
  if (row === undefined) {
    throw new Error(`expected a worktrees row for ${worktreeId}`);
  }
  return row;
}

function readAllWorktreeIds(): readonly string[] {
  const rows = ctx.db.prepare<[], { id: string }>(`SELECT id FROM worktrees`).all();
  return rows.map((row) => row.id);
}

/** The id of the one worktrees row a case expects; throws unless there is exactly one. */
function readSoleWorktreeId(): string {
  const ids = readAllWorktreeIds();
  const soleId = ids[0];
  if (ids.length !== 1 || soleId === undefined) {
    throw new Error(`expected exactly one worktrees row, found ${ids.length}`);
  }
  return soleId;
}

function readEventTypes(): readonly string[] {
  const statement = ctx.db.prepare<[string], { type: string }>(
    `SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence ASC`,
  );
  return statement.all(SESSION_ID).map((row) => row.type);
}

async function captureRejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (rejection) {
    return rejection;
  }
  throw new Error("expected the call to reject, but it resolved");
}

/** The happy path, reused by the reuse, retire and cleanup blocks; it uses the `refuse` policy. */
async function createReadyWorktree(service: WorktreeService): Promise<CreatedWorktree> {
  return service.create({
    repoMountId: REPO_MOUNT_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    branchName: "feature/login",
    onCollision: "refuse",
  });
}

// ----------------------------------------------------------------------------
// Emitter subclasses — injected races and injected append failures
// ----------------------------------------------------------------------------
//
// The race-injecting pair performs its interfering write and then delegates to `super`, so the
// real append runs, prelude included. The failure-injecting pair never calls `super`: it
// rejects outright, so no append transaction opens and an absent row means the write never
// happened, not that it was rolled back. The service under test is the real one throughout.

/** Takes the busy hold while the retirement is in flight. */
class BusyHolderInjectingEmitter extends WorktreeEventEmitter {
  override async emitWorktreeRetired(
    input: EmitWorktreeEventInput,
  ): Promise<EventLogAppendReceipt> {
    // A hold is a `busy` workspace whose current `fs_root` is the worktree's own directory.
    const row = ctx.db
      .prepare<[string], { fs_root: string }>(`SELECT fs_root FROM worktrees WHERE id = ?`)
      .get(input.worktreeId);
    if (row === undefined) {
      throw new Error(`expected a worktrees row for ${input.worktreeId}`);
    }
    insertWorkspace({ state: "busy", fsRoot: row.fs_root });
    return super.emitWorktreeRetired(input);
  }
}

/** Lets a competing retirement commit first, with no event of its own. */
class PreRetiringEmitter extends WorktreeEventEmitter {
  override async emitWorktreeRetired(
    input: EmitWorktreeEventInput,
  ): Promise<EventLogAppendReceipt> {
    ctx.db
      .prepare(`UPDATE worktrees SET state = 'retired', updated_at = ? WHERE id = ?`)
      .run(NOW, input.worktreeId);
    return super.emitWorktreeRetired(input);
  }
}

/** The failure the `worktree.ready` append rejects with. */
const READY_EMISSION_FAILURE: Error = new Error("fixture: the worktree.ready append failed");

class ReadyEmissionFailingEmitter extends WorktreeEventEmitter {
  override emitWorktreeReady(): Promise<EventLogAppendReceipt> {
    return Promise.reject(READY_EMISSION_FAILURE);
  }
}

/**
 * Rejects the `worktree.created` append with a caller-chosen value. It drives the code check and
 * the live-row confirmation of a UNIQUE violation separately; through the real database the
 * branch index reports `SQLITE_CONSTRAINT_UNIQUE` only when a live row on that branch exists,
 * so each check would shadow the other.
 */
class CreatedEmissionFailingEmitter extends WorktreeEventEmitter {
  readonly #failure: unknown;

  constructor(deps: WorktreeEventEmitterDeps, failure: unknown) {
    super(deps);
    this.#failure = failure;
  }

  override emitWorktreeCreated(): Promise<EventLogAppendReceipt> {
    return Promise.reject(this.#failure);
  }
}

// ----------------------------------------------------------------------------
// The two every-invocation assertions
// ----------------------------------------------------------------------------
//
// Shared because the claims cover every invocation the service can issue, and `create` reaches
// only two of the four shapes: the reuse path adds `status --porcelain` and the cleanup pass
// adds `worktree prune`.

function assertEveryInvocationIsHookNeutralized(): void {
  expect(ctx.git.invocations.length).toBeGreaterThan(0);
  for (const invocation of ctx.git.invocations) {
    expect(invocation.argv.slice(0, 4)).toEqual([
      "-c",
      `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
      "-c",
      "core.fsmonitor=false",
    ]);
    expect(invocation.timeoutMs).toBeGreaterThan(0);
  }
  expect(existsSync(ctx.hookNeutralizationDirectory)).toBe(true);
}

function assertNoInvocationMutatesTheMainCheckout(): void {
  expect(ctx.git.invocations.length).toBeGreaterThan(0);
  for (const invocation of ctx.git.invocations) {
    for (const verb of MAIN_CHECKOUT_MUTATING_VERBS) {
      expect(invocation.argv).not.toContain(verb);
    }
  }
}

// ----------------------------------------------------------------------------
// deriveWorktreeBranchName — pattern, filled slug rule
// ----------------------------------------------------------------------------

// One row per slug clause. The third column is the slug segment alone; the assertion wraps it
// in `sidekicks/<session-short-id>/`, so every row also checks the prefix and short id.
const SLUG_CASES: ReadonlyArray<readonly [string, string | null, string]> = [
  ["lowercases and hyphenates a plain summary", "Fix the login bug", "fix-the-login-bug"],
  [
    "collapses runs of non-alphanumerics and trims the edges",
    "  !!Hello,   World!!  ",
    "hello-world",
  ],
  [
    "truncates at the last boundary inside 40 characters",
    "Add support for cross machine dispatch routing tables",
    "add-support-for-cross-machine-dispatch",
  ],
  [
    "keeps a full 40 characters when the 41st is itself a boundary",
    "AAAAAAAAA BBBBBBBBB CCCCCCCCC DDDDDDDDDD EEE",
    "aaaaaaaaa-bbbbbbbbb-ccccccccc-dddddddddd",
  ],
  ["cuts a single long word hard rather than to nothing", "a".repeat(50), "a".repeat(40)],
  ["falls back to the run short id when the summary is punctuation", "---", "run-9e71c243"],
  ["falls back to the run short id when the summary is empty", "", "run-9e71c243"],
  ["falls back to the run short id when there is no summary", null, "run-9e71c243"],
];

describe("deriveWorktreeBranchName", () => {
  for (const [label, taskSummary, expectedSlug] of SLUG_CASES) {
    it(label, () => {
      const derived = deriveWorktreeBranchName({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        taskSummary,
      });
      expect(derived).toBe(`sidekicks/5b3e8f00/${expectedSlug}`);
    });
  }

  it("keeps two sessions minted in the same 65,536 ms window apart", () => {
    // In a UUIDv7 the first 8 hex digits are the high 32 bits of the millisecond timestamp,
    // identical within one 65,536 ms window. Two sessions a minute apart with one task slug must
    // still get distinct branch names, so the short id comes from the random tail.
    const sameWindowSessionId = "0190f8b0-7e2d-7c4a-9b1c-0f0e0d0c0b0a";
    const first = deriveWorktreeBranchName({
      sessionId: SESSION_ID,
      runId: RUN_ID,
      taskSummary: "Fix login",
    });
    const second = deriveWorktreeBranchName({
      sessionId: sameWindowSessionId,
      runId: RUN_ID,
      taskSummary: "Fix login",
    });
    expect(SESSION_ID.slice(0, 8)).toBe(sameWindowSessionId.slice(0, 8));
    expect(second).toBe("sidekicks/0d0c0b0a/fix-login");
    expect(second).not.toBe(first);
  });

  it("refuses when neither a summary nor a run id can produce a slug", () => {
    let thrown: unknown;
    try {
      deriveWorktreeBranchName({ sessionId: SESSION_ID, runId: null, taskSummary: "!!!" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    const failure = thrown as WorktreeCreateFailedError;
    expect(failure.reason).toBe("branch_name_underivable");
  });
});

// ----------------------------------------------------------------------------
// create
// ----------------------------------------------------------------------------

describe("WorktreeService.create", () => {
  it("records provenance, materializes the root, and emits created then ready", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    expect(created.branchName).toBe("feature/login");
    expect(created.baseRef).toBe(HEAD_BRANCH);
    expect(created.state).toBe("ready");
    expect(created.fsRoot).toBe(
      join(ctx.executionRootsDirectory, REPO_MOUNT_ID, "worktrees", created.worktreeId),
    );

    const row = readWorktreeRow(created.worktreeId);
    expect(row.state).toBe("ready");
    expect(row.repo_mount_id).toBe(REPO_MOUNT_ID);
    // Both provenance columns, populated at creation.
    expect(row.created_by_session_id).toBe(SESSION_ID);
    expect(row.created_by_run_id).toBe(RUN_ID);
    expect(row.cleaned_at).toBeNull();

    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("records a NULL creating run for a pre-run explicit prepare", async () => {
    const service = makeService();
    const created = await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      branchName: "feature/pre-run",
      onCollision: "refuse",
    });

    expect(readWorktreeRow(created.worktreeId).created_by_run_id).toBeNull();
  });

  it("hook-neutralizes EVERY recorded invocation", async () => {
    const service = makeService();
    await createReadyWorktree(service);

    // Asserted over all invocations, not just provisioning, so a later-added call cannot escape.
    // This run produces two of the four shapes; the reuse and cleanup cases cover the others.
    expect(ctx.git.verbs()).toEqual(["symbolic-ref", "worktree"]);
    assertEveryInvocationIsHookNeutralized();
  });

  it("never issues a verb that would mutate the main checkout", async () => {
    const service = makeService();
    await createReadyWorktree(service);

    assertNoInvocationMutatesTheMainCheckout();
  });

  it("provisions with the exact `git worktree add` argv", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    expect(ctx.git.argvFor("worktree")).toEqual([
      "-c",
      `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
      "-c",
      "core.fsmonitor=false",
      "-C",
      CANONICAL_ROOT,
      "worktree",
      "add",
      "-b",
      "feature/login",
      created.fsRoot,
      HEAD_BRANCH,
    ]);
  });

  it("refuses a collision on the `refuse` arm, leaving neither a row nor an event", async () => {
    const service = makeService();
    await createReadyWorktree(service);
    const eventsBeforeCollision = readEventTypes().length;

    const thrown = await captureRejection(() => createReadyWorktree(service));

    expect(thrown).toBeInstanceOf(WorktreeBranchCollisionError);
    const collision = thrown as WorktreeBranchCollisionError;
    expect(collision.code).toBe("worktree.branch_collision");
    expect(collision.branchName).toBe("feature/login");
    expect(collision.repoMountId).toBe(REPO_MOUNT_ID);
    // The losing attempt left neither a row nor an event.
    expect(readAllWorktreeIds()).toHaveLength(1);
    expect(readEventTypes()).toHaveLength(eventsBeforeCollision);
  });

  it("ordinal-suffixes on the `suffix` arm and reports the chosen name verbatim", async () => {
    const service = makeService();
    const suffixingInput: CreateWorktreeInput = {
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: DERIVED_BRANCH_NAME,
      onCollision: "suffix",
    };

    const first = await service.create(suffixingInput);
    const second = await service.create(suffixingInput);
    const third = await service.create(suffixingInput);

    expect(first.branchName).toBe("sidekicks/5b3e8f00/fix-login");
    expect(second.branchName).toBe("sidekicks/5b3e8f00/fix-login-2");
    expect(third.branchName).toBe("sidekicks/5b3e8f00/fix-login-3");
    expect(readWorktreeRow(second.worktreeId).branch_name).toBe("sidekicks/5b3e8f00/fix-login-2");
  });

  it("selects the arm from `onCollision`, never from how the name was obtained", async () => {
    // One name, both policies, opposite outcomes. Every production request carries an explicit
    // name, so a policy inferred from the name would collapse to one arm.
    const service = makeService();
    // Every input except the policy is identical across the calls.
    const base: Omit<CreateWorktreeInput, "onCollision"> = {
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: DERIVED_BRANCH_NAME,
    };
    await service.create({ ...base, onCollision: "refuse" });

    const thrown = await captureRejection(() => service.create({ ...base, onCollision: "refuse" }));
    const suffixed = await service.create({ ...base, onCollision: "suffix" });

    expect(thrown).toBeInstanceOf(WorktreeBranchCollisionError);
    expect(suffixed.branchName).toBe(`${DERIVED_BRANCH_NAME}-2`);
  });

  it("refuses a suffix that would outgrow the ref cap instead of persisting it", async () => {
    // A name at `WORKTREE_GIT_REF_MAX_LEN` collides and every suffixed candidate is longer than
    // the cap. A persisted over-cap `branch_name` would fail response validation for the whole
    // status projection, so the write refuses with `branch_name_unavailable`, the same answer
    // as ordinal exhaustion.
    const service = makeService();
    const capLengthBranchName = `feature/${"x".repeat(WORKTREE_GIT_REF_MAX_LEN - "feature/".length)}`;
    const base: Omit<CreateWorktreeInput, "onCollision"> = {
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: capLengthBranchName,
    };
    await service.create({ ...base, onCollision: "refuse" });

    const thrown = await captureRejection(() => service.create({ ...base, onCollision: "suffix" }));

    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    expect((thrown as WorktreeCreateFailedError).reason).toBe("branch_name_unavailable");
    // Refused before anything landed: one row, the original's.
    expect(readAllWorktreeIds()).toHaveLength(1);
  });

  it("frees the bare name in the active-branch index once the colliding row is retired", async () => {
    const service = makeService();
    const suffixingInput: CreateWorktreeInput = {
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: DERIVED_BRANCH_NAME,
      onCollision: "suffix",
    };

    const first = await service.create(suffixingInput);
    await service.retire(first.worktreeId);
    const second = await service.create(suffixingInput);

    // This covers the database only: the index predicate excludes retired rows, so the bare name
    // is free again. It does not claim the name is reusable end to end, because git keeps the
    // branch after the worktree goes, which only a real-git test can observe.
    expect(second.branchName).toBe("sidekicks/5b3e8f00/fix-login");
  });

  it("re-throws an id collision rather than reading it as a branch collision", async () => {
    // An injected id source is the only way to collide on the PRIMARY KEY; the branch names
    // differ, so the branch index is not involved and the retry loop sees
    // `SQLITE_CONSTRAINT_PRIMARYKEY`. This pins the code check and the live-row confirmation as
    // a pair; the next two cases isolate each one.
    const service = makeService({ newWorktreeId: () => FIXED_WORKTREE_ID });
    await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      branchName: "feature/first",
      onCollision: "refuse",
    });

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feature/second",
        onCollision: "refuse",
      }),
    );

    // An id collision reported as a branch collision would send the caller to rename a branch
    // that is not the problem.
    expect(thrown).not.toBeInstanceOf(WorktreeBranchCollisionError);
    expect(readAllWorktreeIds()).toEqual([FIXED_WORKTREE_ID]);
    expect(readWorktreeRow(FIXED_WORKTREE_ID).branch_name).toBe("feature/first");
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("re-throws a non-constraint append failure even on a branch that IS taken", async () => {
    // Isolates the code check: the branch has a live row, so without the code check the
    // confirmation would turn an unrelated append failure into a 409 the caller cannot clear.
    const service = makeService();
    await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      branchName: "feature/taken",
      onCollision: "refuse",
    });
    const appendFailure = new Error("fixture: the worktree.created append failed");
    const failingService = makeService({
      events: new CreatedEmissionFailingEmitter({ sessionEvents: ctx.eventLog }, appendFailure),
    });

    const thrown = await captureRejection(() =>
      failingService.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feature/taken",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBe(appendFailure);
    expect(readAllWorktreeIds()).toHaveLength(1);
  });

  it("re-throws a UNIQUE violation that no live row on the branch explains", async () => {
    // Isolates the live-row confirmation: the code says UNIQUE but no row on this branch explains
    // it, as a constraint other than the active-branch index would look. Trusting the code alone
    // would suffix or refuse over a collision that never happened.
    const uniqueViolation = Object.assign(new Error("fixture: UNIQUE constraint failed"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    const service = makeService({
      events: new CreatedEmissionFailingEmitter({ sessionEvents: ctx.eventLog }, uniqueViolation),
    });

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feature/never-created",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBe(uniqueViolation);
    expect(readAllWorktreeIds()).toEqual([]);
  });

  it("refuses a detached-HEAD mount with no explicit base ref", async () => {
    ctx.git.headBranch = null;
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    const failure = thrown as WorktreeCreateFailedError;
    expect(failure.reason).toBe("base_ref_unresolved");
    expect(failure.httpStatus).toBe(500);
    // Refused before any row was written, so there is nothing to mark failed.
    expect(readAllWorktreeIds()).toEqual([]);
    expect(readEventTypes()).toEqual([]);
  });

  it("refuses an option-like base ref before spawning git at all", async () => {
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
        baseRef: "--upload-pack=payload",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    const failure = thrown as WorktreeCreateFailedError;
    expect(failure.reason).toBe("base_ref_option_like");
    expect(ctx.git.invocations).toEqual([]);
  });

  it("cuts from an explicit base ref when one is supplied", async () => {
    const service = makeService();
    const created = await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      branchName: "feat/x",
      onCollision: "refuse",
      baseRef: "release/1.0",
    });

    expect(created.baseRef).toBe("release/1.0");
    expect(ctx.git.argvFor("worktree").at(-1)).toBe("release/1.0");
    // No HEAD query: the supplied ref replaces the default.
    expect(ctx.git.verbs()).toEqual(["worktree"]);
  });

  it("marks the row failed without an event when materialization fails", async () => {
    ctx.git.worktreeAddFails = true;
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    const failure = thrown as WorktreeCreateFailedError;
    expect(failure.reason).toBe("git_invocation_failed");
    // The message must not carry git's stderr, which is where a path would appear.
    expect(failure.message).not.toContain(ctx.executionRootsDirectory);

    expect(readWorktreeRow(readSoleWorktreeId()).state).toBe("failed");
    // The row records the failure; there is no `worktree.failed` event.
    expect(readEventTypes()).toEqual(["worktree.created"]);
    // An interrupted create leaks the same administrative entry a completed one does, so the
    // recovery prunes it too.
    expect(ctx.git.worktreeSubcommandArgvs("prune")).toEqual([
      [
        "-c",
        `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
        "-C",
        CANONICAL_ROOT,
        "worktree",
        "prune",
      ],
    ]);
  });

  it("marks the row failed and clears the root when the READY emission fails", async () => {
    // A `creating` row counts as live to `idx_worktrees_active_branch`, so without the recovery
    // the (mount, branch) pair would stay blocked by a row no sweep step reaches.
    const service = makeService({
      events: new ReadyEmissionFailingEmitter({ sessionEvents: ctx.eventLog }),
    });

    const thrown = await captureRejection(() => createReadyWorktree(service));

    // The original failure, not whatever the recovery did about it.
    expect(thrown).toBe(READY_EMISSION_FAILURE);
    const row = readWorktreeRow(readSoleWorktreeId());
    expect(row.state).toBe("failed");
    expect(existsSync(row.fs_root)).toBe(false);
    expect(readEventTypes()).toEqual(["worktree.created"]);
    // `worktree add` succeeded in full here, so the administrative entry certainly exists.
    expect(ctx.git.worktreeSubcommandArgvs("prune")).toEqual([
      [
        "-c",
        `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
        "-C",
        CANONICAL_ROOT,
        "worktree",
        "prune",
      ],
    ]);
  });

  it("refuses an unknown mount with the carrier", async () => {
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: OTHER_REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBeInstanceOf(RepoMountNotFoundError);
    const failure = thrown as RepoMountNotFoundError;
    expect(failure.code).toBe("repo.not_found");
  });

  it("refuses a detached mount", async () => {
    insertMount({
      repoMountId: OTHER_REPO_MOUNT_ID,
      state: "detached",
      canonicalRoot: OTHER_CANONICAL_ROOT,
    });
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: OTHER_REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBeInstanceOf(RepoMountNotFoundError);
  });
});

// ----------------------------------------------------------------------------
// validateReuse
// ----------------------------------------------------------------------------

describe("WorktreeService.validateReuse", () => {
  it("returns a clean, compatible candidate with its provenance", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    const candidate = await service.validateReuse({
      worktreeId: created.worktreeId,
      repoMountId: REPO_MOUNT_ID,
      branchName: "feature/login",
    });

    expect(candidate.dirty).toBe(false);
    expect(candidate.state).toBe("ready");
    expect(candidate.fsRoot).toBe(created.fsRoot);
    expect(candidate.createdBySessionId).toBe(SESSION_ID);
    expect(candidate.createdByRunId).toBe(RUN_ID);
  });

  it("hook-neutralizes and stays non-mutating on the cleanliness verb too", async () => {
    // `status --porcelain` is reachable only through `validateReuse`, so a `create` case alone
    // would leave it unchecked.
    const service = makeService();
    const created = await createReadyWorktree(service);

    await service.validateReuse({
      worktreeId: created.worktreeId,
      repoMountId: REPO_MOUNT_ID,
      branchName: "feature/login",
    });

    expect(ctx.git.verbs()).toEqual(["symbolic-ref", "worktree", "status"]);
    assertEveryInvocationIsHookNeutralized();
    assertNoInvocationMutatesTheMainCheckout();
  });

  it("refuses a dirty candidate that was not acknowledged", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.git.statusOutput = " M src/index.ts\n";

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("dirty_unacknowledged");
    expect(conflict.code).toBe("worktree.reuse_conflict");
    expect(conflict.httpStatus).toBe(409);
  });

  it("binds a dirty candidate once the caller acknowledges it", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.git.statusOutput = " M src/index.ts\n";

    const candidate = await service.validateReuse({
      worktreeId: created.worktreeId,
      repoMountId: REPO_MOUNT_ID,
      branchName: "feature/login",
      acknowledgeDirtyCandidate: true,
    });

    expect(candidate.dirty).toBe(true);
    // Validation writes no row and emits no event.
    expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("refuses an incompatible candidate even WITH an acknowledgement", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.git.statusOutput = " M src/index.ts\n";

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/other",
        acknowledgeDirtyCandidate: true,
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("branch_mismatch");
  });

  it("refuses a candidate that belongs to another mount", async () => {
    insertMount({ repoMountId: OTHER_REPO_MOUNT_ID, canonicalRoot: OTHER_CANONICAL_ROOT });
    const service = makeService();
    const created = await createReadyWorktree(service);

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: OTHER_REPO_MOUNT_ID,
        branchName: "feature/login",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("mount_mismatch");
    // The mount check runs before any git call, so git was not spawned for it.
    expect(ctx.git.verbs()).toEqual(["symbolic-ref", "worktree"]);
  });

  it("refuses a retired candidate as no longer live", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("not_live");
  });

  it("refuses when the cleanliness verdict cannot be computed", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.git.statusFails = true;

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
        acknowledgeDirtyCandidate: true,
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("cleanliness_unresolved");
  });

  it("answers not-found for a candidate id that names no row", async () => {
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: UNKNOWN_WORKTREE_ID,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeNotFoundError);
    const failure = thrown as WorktreeNotFoundError;
    expect(failure.code).toBe("worktree.not_found");
  });
});

// ----------------------------------------------------------------------------
// retire
// ----------------------------------------------------------------------------

describe("WorktreeService.retire", () => {
  it("records the retirement and leaves the root on disk", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    const response = await service.retire(created.worktreeId);

    expect(response).toEqual({ worktreeId: created.worktreeId, state: "retired" });
    const row = readWorktreeRow(created.worktreeId);
    expect(row.state).toBe("retired");
    // Retire stamps nothing; only the cleanup pass sets `cleaned_at`.
    expect(row.cleaned_at).toBeNull();
    expect(existsSync(created.fsRoot)).toBe(true);
    expect(row.created_by_session_id).toBe(SESSION_ID);
    expect(row.created_by_run_id).toBe(RUN_ID);
    expect(row.branch_name).toBe("feature/login");

    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready", "worktree.retired"]);
  });

  it("refuses while a busy workspace is holding the worktree", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    insertWorkspace({ state: "busy", fsRoot: created.fsRoot });

    const thrown = await captureRejection(() => service.retire(created.worktreeId));

    expect(thrown).toBeInstanceOf(WorktreeRetireConflictError);
    const conflict = thrown as WorktreeRetireConflictError;
    expect(conflict.code).toBe("worktree.retire_conflict");
    expect(conflict.httpStatus).toBe(409);
    expect(conflict.holdingWorkspaceId).toBe(WORKSPACE_ID);
    expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("retires a worktree whose historical binder is busy on a different root", async () => {
    // `branch_contexts` rows are retained history: a workspace that once bound this worktree and
    // has since moved elsewhere does not hold this root. The busy probe is keyed on `fs_root` so
    // such a workspace does not block the retirement.
    const service = makeService();
    const created = await createReadyWorktree(service);
    insertWorkspace({ state: "busy", fsRoot: OTHER_CANONICAL_ROOT });
    insertBranchContext(created.worktreeId);

    const response = await service.retire(created.worktreeId);

    expect(response).toEqual({ worktreeId: created.worktreeId, state: "retired" });
    expect(readWorktreeRow(created.worktreeId).state).toBe("retired");
  });

  it("retires once a released workspace no longer holds the worktree", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    insertWorkspace({ state: "ready", fsRoot: created.fsRoot });
    insertBranchContext(created.worktreeId);

    await service.retire(created.worktreeId);

    expect(readWorktreeRow(created.worktreeId).state).toBe("retired");
  });

  it("refuses a hold taken between the read and the retirement transaction", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    // The hold lands after `retire` reads the row and before the append transaction opens, a
    // window the earlier probe cannot see; without the in-transaction check a live run's root
    // would be retired and then removed by the cleanup pass.
    const racedService = makeService({
      events: new BusyHolderInjectingEmitter({ sessionEvents: ctx.eventLog }),
    });

    const thrown = await captureRejection(() => racedService.retire(created.worktreeId));

    expect(thrown).toBeInstanceOf(WorktreeRetireConflictError);
    const conflict = thrown as WorktreeRetireConflictError;
    expect(conflict.holdingWorkspaceId).toBe(WORKSPACE_ID);
    // The refusal aborts before the event insert, so neither the state change nor the event lands.
    expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("answers idempotently when a concurrent retirement wins the race", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    // The competing retirement commits inside the same window; retire absorbs the race and
    // answers idempotently rather than failing its compare-and-swap.
    const racedService = makeService({
      events: new PreRetiringEmitter({ sessionEvents: ctx.eventLog }),
    });

    const response = await racedService.retire(created.worktreeId);

    expect(response).toEqual({ worktreeId: created.worktreeId, state: "retired" });
    expect(readWorktreeRow(created.worktreeId).state).toBe("retired");
    // No second `worktree.retired`: one event per real transition, and this call made none.
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("is idempotent and emits no second event", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);
    const typesAfterFirst = readEventTypes();

    const response = await service.retire(created.worktreeId);

    expect(response.state).toBe("retired");
    expect(readEventTypes()).toEqual(typesAfterFirst);
  });

  it("retires a failed row, its only route to sweep eligibility", async () => {
    // A creation that never materialized still owns a row, and `cleanupPass` only looks at
    // `retired` rows, so `failed` must be a legal predecessor of `retired` or the row would stay
    // forever.
    ctx.git.worktreeAddFails = true;
    const service = makeService();
    await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );
    const failedWorktreeId = readSoleWorktreeId();
    expect(readWorktreeRow(failedWorktreeId).state).toBe("failed");

    const response = await service.retire(failedWorktreeId);

    expect(response.state).toBe("retired");
    const retiredRow = readWorktreeRow(failedWorktreeId);
    expect(retiredRow.state).toBe("retired");
    // Provenance survives, and the retirement event rides the row's own session; the only
    // earlier event is `worktree.created` because `-> failed` emits none.
    expect(retiredRow.created_by_session_id).toBe(SESSION_ID);
    expect(retiredRow.created_by_run_id).toBe(RUN_ID);
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.retired"]);

    const cleanup = await service.cleanupPass();

    // Eligible for removal now. The removal tolerates the directory the failure path already
    // cleared, and the cascade step retires nothing, so the retire call is what made it eligible.
    expect(cleanup.retiredWorktreeIds).toEqual([]);
    expect(cleanup.cleanedWorktreeIds).toEqual([failedWorktreeId]);
    expect(readWorktreeRow(failedWorktreeId).cleaned_at).not.toBeNull();
  });

  it("answers not-found for an unknown worktree", async () => {
    const service = makeService();

    const thrown = await captureRejection(() => service.retire(UNKNOWN_WORKTREE_ID));

    expect(thrown).toBeInstanceOf(WorktreeNotFoundError);
  });
});

// ----------------------------------------------------------------------------
// cleanupPass
// ----------------------------------------------------------------------------

describe("WorktreeService.cleanupPass", () => {
  it("removes a retired root and only then stamps cleaned_at", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);

    const result = await service.cleanupPass();

    expect(result.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(existsSync(created.fsRoot)).toBe(false);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).not.toBeNull();
  });

  it("unregisters the worktree with git as part of the cleanup", async () => {
    // Removing the directory alone leaves a `$GIT_DIR/worktrees/<name>` entry in the user's
    // repository, visible in `git worktree list`, and nothing else in the daemon prunes it.
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);

    await service.cleanupPass();

    expect(ctx.git.worktreeSubcommandArgvs("prune")).toEqual([
      [
        "-c",
        `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
        "-C",
        CANONICAL_ROOT,
        "worktree",
        "prune",
      ],
    ]);
    // The fourth invocation shape, held to both every-invocation assertions.
    assertEveryInvocationIsHookNeutralized();
    assertNoInvocationMutatesTheMainCheckout();
  });

  it("still stamps cleaned_at when the prune fails", async () => {
    // Pruning is best-effort: the removal has already succeeded, and propagating a bookkeeping
    // failure would block every later row in the pass.
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);
    ctx.git.worktreePruneFails = true;

    const result = await service.cleanupPass();

    expect(result.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(existsSync(created.fsRoot)).toBe(false);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).not.toBeNull();
  });

  it("skips a row a concurrent retirement already recorded and finishes the pass", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.db.prepare(`UPDATE repo_mounts SET state = 'detached' WHERE id = ?`).run(REPO_MOUNT_ID);
    const racedService = makeService({
      events: new PreRetiringEmitter({ sessionEvents: ctx.eventLog }),
    });

    const result = await racedService.cleanupPass();

    // The mount is detached and the row was live when the cascade selected it, so it was
    // visited; it is absent from `retiredWorktreeIds` only because the competing retirement was
    // found and skipped. It still reaches the removal step below.
    expect(result.retiredWorktreeIds).toEqual([]);
    expect(result.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).not.toBeNull();
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("propagates a busy hold on the cascade arm instead of sweeping past it", async () => {
    // The cascade retires through the same busy check `retire` uses, and the resulting conflict
    // propagates. The detach guard makes this state unreachable (it refuses to detach while a
    // dependent workspace is busy), so it is built directly: if the tables ever disagree, the
    // sweep must report it rather than retire and delete a root a live run is using.
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.db.prepare(`UPDATE repo_mounts SET state = 'detached' WHERE id = ?`).run(REPO_MOUNT_ID);
    insertWorkspace({ state: "busy", fsRoot: created.fsRoot });

    const thrown = await captureRejection(() => service.cleanupPass());

    expect(thrown).toBeInstanceOf(WorktreeRetireConflictError);
    const conflict = thrown as WorktreeRetireConflictError;
    expect(conflict.holdingWorkspaceId).toBe(WORKSPACE_ID);
    // Nothing after the refusal ran: the row stayed `ready`, no retirement event landed, and the
    // removal step never began.
    const row = readWorktreeRow(created.worktreeId);
    expect(row.state).toBe("ready");
    expect(row.cleaned_at).toBeNull();
    expect(existsSync(created.fsRoot)).toBe(true);
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("defers leg (d) removal while a busy workspace holds the retired root", async () => {
    // The retire-time probe decides at the retirement instant, and `markBusy` requires only
    // `ready`, so a workspace still pointing at the root can become busy afterward. Without the
    // sweep-side deferral the next pass would remove a tree a live run holds.
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);
    insertWorkspace({ state: "busy", fsRoot: created.fsRoot });

    const held = await service.cleanupPass();

    expect(held.cleanedWorktreeIds).toEqual([]);
    expect(existsSync(created.fsRoot)).toBe(true);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).toBeNull();

    // Deferral, not exclusion: once the holder returns to `ready` the next pass removes the root.
    ctx.db.prepare(`UPDATE workspaces SET state = 'ready' WHERE id = ?`).run(WORKSPACE_ID);
    const released = await service.cleanupPass();

    expect(released.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(existsSync(created.fsRoot)).toBe(false);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).not.toBeNull();
  });

  it("re-decides the leg (d) deferral per row, before each removal", async () => {
    // The candidate list is a snapshot: a `markBusy` landing during an earlier row's removal
    // would be invisible to a check made once per pass, and the pass would delete a tree a live
    // run just received. Whichever root is removed first takes a busy hold on the other, since
    // the removal order is not observable here.
    const service = makeService();
    const first = await createReadyWorktree(service);
    const second = await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: "feature/second",
      onCollision: "refuse",
    });
    await service.retire(first.worktreeId);
    await service.retire(second.worktreeId);
    const otherRootOf = new Map([
      [first.fsRoot, second.fsRoot],
      [second.fsRoot, first.fsRoot],
    ]);
    let holdTaken = false;
    const raceInjectingFilesystem: WorktreeFilesystem = {
      createDirectory: (path: string): Promise<void> => {
        mkdirSync(path, { recursive: true });
        return Promise.resolve();
      },
      removeDirectory: (path: string): Promise<void> => {
        const otherRoot = otherRootOf.get(path);
        if (!holdTaken && otherRoot !== undefined) {
          insertWorkspace({ state: "busy", fsRoot: otherRoot });
          holdTaken = true;
        }
        rmSync(path, { recursive: true, force: true });
        return Promise.resolve();
      },
    };
    const racedService = makeService({ filesystem: raceInjectingFilesystem });

    const raced = await racedService.cleanupPass();

    // Exactly one root survived: the one whose hold landed mid-pass.
    expect(raced.cleanedWorktreeIds).toHaveLength(1);
    const survivors = [first, second].filter((worktree) => existsSync(worktree.fsRoot));
    expect(survivors).toHaveLength(1);
    const survivor = survivors[0];
    if (survivor === undefined) {
      throw new Error("expected a surviving worktree root");
    }
    expect(readWorktreeRow(survivor.worktreeId).cleaned_at).toBeNull();

    // Deferral, not exclusion: releasing the hold lets the next pass remove the root.
    ctx.db.prepare(`UPDATE workspaces SET state = 'ready' WHERE id = ?`).run(WORKSPACE_ID);
    const released = await service.cleanupPass();
    expect(released.cleanedWorktreeIds).toEqual([survivor.worktreeId]);
    expect(existsSync(survivor.fsRoot)).toBe(false);
  });

  it("is a no-op on a second pass", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);
    const first = await service.cleanupPass();
    const stampedAt = readWorktreeRow(created.worktreeId).cleaned_at;

    const second = await service.cleanupPass();

    expect(first.cleanedWorktreeIds).toHaveLength(1);
    expect(second.cleanedWorktreeIds).toEqual([]);
    expect(second.retiredWorktreeIds).toEqual([]);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).toBe(stampedAt);
  });

  it("leaves a live worktree on an attached mount alone", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    const result = await service.cleanupPass();

    expect(result).toEqual({ retiredWorktreeIds: [], cleanedWorktreeIds: [] });
    expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
    expect(existsSync(created.fsRoot)).toBe(true);
  });

  it("cascades a retirement onto worktrees whose mount is no longer attached", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.db.prepare(`UPDATE repo_mounts SET state = 'detached' WHERE id = ?`).run(REPO_MOUNT_ID);

    const result = await service.cleanupPass();

    expect(result.retiredWorktreeIds).toEqual([created.worktreeId]);
    expect(readWorktreeRow(created.worktreeId).state).toBe("retired");
    // Cascade-retired, then removed in the same pass.
    expect(result.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready", "worktree.retired"]);
  });
});

// ----------------------------------------------------------------------------
// The typed error vocabulary
// ----------------------------------------------------------------------------

// `name` is a literal per case, never derived from the instance: `DaemonDomainError` sets
// `this.name = new.target.name`, so comparing to `constructor.name` would test JavaScript. The
// literal catches a subclass that shadows `name` and breaks the names logs are searched by.
interface CarrierCase {
  readonly error: DaemonDomainError;
  readonly name: string;
  readonly code: string;
  readonly httpStatus: number;
}

function allCarriers(): readonly CarrierCase[] {
  return [
    {
      error: new WorktreeNotFoundError(UNKNOWN_WORKTREE_ID),
      name: "WorktreeNotFoundError",
      code: "worktree.not_found",
      httpStatus: 404,
    },
    {
      error: new WorktreeCreateFailedError("git_invocation_failed"),
      name: "WorktreeCreateFailedError",
      code: "worktree.create_failed",
      httpStatus: 500,
    },
    {
      error: new WorktreeBranchCollisionError(REPO_MOUNT_ID, "feature/login"),
      name: "WorktreeBranchCollisionError",
      code: "worktree.branch_collision",
      httpStatus: 409,
    },
    {
      error: new WorktreeReuseConflictError(UNKNOWN_WORKTREE_ID, "not_live"),
      name: "WorktreeReuseConflictError",
      code: "worktree.reuse_conflict",
      httpStatus: 409,
    },
    {
      error: new WorktreeRetireConflictError(UNKNOWN_WORKTREE_ID, WORKSPACE_ID),
      name: "WorktreeRetireConflictError",
      code: "worktree.retire_conflict",
      httpStatus: 409,
    },
    {
      error: new WorkspaceBranchMismatchError(WORKSPACE_ID, "feature/login", HEAD_BRANCH),
      name: "WorkspaceBranchMismatchError",
      code: "workspace.branch_mismatch",
      httpStatus: 409,
    },
    {
      error: new WorkspaceExecutionRootUnresolvedError(WORKSPACE_ID, "worktree.create_failed"),
      name: "WorkspaceExecutionRootUnresolvedError",
      code: "workspace.execution_root_unresolved",
      httpStatus: 409,
    },
    {
      error: new WorkspaceBranchNameRequiredError(WORKSPACE_ID),
      name: "WorkspaceBranchNameRequiredError",
      code: "workspace.branch_name_required",
      httpStatus: 400,
    },
  ];
}

function registeredWorkspaceCodes(): readonly string[] {
  return [...WORKTREE_ERROR_CODES, ...WORKSPACE_ERROR_CODES];
}

describe("error vocabulary", () => {
  it("carries the ratified code and notional status on every class", () => {
    for (const carrier of allCarriers()) {
      expect(carrier.error.code).toBe(carrier.code);
      expect(carrier.error.httpStatus).toBe(carrier.httpStatus);
      expect(carrier.error.name).toBe(carrier.name);
    }
  });

  it("covers the two registries exactly", () => {
    const registered = registeredWorkspaceCodes();
    const carried = allCarriers().map((carrier) => carrier.error.code);

    expect([...carried].sort()).toEqual([...registered].sort());
    expect(new Set(registered).size).toBe(registered.length);
  });

  it("declares no carrier for -owned workspace.busy code", () => {
    // `workspace.busy` is already carried by `WorkspaceBusyError` in the workspace service; a
    // second class minting the same code would make `instanceof` depend on the import site.
    expect(registeredWorkspaceCodes()).not.toContain("workspace.busy");
  });

  it("routes not-found carriers to InvalidParams and leaves the rest unset", () => {
    for (const carrier of allCarriers()) {
      if (carrier.code.endsWith(".not_found")) {
        expect(carrier.error.jsonRpcCode).toBe(JsonRpcErrorCode.InvalidParams);
      } else {
        expect(carrier.error.jsonRpcCode).toBeUndefined();
      }
    }
  });

  it("omits the causeCode key entirely when no cause was captured", () => {
    const error = new WorkspaceExecutionRootUnresolvedError(WORKSPACE_ID, null);

    expect(error.causeCode).toBeNull();
    // The absence drops the clause rather than printing the sentinel into prose a user reads.
    expect(error.message).not.toContain("null");
    expect(error.message).toContain("root preparation failed and the run stays parked in setup");
    // The key is omitted rather than carried as `causeCode: null` into `data.fields`.
    expect(error.detail).toEqual({ workspaceId: WORKSPACE_ID });
    expect(error.detail).not.toHaveProperty("causeCode");

    // The contrast pins both sides of the branch.
    const withCause = new WorkspaceExecutionRootUnresolvedError(
      WORKSPACE_ID,
      "worktree.create_failed",
    );
    expect(withCause.message).toContain("worktree.create_failed");
    expect(withCause.detail).toEqual({
      workspaceId: WORKSPACE_ID,
      causeCode: "worktree.create_failed",
    });
  });

  it("never echoes a filesystem path in a creation-failure message", () => {
    // A total `Record` makes the compiler enforce coverage: a reason added to the union without a
    // row here fails to typecheck. `Object.values` keeps the union type where `Object.keys`
    // would widen to `string`.
    const reasons: Record<WorktreeCreateFailureReason, WorktreeCreateFailureReason> = {
      base_ref_option_like: "base_ref_option_like",
      base_ref_unresolved: "base_ref_unresolved",
      branch_name_unavailable: "branch_name_unavailable",
      execution_root_unavailable: "execution_root_unavailable",
      git_invocation_failed: "git_invocation_failed",
      branch_name_underivable: "branch_name_underivable",
    };

    for (const reason of Object.values(reasons)) {
      const error = new WorktreeCreateFailedError(reason);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).not.toMatch(/[\\/]/);
      expect(error.detail).toEqual({ reason });
    }
  });
});
