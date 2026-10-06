// The worktree and execution-root services over real git in hostile fixture repositories: what git
// actually did, that the user's main checkout and branches are never touched, and that no
// repository-controlled hook runs.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../../events/log-service.js";
import { SessionService } from "../../../session/service.js";
import { ExecutionRootService } from "../../../workspace/execution-root-service.js";
import { WorkspaceEventEmitter } from "../../../workspace/event-emitter.js";
import { requireWorkspaceRow } from "../../../workspace/__fixtures__/rows.js";
import {
  buildFixtureEnvironment,
  spawnFixtureGit,
  type FixtureGitResult,
} from "../../__fixtures__/command.js";
import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { WorkspaceService } from "../../../workspace/service.js";
import {
  WorkspaceBranchMismatchError,
  WorktreeBranchCollisionError,
  WorktreeCreateFailedError,
  WorktreeRetireConflictError,
} from "../errors.js";
import { WorktreeEventEmitter } from "../event-emitter.js";
import { WorktreeService } from "../service.js";
import { runGitWithExecFile } from "../../process.js";

// Session, mount, workspace and run ids are parsed as branded UUIDs at the emission boundary.
const SESSION_ID: string = "0191a2b0-1111-7c4a-9b1c-1b7c5b3e8f00";
const REPO_MOUNT_ID: string = "0191a2b0-2222-7f7b-9a32-3d8e7c5f0b21";
const WORKSPACE_ID: string = "0191a2b0-4444-7a8c-8b43-4e9f8d60c132";
const RUN_ID: string = "0191a2b0-7777-7b9d-9c54-5f0a9e71c243";

const DEFAULT_BRANCH: string = "main";
const CLOCK_INSTANT: string = new Date(Date.UTC(2026, 7, 4)).toISOString();

// Well above a fixture build plus several git processes, far below a hung child stalling the run.
vi.setConfig({ testTimeout: 60_000 });

/**
 * The hooks installed in every fixture repository: `worktree add -b` trips `reference-transaction`
 * and `post-checkout`; the rest cover mutating verbs the services never issue. Each exits 0, since
 * a failing `reference-transaction` hook would abort the ref update instead of recording a run.
 */
const SENTINEL_HOOK_NAMES: readonly string[] = [
  "post-checkout",
  "post-merge",
  "reference-transaction",
  "pre-commit",
  "post-commit",
];

// A repo-local `core.fsmonitor=<pathname>` names a hook `core.hooksPath` never governs; the
// services suppress it with `-c core.fsmonitor=false`.
const FSMONITOR_SENTINEL_MARKER: string = "fsmonitor-hook";

/**
 * One real git repository plus the sentinel-hook apparatus. Fixture-side invocations are
 * hook-neutralized like the services', so a marker can only come from a service or from the
 * arming probe that asks for hooks to run.
 */
class FixtureRepository {
  readonly root: string;
  readonly hookMarkerDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #hookNeutralizationDirectory: string;

