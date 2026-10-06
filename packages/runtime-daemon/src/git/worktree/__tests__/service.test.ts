// The worktree service's refusals and recoveries that real git cannot reach, the slug rules and
// the error vocabulary: races, an injected append failure, and the guards that keep a live or
// foreign tree from being bound or removed. Real SQLite and event log; a fake in place of git.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceState } from "@ai-sidekicks/contracts/repo/mount";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch-file.js";
import { EventLogService } from "../../../events/log-service.js";
import type { EventLogAppendReceipt } from "../../../events/log-service.js";
import { RepoMountNotFoundError } from "../../../workspace/repo/errors.js";
import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { WorktreeEventEmitter } from "../event-emitter.js";
import type { EmitWorktreeEventInput } from "../event-emitter.js";
import { WorktreeCreateFailedError, WorktreeRetireConflictError } from "../errors.js";
import type { WorktreeCreateFailureReason } from "../errors.js";
import { WorktreeService } from "../service.js";
import { deriveWorktreeBranchName } from "../branch-name.js";
import type { CreateWorktreeInput, CreatedWorktree, WorktreeServiceDeps } from "../service.js";
import type { GitFilesystem } from "../../filesystem.js";
import type { GitInvocationResult, GitRunner } from "../../process.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// The emitter and `retire` parse ids through UUID schemas, so every fixture id is a real UUID.
const SESSION_ID: string = "0190f8b0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const REPO_MOUNT_ID: string = "0190f8b2-2d4e-7f7b-9a32-3d8e7c5f0b21";
const OTHER_REPO_MOUNT_ID: string = "0190f8b5-5a7b-7c9d-8e54-6f0a9e82d354";
const WORKSPACE_ID: string = "0190f8b3-3e5f-7a8c-8b43-4e9f8d60c132";
const RUN_ID: string = "0190f8b4-4f60-7b9d-9c54-5f0a9e71c243";

// `idx_repo_mounts_active_root` is UNIQUE over (node_id, canonical_root) for attached rows, so a
// second mount on the same node needs a root of its own.
const CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-mount";
const OTHER_CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-other-mount";
const HEAD_BRANCH: string = "main";
const NOW: string = "2026-08-04T00:00:00.000Z";

// The name a caller derives before handing `create` an explicit name; the service derives nothing.
const DERIVED_BRANCH_NAME: string = deriveWorktreeBranchName({
  sessionId: SESSION_ID,
  runId: RUN_ID,
  taskSummary: "Fix login",
});

// ----------------------------------------------------------------------------
// The recording fake git
// ----------------------------------------------------------------------------

interface RecordedGitInvocation {
  readonly argv: readonly string[];
}

function resolveGit(stdout: string): Promise<GitInvocationResult> {
  return Promise.resolve({ stdout: Buffer.from(stdout, "utf8"), stderr: "" });
}

/**
 * Records every invocation and answers the verbs the service issues: `symbolic-ref`,
 * `check-ref-format` (every name valid), `for-each-ref` (no branch exists), and `worktree`
 * with `add` or `prune`.
 *
 * `worktree add` creates the target directory, because the cleanup pass must be seen removing a
 * real root. An unrecognized verb or `worktree` subcommand rejects, so an unexpected git call
 * fails the case.
 */
class FakeGit {
  readonly invocations: RecordedGitInvocation[] = [];