  constructor(options: {
    readonly root: string;
    readonly hookMarkerDirectory: string;
    readonly hookNeutralizationDirectory: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    this.root = options.root;
    this.hookMarkerDirectory = options.hookMarkerDirectory;
    this.#hookNeutralizationDirectory = options.hookNeutralizationDirectory;
    this.#environment = options.environment;
  }

  /** Throws on any non-zero exit; returns stdout without its trailing newline. */
  async git(argv: readonly string[], cwd: string = this.root): Promise<string> {
    const result = await this.gitCapturing(argv, cwd);
    if (result.exitCode !== 0) {
      throw new Error(
        `fixture git ${argv.join(" ")} exited ${String(result.exitCode)}: ${result.stderr}`,
      );
    }
    return result.stdout.trimEnd();
  }

  gitCapturing(argv: readonly string[], cwd: string = this.root): Promise<FixtureGitResult> {
    return spawnFixtureGit(
      [
        "-c",
        `core.hooksPath=${this.#hookNeutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
        ...argv,
      ],
      this.#environment,
      cwd,
    );
  }

  /** Lets the repository's own hooks run, for the probe that proves the sentinels are armed. */
  gitWithHooksLive(argv: readonly string[]): Promise<FixtureGitResult> {
    return spawnFixtureGit([...argv], this.#environment, this.root);
  }

  /**
   * Installs the `hooks/` sentinels and an fsmonitor sentinel, and returns the pathname the
   * repo-local `core.fsmonitor` must name. The fsmonitor script answers `/`, the valid "everything
   * changed" reply, so a consulted sentinel leaves git correct and only slower.
   */
  installSentinelHooks(): string {
    const hooksDirectory = join(this.root, ".git", "hooks");
    mkdirSync(hooksDirectory, { recursive: true });
    for (const hookName of SENTINEL_HOOK_NAMES) {
      const hookPath = join(hooksDirectory, hookName);
      writeFileSync(
        hookPath,
        `#!/bin/sh\n: > "${join(this.hookMarkerDirectory, hookName)}"\nexit 0\n`,
      );
      chmodSync(hookPath, 0o755);
    }
    const fsmonitorSentinelPath = join(hooksDirectory, "fsmonitor-sentinel");
    writeFileSync(
      fsmonitorSentinelPath,
      `#!/bin/sh\n: > "${join(this.hookMarkerDirectory, FSMONITOR_SENTINEL_MARKER)}"\necho ` +
        `"/"\nexit 0\n`,
    );
    chmodSync(fsmonitorSentinelPath, 0o755);
    return fsmonitorSentinelPath;
  }

  /** The hooks that have run so far, by name, sorted. */
  firedHooks(): readonly string[] {
    return [...readdirSync(this.hookMarkerDirectory)].sort();
  }
}

/**
 * Creates a repository with one commit, the sentinel hooks and a repo-local `core.fsmonitor`, the
 * hostile shape a mounted repository can carry. The commit is required: `worktree add` against an
 * unborn HEAD fails for reasons unrelated to the case.
 */
async function buildFixtureRepository(
  parentDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<FixtureRepository> {
  const root = join(parentDirectory, "mount-repository");
  const hookMarkerDirectory = join(parentDirectory, "hook-markers");
  const hookNeutralizationDirectory = join(parentDirectory, "fixture-hook-neutralization");
  for (const directory of [root, hookMarkerDirectory, hookNeutralizationDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
  const repository = new FixtureRepository({
    root,
    hookMarkerDirectory,
    hookNeutralizationDirectory,
    environment,
  });

  await repository.git(["init", "-q", "."]);
  await repository.git(["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`]);
  writeFileSync(join(root, "README.md"), "# fixture repository\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const answer: number = 42;\n");
  await repository.git(["add", "-A"]);
  await repository.git(["commit", "-q", "-m", "initial commit"]);
  await repository.git(["config", "core.fsmonitor", repository.installSentinelHooks()]);
  return repository;
}

/**
 * Asserts the sentinels really fire, then undoes the trigger: "no hook ran" is evidence only if a
 * hook could have run. A branch create reaches `reference-transaction`; only an un-neutralized
 * `status` reaches the fsmonitor sentinel.
 */
async function proveSentinelsAreArmed(repository: FixtureRepository): Promise<void> {
  expect((await repository.gitWithHooksLive(["branch", "sentinel-arming-probe"])).exitCode).toBe(0);
  expect((await repository.gitWithHooksLive(["status", "--porcelain"])).exitCode).toBe(0);
  expect(repository.firedHooks()).toEqual(
    expect.arrayContaining(["reference-transaction", FSMONITOR_SENTINEL_MARKER]),
  );
  await repository.git(["branch", "-D", "sentinel-arming-probe"]);
  rmSync(repository.hookMarkerDirectory, { recursive: true, force: true });
  mkdirSync(repository.hookMarkerDirectory);
}

/** The main checkout as the user sees it: every file's bytes, HEAD, status and branch tips. */
interface MainCheckoutSnapshot {
  /** `<relative path> <sha256>` for every working-tree file outside `.git`, sorted. */
  readonly workingTree: readonly string[];
  /** The full ref HEAD points at, or null when HEAD is detached. */
  readonly headSymbolicRef: string | null;
  readonly headCommit: string;
  readonly porcelainStatus: string;
  /** `<refname> <objectname>` for every local branch, sorted. */
  readonly branchRoster: string;
}

// Skips `.git`, where a lawful `worktree add` writes administrative files; refs are compared
// through HEAD and the branch roster instead.
function hashWorkingTree(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.name === ".git") {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const digest = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
      entries.push(`${relative(root, absolutePath)} ${digest}`);
    }
  };
  walk(root);
  return entries.sort();
}

async function snapshotMainCheckout(repository: FixtureRepository): Promise<MainCheckoutSnapshot> {
  // `--quiet` makes a detached HEAD a plain exit 1 rather than a fatal 128.
  const headSymbolicRefProbe = await repository.gitCapturing(["symbolic-ref", "--quiet", "HEAD"]);
  return {
    workingTree: hashWorkingTree(repository.root),
    headSymbolicRef:
      headSymbolicRefProbe.exitCode === 0 ? headSymbolicRefProbe.stdout.trim() : null,
    headCommit: await repository.git(["rev-parse", "HEAD"]),
    porcelainStatus: await repository.git(["status", "--porcelain"]),
    branchRoster: await repository.git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]),
  };
}

interface AcceptanceContext {
  readonly fixtureRoot: string;
  readonly executionRootsDirectory: string;
  readonly repository: FixtureRepository;
  readonly scratch: ScratchDatabase;
  /** The test's own read-write connection, for seeding rows and reading them back. */
  readonly db: DatabaseType;
  readonly workspaces: WorkspaceService;
  readonly worktrees: WorktreeService;
  readonly executionRoots: ExecutionRootService;
}

let ctx: AcceptanceContext;

beforeEach(async () => {
  // `realpathSync` because macOS hands out `/var/...` symlinks for the temporary directory while
  // git reports the resolved `/private/var/...`.
  const fixtureRoot: string = realpathSync(
    mkdtempSync(join(tmpdir(), "ai-sidekicks-worktree-acceptance-")),
  );
  const repository = await buildFixtureRepository(
    fixtureRoot,
    buildFixtureEnvironment(fixtureRoot),
  );
  const executionRootsDirectory: string = join(fixtureRoot, "execution-roots");
  const scratch: ScratchDatabase = await openScratchDatabase();
  const db: DatabaseType = new Database(scratch.databasePath);
  const eventLog = new EventLogService({ writer: scratch.writer });
  const clock = (): string => CLOCK_INSTANT;

  const workspaces = new WorkspaceService({
    database: scratch,
    events: new WorkspaceEventEmitter({ sessionEvents: eventLog }),
    sessions: new SessionService(scratch.reader),
    now: clock,
  });
  // No `git` seam: that selects the production `execFile` runner.
  const worktrees = new WorktreeService({
    database: scratch,
    events: new WorktreeEventEmitter({ sessionEvents: eventLog }),
    executionRootsDirectory,
    now: clock,
  });
  const executionRoots = new ExecutionRootService({
    database: scratch,
    workspaces: {
      assertWritable: (workspaceId) => workspaces.assertWritable(workspaceId),
      beginRootPreparation: (workspaceId, targetMode) =>
        workspaces.beginRootPreparation(workspaceId, targetMode),
      completeRootPreparation: (workspaceId, fsRoot) =>
        workspaces.completeRootPreparation(workspaceId, fsRoot),
      failRootPreparation: (workspaceId, detail) =>
        workspaces.failRootPreparation(workspaceId, detail),
    },
    worktrees,
    executionRootsDirectory,
    git: runGitWithExecFile,
    filesystem: {
      createDirectory: async (path: string): Promise<void> => {
        await mkdir(path, { recursive: true });
      },
    },
    now: clock,
  });

  ctx = {
    fixtureRoot,
    executionRootsDirectory,
    repository,
    scratch,
    db,
    workspaces,
    worktrees,
    executionRoots,
  };

  db.prepare(
    `INSERT INTO repo_mounts (
       id, node_id, local_path, canonical_root, state, attached_at, updated_at
     ) VALUES (?, 'node-1', ?, ?, 'attached', ?, ?)`,
  ).run(REPO_MOUNT_ID, repository.root, repository.root, CLOCK_INSTANT, CLOCK_INSTANT);
});

afterEach(async () => {
  ctx.db.close();
  await ctx.scratch.close();
  rmSync(ctx.fixtureRoot, { recursive: true, force: true });
});

/** Seeds a `ready` workspace whose root is the main checkout, as a bound workspace starts. */
function insertWorkspace(executionMode: "bound-root" | "provisioned-worktree"): void {
  ctx.db
    .prepare(
      `INSERT INTO workspaces (
         id, session_id, repo_mount_id, execution_mode, fs_root, state,
         metadata, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'ready', '{}', ?, ?)`,
    )
    .run(
      WORKSPACE_ID,
      SESSION_ID,
      REPO_MOUNT_ID,
      executionMode,
      ctx.repository.root,
      CLOCK_INSTANT,
      CLOCK_INSTANT,
    );
}

function readWorktreeRows(): readonly { readonly state: string; readonly fs_root: string }[] {
  return ctx.db
    .prepare<[], { state: string; fs_root: string }>(`SELECT state, fs_root FROM worktrees`)
    .all();
}

function prepare(branchName: string) {
  return ctx.executionRoots.prepare({ workspaceId: WORKSPACE_ID, branchName, runId: RUN_ID });
}

async function prepareWorktree(branchName: string) {
  const prepared = await prepare(branchName);
  if (prepared.worktreeId === undefined) {
    throw new Error("expected a provisioned worktree");
  }
  return { ...prepared, worktreeId: prepared.worktreeId };
}

function createWorktree(branchName: string, baseRef?: string) {
  return ctx.worktrees.create({
    repoMountId: REPO_MOUNT_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    branchName,
    onCollision: "refuse",
    ...(baseRef === undefined ? {} : { baseRef }),
  });
}

describe("provisioned-worktree mode on real git", () => {
  it(
    "provisions a real linked worktree on a branch cut from the mount HEAD, never the main " +
      "checkout",
    async () => {
      insertWorkspace("provisioned-worktree");
      const mainCommit: string = await ctx.repository.git(["rev-parse", DEFAULT_BRANCH]);
      // An ambient `GIT_OBJECT_DIRECTORY` naming nothing makes every git call exit 128 unless the
      // runner strips it.
      const poisonedObjectDirectory: string = join(ctx.fixtureRoot, "absent-object-directory");
      let prepared: Awaited<ReturnType<typeof prepareWorktree>>;
      try {
        vi.stubEnv("GIT_OBJECT_DIRECTORY", poisonedObjectDirectory);
        prepared = await prepareWorktree("feature/login");
      } finally {
        vi.unstubAllEnvs();
      }

      expect(prepared.executionMode).toBe("provisioned-worktree");
      expect(prepared.executionRoot).toBe(
        join(ctx.executionRootsDirectory, REPO_MOUNT_ID, "worktrees", prepared.worktreeId),
      );
      expect(requireWorkspaceRow(ctx.db, WORKSPACE_ID)).toMatchObject({
        fs_root: prepared.executionRoot,
        state: "ready",
      });
      // Real git is the authority: the branch sits at the mount HEAD, checked out and populated in
      // the new root, while the main checkout stays on its own branch.
      expect(await ctx.repository.git(["rev-parse", "feature/login"])).toBe(mainCommit);
      expect(
        await ctx.repository.git(["symbolic-ref", "--short", "HEAD"], prepared.executionRoot),
      ).toBe("feature/login");
      expect(readFileSync(join(prepared.executionRoot, "README.md"), "utf8")).toBe(
        "# fixture repository\n",
      );
      expect(await ctx.repository.git(["symbolic-ref", "HEAD"])).toBe(
        `refs/heads/${DEFAULT_BRANCH}`,
      );
      expect(existsSync(poisonedObjectDirectory)).toBe(false);
    },
  );

  it(
    "runs no repository hook, refuses to retire a " +
      "busy worktree, and removes it only at cleanup",
    async () => {
      await proveSentinelsAreArmed(ctx.repository);
      insertWorkspace("provisioned-worktree");
      const prepared = await prepareWorktree("feature/login");

      // Retiring a root a running run holds would pull it out from under the run.
      await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);
      expect(
        await captureRejection(() => ctx.worktrees.retire(prepared.worktreeId)),
      ).toBeInstanceOf(WorktreeRetireConflictError);
      await ctx.workspaces.releaseBusy(WORKSPACE_ID);

      await ctx.worktrees.retire(prepared.worktreeId);
      expect(existsSync(prepared.executionRoot)).toBe(true);
      expect(await ctx.worktrees.cleanupPass()).toMatchObject({
        cleanedWorktreeIds: [prepared.worktreeId],
      });
      expect(existsSync(prepared.executionRoot)).toBe(false);
      // `worktree prune` really ran: a stale registration would keep holding the branch.
      expect(await ctx.repository.git(["worktree", "list", "--porcelain"])).not.toContain(
        prepared.executionRoot,
      );
      expect(ctx.repository.firedHooks()).toEqual([]);
    },
  );

  it(
    "leaves no branch deleted, no root, no live row and the main checkout byte-identical on " +
      "every refusal",
    async () => {
      await ctx.repository.git(["branch", "release"]);
      await ctx.repository.git(["branch", "feature/taken"]);
      const live = await createWorktree("feature/live");
      insertWorkspace("provisioned-worktree");
      const before = await snapshotMainCheckout(ctx.repository);

      // `worktree add -b -D <path> release` would hand `-D` to git as an option and delete
      // `release`.
      const optionLikeName = await captureRejection(() => createWorktree("-D", "release"));
      expect(optionLikeName).toBeInstanceOf(WorktreeCreateFailedError);
      expect(optionLikeName).toMatchObject({ reason: "branch_name_invalid" });
      // A branch git holds that no row knows of.
      const takenInGit = await captureRejection(() => createWorktree("feature/taken"));
      expect(takenInGit).toBeInstanceOf(WorktreeCreateFailedError);
      expect(takenInGit).toMatchObject({ reason: "git_invocation_failed" });
      // A failed provision blocks the run and parks the workspace; it never falls back to a root.
      expect(await captureRejection(() => prepare("feature/taken"))).toBeInstanceOf(
        WorktreeCreateFailedError,
      );
      expect(requireWorkspaceRow(ctx.db, WORKSPACE_ID).state).toBe("stale");

      expect(await snapshotMainCheckout(ctx.repository)).toEqual(before);
      const rows = readWorktreeRows();
      expect(rows.filter((row) => row.state !== "failed").map((row) => row.fs_root)).toEqual([
        live.fsRoot,
      ]);
      for (const failedRow of rows.filter((row) => row.state === "failed")) {
        expect(existsSync(failedRow.fs_root)).toBe(false);
      }
    },
  );

  it("refuses a second worktree on a branch a live worktree holds", async () => {
    insertWorkspace("provisioned-worktree");
    const first = await prepareWorktree("feature/login");

    // A reuse here would hand this run another run's tree.
    expect(await captureRejection(() => prepare("feature/login"))).toBeInstanceOf(
      WorktreeBranchCollisionError,
    );
    expect(readWorktreeRows()).toEqual([{ state: "ready", fs_root: first.executionRoot }]);
  });
});

describe("bound-root mode on real git", () => {
  it("binds the main checkout without moving a byte, refusing it once HEAD detaches", async () => {
    insertWorkspace("bound-root");
    const before = await snapshotMainCheckout(ctx.repository);

    const prepared = await prepare(DEFAULT_BRANCH);

    expect(prepared.executionMode).toBe("bound-root");
    expect(prepared.executionRoot).toBe(ctx.repository.root);
    expect(await snapshotMainCheckout(ctx.repository)).toEqual(before);

    // A detached HEAD makes `symbolic-ref --quiet` exit 1; read as a mismatch, the bind refuses
    // rather than letting a run commit onto no branch.
    await ctx.repository.git(["checkout", "--quiet", "--detach", "HEAD"]);
    const detached = await snapshotMainCheckout(ctx.repository);
    const rejection = await captureRejection(() => prepare(DEFAULT_BRANCH));
    expect(rejection).toBeInstanceOf(WorkspaceBranchMismatchError);
    expect(rejection).toMatchObject({ currentBranchName: "(detached HEAD)" });
    expect(await snapshotMainCheckout(ctx.repository)).toEqual(detached);
  });
});