  readonly run: GitRunner = (argv) => {
    this.invocations.push({ argv: [...argv] });
    // argv is `-c core.hooksPath=… -c core.fsmonitor=false -C <dir> <verb> …`: the verb is
    // index 6 and a `worktree` subcommand is index 7.
    const verb: string | undefined = argv[6];

    if (verb === "symbolic-ref") {
      return resolveGit(`${HEAD_BRANCH}\n`);
    }

    if (verb === "check-ref-format" || verb === "for-each-ref") {
      return resolveGit("");
    }

    if (verb === "worktree") {
      const subcommand: string | undefined = argv[7];
      if (subcommand === "prune") {
        return resolveGit("");
      }
      if (subcommand === "add") {
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

    return Promise.reject(new Error(`unexpected git verb in fixture: ${String(verb)}`));
  };

  verbs(): readonly (string | undefined)[] {
    return this.invocations.map((invocation) => invocation.argv[6]);
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
  scratch: ScratchDatabase;
  /** The test's own read-write connection, for seeding rows and reading them back. */
  db: DatabaseType;
  eventLog: EventLogService;
  emitter: WorktreeEventEmitter;
  git: FakeGit;
  executionRootsDirectory: string;
  hookNeutralizationDirectory: string;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(async () => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-worktree-service-test-"));
  const scratch: ScratchDatabase = await openScratchDatabase();
  const db: DatabaseType = new Database(scratch.databasePath);
  const eventLog = new EventLogService({ writer: scratch.writer });
  const executionRootsDirectory: string = join(tmpDir, "execution-roots");
  ctx = {
    scratch,
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

afterEach(async () => {
  ctx.db.close();
  await ctx.scratch.close();
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeService(overrides: Partial<WorktreeServiceDeps> = {}): WorktreeService {
  return new WorktreeService({
    database: ctx.scratch,
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

/** The happy path, reused by the retire and cleanup blocks; it uses the `refuse` policy. */
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
// The race injector performs its interfering write and then delegates to `super`: the write
// commits just before the append's write is taken, a window a check made outside that write
// cannot see. The failure injector rejects without calling `super`, so
// no append transaction opens.

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

/** The failure the `worktree.ready` append rejects with. */
const READY_EMISSION_FAILURE: Error = new Error("fixture: the worktree.ready append failed");

class ReadyEmissionFailingEmitter extends WorktreeEventEmitter {
  override emitWorktreeReady(): Promise<EventLogAppendReceipt> {
    return Promise.reject(READY_EMISSION_FAILURE);
  }
}

// ----------------------------------------------------------------------------
// deriveWorktreeBranchName
// ----------------------------------------------------------------------------

// The slug rules that keep a derived name a valid, bounded ref. The third column is the slug
// alone; the assertion wraps it in `sidekicks/<session-short-id>/`.
const SLUG_CASES: ReadonlyArray<readonly [string, string | null, string]> = [
  ["lowercases and hyphenates a plain summary", "Fix the login bug", "fix-the-login-bug"],
  [
    "collapses runs of non-alphanumerics and trims the edges",
    "  !!Hello,   World!!  ",
    "hello-world",
  ],
  [
    "truncates at the last boundary inside 40 characters",
    "Add support for reading project files with tables",
    "add-support-for-reading-project-files",
  ],
  ["falls back to the run short id when the summary is punctuation", "---", "run-9e71c243"],
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
});

// ----------------------------------------------------------------------------
// create
// ----------------------------------------------------------------------------

describe("WorktreeService.create", () => {
  it("frees the bare name in the active-branch index once the colliding row retires", async () => {
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
// retire
// ----------------------------------------------------------------------------

describe("WorktreeService.retire", () => {
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
});

// ----------------------------------------------------------------------------
// cleanupPass
// ----------------------------------------------------------------------------

describe("WorktreeService.cleanupPass", () => {
  it("re-decides the removal deferral per row, before each removal", async () => {
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
    const raceInjectingFilesystem: GitFilesystem = {
      createDirectory: (path: string): Promise<void> => {
        mkdirSync(path, { recursive: true });
        return Promise.resolve();
      },
      removePath: (path: string): Promise<void> => {
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

  it("refuses to remove a stored root this service did not mint", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);
    // A row whose root was rewritten out of band to the hooks directory beside the mount roots.
    ctx.db
      .prepare(`UPDATE worktrees SET fs_root = ? WHERE id = ?`)
      .run(ctx.hookNeutralizationDirectory, created.worktreeId);
    const removedPaths: string[] = [];
    const recordingFilesystem: GitFilesystem = {
      createDirectory: (path: string): Promise<void> => {
        mkdirSync(path, { recursive: true });
        return Promise.resolve();
      },
      removePath: (path: string): Promise<void> => {
        removedPaths.push(path);
        return Promise.resolve();
      },
    };

    const refusal = await captureRejection(() =>
      makeService({ filesystem: recordingFilesystem }).cleanupPass(),
    );

    expect(refusal).toBeInstanceOf(Error);
    expect(removedPaths).toEqual([]);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).toBeNull();
  });

  it("leaves a live worktree on an attached mount alone", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    const result = await service.cleanupPass();

    expect(result).toEqual({ retiredWorktreeIds: [], cleanedWorktreeIds: [] });
    expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
    expect(existsSync(created.fsRoot)).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// The typed error vocabulary
// ----------------------------------------------------------------------------

describe("error vocabulary", () => {
  it("never echoes a filesystem path in a creation-failure message", () => {
    // A total `Record` makes the compiler enforce coverage: a reason added to the union without a
    // row here fails to typecheck. `Object.values` keeps the union type where `Object.keys`
    // would widen to `string`.
    type TableReason = Exclude<WorktreeCreateFailureReason, "branch_name_invalid">;
    const reasons: Record<TableReason, TableReason> = {
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
