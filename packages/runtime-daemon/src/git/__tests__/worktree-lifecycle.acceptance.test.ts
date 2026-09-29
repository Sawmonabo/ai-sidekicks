// Worktree-lifecycle acceptance suite.
//
// The ACCEPTANCE tier for the git services: `../worktree-service.ts` and
// `../../workspace/execution-root-service.ts`, driven over REAL git repositories
// in temporary directories. The sibling unit suites assert what the services ASK
// git to do by recording argv against a fake; this suite asserts what git
// actually DID, which is the only tier where a modeling mistake in those fakes
// can be caught.
//
// Two harness choices carry the evidential weight:
//
//   * The git seam of `WorktreeService` is left at its PRODUCTION default —
//     `execFile` against the real `git` binary. The services are therefore
//     exercised through the same process seam a daemon uses; nothing about the
//     invocation is modeled here. `ExecutionRootService`
//     takes its `git` / `filesystem` seams with no defaults, so this suite
//     supplies real ones rather than stubs.
//   * Every fixture repository is HOSTILE: sentinel hooks are installed in its
//     `.git/hooks` before any service touches it, and each one records that it
//     ran. Fixture-side git is itself hook-neutralized, so the presence of ANY
//     marker is caused by a service invocation and nothing else. The negative
//     control below runs one un-neutralized `worktree add` and asserts the
//     markers DO appear — without it, "no hooks fired" would be satisfied by
//     sentinels that were never armed.
//
// Several arms mutate the repository (branch creation, a real merge, a
// pre-created colliding branch, a detached HEAD), and a shared repository
// would let one case's refs decide another case's outcome. The cost is one
// `git init` + commit per test.
//
// Coverage map:
//
//   * the main checkout is never mutated as a hidden fallback. Asserted as GROUND
//     TRUTH: a content hash of every working-tree file, plus HEAD's symbolic ref,
//     HEAD's commit, `status --porcelain` and the branch roster, compared before and
//     after every failure path in one pass.
//   * a run on a git repo defaults to provisioned-worktree mode. Asserted at the
//     capability projection AND end-to-end through `ExecutionRootService.prepare`,
//     which materializes a real linked worktree.
//   * worktree creation failure blocks the run instead of mutating the main
//     checkout. Both divergence arms (`refuse` and `suffix`) surface a typed
//     refusal, mark the row `failed`, leave no root behind, and leave the checkout
//     byte-identical.
//   * a reused worktree stays explicitly linked to its branch and prior run
//     context — same worktree, same root, same `branch_contexts` row (id and
//     `created_at` preserved), provenance intact.
//
// Verifies invariant:
//
//   * No path checks out, creates, switches or merges branches inside the
//     mount's main checkout. The byte-identity pass is the ground truth; the
//     merge arm shows that even a MERGED branch is observed as a git fact rather
//     than produced by the daemon.
//   * No silent mode substitution: a failed materialization refuses with the
//     typed carrier and lands the workspace in `stale` with the failure
//     recorded, rather than returning a lesser mode or a fallback root.
//   * Explicit reuse only: a candidate binds solely via `reuseWorktreeId`, a
//     dirty candidate needs `acknowledgeDirtyCandidate` as well, and a prepare
//     that omits the id REFUSES rather than rebinding.
//   * No repository-controlled code executes during provisioning: the
//     hostile hooks never fire for any service invocation — the
//     `hooks/`-resident sentinels `core.hooksPath` redirects away AND the
//     config-named fsmonitor hook `-c core.fsmonitor=false` suppresses — and
//     the neutralization directory the services point `core.hooksPath` at is
//     empty.
//   * Every observed lifecycle transition emits its mapped event: the
//     full-sequence event assertions on the lifecycle walks
//     (create→reuse→retire→cleanup and the failure arms) are the evidence the
//     emitter and its unit suite delegate to this tier — a thinned sequence
//     assertion here breaks that hand-off.

import { execFile } from "node:child_process";
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

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService } from "../../session/session-service.js";
import { ExecutionRootService } from "../../workspace/execution-root-service.js";
import type {
  ExecutionRootGitRunner,
  WorkspaceLifecyclePrimitives,
} from "../../workspace/execution-root-service.js";
import { WorkspaceEventEmitter } from "../../workspace/workspace-event-emitter.js";
import { computeExecutionModeCapabilities } from "../../workspace/workspace-projector.js";
import { WorkspaceService } from "../../workspace/workspace-service.js";
import {
  WorkspaceBranchMismatchError,
  WorktreeBranchCollisionError,
  WorktreeCreateFailedError,
  WorktreeRetireConflictError,
  WorktreeReuseConflictError,
} from "../worktree-errors.js";
import { WorktreeEventEmitter } from "../worktree-event-emitter.js";
import { WorktreeService, deriveWorktreeBranchName } from "../worktree-service.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// Session, mount, workspace and worktree ids travel branded UUID schemas at the
// emission boundary, so every fixture id is a real UUID.
const SESSION_ID: string = "0191a2b0-1111-7c4a-9b1c-1b7c5b3e8f00";
const REPO_MOUNT_ID: string = "0191a2b0-2222-7f7b-9a32-3d8e7c5f0b21";
const WORKSPACE_ID: string = "0191a2b0-4444-7a8c-8b43-4e9f8d60c132";
const BOUND_ROOT_WORKSPACE_ID: string = "0191a2b0-8888-7a8c-8b43-4e9f8d60c135";
const RUN_ID: string = "0191a2b0-7777-7b9d-9c54-5f0a9e71c243";

const DEFAULT_BRANCH: string = "main";
const EPOCH_MS: number = Date.UTC(2026, 7, 4, 0, 0, 0);

/** Wall-clock ceiling for fixture-side git. Generous: these are cold processes. */
const FIXTURE_GIT_TIMEOUT_MS: number = 30_000;

/**
 * Per-test ceiling. Well above the observed cost of a fixture build plus a
 * handful of git processes, and far below anything that would let a hung child
 * stall the run — vitest's 5s default is not enough for a case that spawns
 * several git processes.
 */
const ACCEPTANCE_TEST_TIMEOUT_MS: number = 60_000;

/**
 * The hooks installed in every fixture repository.
 *
 * Chosen for what a provisioning invocation would actually trip: `git worktree
 * add -b` writes a ref (`reference-transaction`) and populates a checkout
 * (`post-checkout`); `post-merge`, `pre-commit` and `post-commit` cover the
 * mutating verbs says are never issued at all. Each script exits 0 — a
 * `reference-transaction` hook that failed would abort the ref update and turn a
 * hook-neutralization case into a git-failure case.
 */
const SENTINEL_HOOK_NAMES: readonly string[] = [
  "post-checkout",
  "post-merge",
  "reference-transaction",
  "pre-commit",
  "post-commit",
];

/**
 * The marker the config-named fsmonitor sentinel writes.
 *
 * Deliberately NOT a member of {@link SENTINEL_HOOK_NAMES}: those are
 * `hooks/`-resident files `core.hooksPath` redirects away, while the fsmonitor
 * hook is named by a repo-local `core.fsmonitor=<pathname>` that
 * `core.hooksPath` never governs. The services suppress it with
 * `-c core.fsmonitor=false`, and the mechanism-attribution control below is
 * what proves that second flag is load-bearing rather than decorative.
 */
const FSMONITOR_SENTINEL_MARKER: string = "fsmonitor-hook";

/** A fixed-key signing source — enough for a suite that only ever signs. */
const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(7) as Ed25519PrivateKey;

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
// Real git, fixture side
// ----------------------------------------------------------------------------

interface FixtureGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Build the environment fixture git runs under.
 *
 * Hermetic by construction: system and global configuration are switched off,
 * `HOME` and `XDG_CONFIG_HOME` point inside the fixture, and every discovery
 * redirector inherited from the ambient environment is stripped. These fixtures
 * are built while the process working directory is the repository under
 * development, and a `GIT_DIR` leaking in from the harness would point fixture
 * commands at THAT repository.
 */
function buildFixtureEnvironment(fixtureRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
  ]) {
    delete environment[key];
  }
  environment["HOME"] = fixtureRoot;
  environment["XDG_CONFIG_HOME"] = join(fixtureRoot, "xdg");
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_CONFIG_GLOBAL"] = join(fixtureRoot, "absent-global-gitconfig");
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  environment["GIT_AUTHOR_NAME"] = "Fixture Author";
  environment["GIT_AUTHOR_EMAIL"] = "fixture@example.invalid";
  environment["GIT_COMMITTER_NAME"] = "Fixture Author";
  environment["GIT_COMMITTER_EMAIL"] = "fixture@example.invalid";
  return environment;
}

/**
 * Spawn git and RESOLVE on any exit status, rejecting only when there was no
 * exit status at all.
 *
 * The distinction matters for the assertions built on top: `merge-base
 * --is-ancestor` reports its answer as an exit code, so a helper that threw on
 * non-zero could not ask the question. A missing binary or a killed process
 * carries a string `code` (or none) instead, and that is a harness fault rather
 * than an answer.
 */
function spawnGit(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<FixtureGitResult> {
  return new Promise<FixtureGitResult>((resolve, reject) => {
    execFile(
      "git",
      [...argv],
      { encoding: "utf8", env: environment, cwd, timeout: FIXTURE_GIT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        // `ExecFileException.code` admits `null` as well as the string codes a
        // spawn failure carries; only a NUMBER is an exit status.
        const reportedCode: number | string | null | undefined = error.code;
        if (typeof reportedCode !== "number") {
          reject(new Error(`fixture git ${argv.join(" ")} did not run: ${String(error.message)}`));
          return;
        }
        resolve({ exitCode: reportedCode, stdout, stderr });
      },
    ).on("error", reject);
  });
}

/**
 * One real git repository under a temporary root, plus the sentinel-hook
 * apparatus that makes assertable.
 *
 * Fixture-side invocations are hook-neutralized by DEFAULT, the same way the
 * services neutralize theirs. That is what gives the marker directory its
 * meaning: a marker can only have been written by an invocation this class did
 * not issue — i.e. by a service — or by the one deliberate negative control that
 * asks for hooks to run.
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

  /** Hook-neutralized invocation; throws on any non-zero exit. */
  async git(argv: readonly string[], cwd: string = this.root): Promise<string> {
    const result = await this.gitCapturing(argv, cwd);
    if (result.exitCode !== 0) {
      throw new Error(
        `fixture git ${argv.join(" ")} exited ${String(result.exitCode)}: ${result.stderr}`,
      );
    }
    return result.stdout;
  }

  /** Hook-neutralized invocation; the caller inspects the exit status itself. */
  gitCapturing(argv: readonly string[], cwd: string = this.root): Promise<FixtureGitResult> {
    return spawnGit(
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

  /**
   * The first escape hatch: an invocation that lets the repository's own hooks
   * run. Reserved for the controls that prove the sentinels are armed.
   */
  gitWithHooksLive(argv: readonly string[], cwd: string = this.root): Promise<FixtureGitResult> {
    return spawnGit([...argv], this.#environment, cwd);
  }

  /**
   * The second escape hatch: `core.hooksPath` neutralized, `core.fsmonitor`
   * left alone. Reserved for the mechanism-attribution control — the
   * config-named fsmonitor hook fires through this form and through nothing
   * {@link gitCapturing} issues, which is what pins the services' second flag
   * as load-bearing.
   */
  gitWithHooksPathOnly(
    argv: readonly string[],
    cwd: string = this.root,
  ): Promise<FixtureGitResult> {
    return spawnGit(
      ["-c", `core.hooksPath=${this.#hookNeutralizationDirectory}`, ...argv],
      this.#environment,
      cwd,
    );
  }

  /**
   * Install the `hooks/`-resident sentinels plus the fsmonitor sentinel script,
   * and return the pathname the repo-local `core.fsmonitor` must point at —
   * config the CALLER writes, because this method spawns nothing.
   *
   * The fsmonitor script answers the hook protocol honestly: `/` on stdout is
   * the valid "consider everything changed" reply, so a consulted sentinel
   * leaves git CORRECT and merely slower — a sentinel that broke `status` would
   * turn a neutralization case into a git-failure case.
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
      `#!/bin/sh\n: > "${join(this.hookMarkerDirectory, FSMONITOR_SENTINEL_MARKER)}"\necho "/"\nexit 0\n`,
    );
    chmodSync(fsmonitorSentinelPath, 0o755);
    return fsmonitorSentinelPath;
  }

  /** The hooks that have run so far, by name, sorted. */
  firedHooks(): readonly string[] {
    return [...readdirSync(this.hookMarkerDirectory)].sort();
  }

  clearFiredHooks(): void {
    for (const markerName of readdirSync(this.hookMarkerDirectory)) {
      rmSync(join(this.hookMarkerDirectory, markerName), { force: true });
    }
  }
}

/**
 * Create a repository with one commit and the sentinel hooks installed.
 *
 * `git init` followed by `symbolic-ref HEAD` rather than `git init -b main`: the
 * hermetic environment above switches off the configuration that would otherwise
 * name a default branch, and this repository has no ratified minimum git version
 * to lean on for the newer flag. The initial commit is not optional — a `create`
 * against an unborn HEAD resolves a base ref that names no commit, and
 * `worktree add` would then fail for a reason that has nothing to do with the
 * case under test.
 */
async function buildFixtureRepository(options: {
  readonly parentDirectory: string;
  readonly name: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly hookNeutralizationDirectory: string;
}): Promise<FixtureRepository> {
  const root = join(options.parentDirectory, options.name);
  const hookMarkerDirectory = join(options.parentDirectory, `${options.name}-hook-markers`);
  mkdirSync(root, { recursive: true });
  mkdirSync(hookMarkerDirectory, { recursive: true });

  const repository = new FixtureRepository({
    root,
    hookMarkerDirectory,
    hookNeutralizationDirectory: options.hookNeutralizationDirectory,
    environment: options.environment,
  });

  await repository.git(["init", "-q", "."]);
  await repository.git(["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`]);
  writeFileSync(join(root, "README.md"), "# fixture repository\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const answer: number = 42;\n");
  await repository.git(["add", "-A"]);
  await repository.git(["commit", "-q", "-m", "initial commit"]);
  const fsmonitorSentinelPath = repository.installSentinelHooks();
  // Repo-local, which is the hostile shape: a mounted repository can carry this
  // value, and `core.hooksPath` does not govern it.
  await repository.git(["config", "core.fsmonitor", fsmonitorSentinelPath]);
  return repository;
}

/**
 * Assert that THIS repository's sentinels really fire, then undo the trigger.
 *
 * "No hook ran" is only evidence if a hook could have run, and the negative
 * control below uses a throwaway repository of its own — so a mount fixture that
 * silently failed to install its hooks would satisfy every assertion vacuously.
 * A ref update is the smallest un-neutralized trigger available for the
 * `hooks/`-resident sentinels: it fires `reference-transaction` and leaves
 * nothing behind once the branch is deleted. The fsmonitor sentinel needs its
 * own arming probe because no `hooks/`-resident trigger reaches it — an
 * un-neutralized `status` refreshes the index and must consult the repo-local
 * `core.fsmonitor` pathname.
 */
async function proveSentinelsAreArmed(repository: FixtureRepository): Promise<void> {
  const armingProbe = await repository.gitWithHooksLive(["branch", "sentinel-arming-probe"]);
  expect(armingProbe.exitCode).toBe(0);
  expect(repository.firedHooks()).toContain("reference-transaction");
  await repository.git(["branch", "-D", "sentinel-arming-probe"]);
  const fsmonitorArmingProbe = await repository.gitWithHooksLive(["status", "--porcelain"]);
  expect(fsmonitorArmingProbe.exitCode).toBe(0);
  expect(repository.firedHooks()).toContain(FSMONITOR_SENTINEL_MARKER);
  repository.clearFiredHooks();
}

// ----------------------------------------------------------------------------
// Main-checkout ground truth
// ----------------------------------------------------------------------------

interface MainCheckoutSnapshot {
  /** `<relative path> <sha256>` for every working-tree file, sorted. */
  readonly workingTree: readonly string[];
  /** Full ref HEAD points at, or null when HEAD is detached. */
  readonly headSymbolicRef: string | null;
  readonly headCommit: string;
  readonly porcelainStatus: string;
  /** `<refname> <objectname>` for every local branch, sorted. */
  readonly branchRoster: readonly string[];
}

/**
 * Hash the working tree, skipping `.git`.
 *
 * `.git` is excluded deliberately: a lawful `worktree add` DOES write
 * administrative files there, and the claim is about the CHECKOUT — the files a
 * user has open and the branch they are on. The ref roster and HEAD are
 * captured separately, through git, so ref-level changes are still in the
 * comparison without dragging worktree bookkeeping into it.
 */
function hashWorkingTree(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const absolutePath = join(directory, entry.name);
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
  const branchRoster = await repository.git([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads",
  ]);
  // `--quiet` turns detachment into a plain exit 1 instead of a fatal 128, so
  // the ONE snapshot helper serves attached and detached checkouts alike — a
  // null here doubles as the detachment premise the bound-root refusal case
  // asserts on before exercising the seam.
  const headSymbolicRefProbe = await repository.gitCapturing(["symbolic-ref", "--quiet", "HEAD"]);
  return {
    workingTree: hashWorkingTree(repository.root),
    headSymbolicRef:
      headSymbolicRefProbe.exitCode === 0 ? headSymbolicRefProbe.stdout.trim() : null,
    headCommit: (await repository.git(["rev-parse", "HEAD"])).trim(),
    porcelainStatus: await repository.git(["status", "--porcelain"]),
    branchRoster: branchRoster
      .split("\n")
      .filter((line) => line !== "")
      .sort(),
  };
}

// ----------------------------------------------------------------------------
// Per-test lifecycle
// ----------------------------------------------------------------------------

interface AcceptanceContext {
  fixtureRoot: string;
  executionRootsDirectory: string;
  hookNeutralizationDirectory: string;
  environment: NodeJS.ProcessEnv;
  fixtureHookNeutralizationDirectory: string;
  repository: FixtureRepository;
  db: DatabaseType;
  workspaces: WorkspaceService;
  worktrees: WorktreeService;
  executionRoots: ExecutionRootService;
  currentInstantMs: number;
}

let ctx: AcceptanceContext;

function clock(): string {
  return new Date(ctx.currentInstantMs).toISOString();
}

function advanceClock(milliseconds: number): void {
  ctx.currentInstantMs += milliseconds;
}

/**
 * `ExecutionRootService`'s git seam, wired to the real binary.
 *
 * Unlike the two git services, this one takes its seam with NO default, so the
 * composition root — here, the suite — has to supply it. The seam reports an
 * exit code because `bound-root` mode's `symbolic-ref --quiet` answers "detached
 * HEAD" by exiting 1 with empty output, which is a legitimate answer rather than
 * a failure.
 */
function buildExecutionRootGitRunner(environment: NodeJS.ProcessEnv): ExecutionRootGitRunner {
  return (argv, options) =>
    new Promise((resolve, reject) => {
      execFile(
        "git",
        [...argv],
        { encoding: "utf8", env: environment, timeout: options.timeoutMs },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          // `ExecFileException.code` admits `null` as well as the string codes a
          // spawn failure carries; only a NUMBER is an exit status.
          const reportedCode: number | string | null | undefined = error.code;
          if (typeof reportedCode !== "number") {
            reject(new Error(`git ${argv.join(" ")} did not run: ${String(error.message)}`));
            return;
          }
          resolve({ exitCode: reportedCode, stdout, stderr });
        },
      ).on("error", reject);
    });
}

beforeEach(async () => {
  // `realpathSync` because macOS hands out `/var/...` symlinks for the temporary
  // directory while git reports the resolved `/private/var/...` form. Comparing
  // a service-minted path against `git worktree list` output needs both sides
  // resolved.
  const fixtureRoot: string = realpathSync(
    mkdtempSync(join(tmpdir(), "ai-sidekicks-worktree-acceptance-")),
  );
  const environment: NodeJS.ProcessEnv = buildFixtureEnvironment(fixtureRoot);
  const fixtureHookNeutralizationDirectory: string = join(
    fixtureRoot,
    "fixture-hook-neutralization",
  );
  mkdirSync(fixtureHookNeutralizationDirectory, { recursive: true });

  const repository: FixtureRepository = await buildFixtureRepository({
    parentDirectory: fixtureRoot,
    name: "mount-repository",
    environment,
    hookNeutralizationDirectory: fixtureHookNeutralizationDirectory,
  });

  const executionRootsDirectory: string = join(fixtureRoot, "execution-roots");
  const db: DatabaseType = openDatabase(join(fixtureRoot, "acceptance.db"));
  const eventLog = new EventLogService({
    db,
    signingKeySource: new FixedDaemonSigningKeySource(),
  });

  const workspaces = new WorkspaceService({
    database: db,
    events: new WorkspaceEventEmitter({ sessionEvents: eventLog }),
    sessions: new SessionService(db),
    now: clock,
  });
  // The `git` seam is deliberately OMITTED on the worktree service: omitting it
  // is what selects the production `execFile` runner, which is the whole point
  // of this tier.
  const worktrees = new WorktreeService({
    database: db,
    events: new WorktreeEventEmitter({ sessionEvents: eventLog }),
    executionRootsDirectory,
    now: clock,
  });
  const workspacePrimitives: WorkspaceLifecyclePrimitives = {
    assertWritable: (workspaceId) => workspaces.assertWritable(workspaceId),
    beginRootPreparation: (workspaceId, targetMode) =>
      workspaces.beginRootPreparation(workspaceId, targetMode),
    completeRootPreparation: (workspaceId, fsRoot) =>
      workspaces.completeRootPreparation(workspaceId, fsRoot),
    failRootPreparation: (workspaceId, detail) =>
      workspaces.failRootPreparation(workspaceId, detail),
  };
  const executionRoots = new ExecutionRootService({
    database: db,
    workspaces: workspacePrimitives,
    worktrees,
    executionRootsDirectory,
    git: buildExecutionRootGitRunner(environment),
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
    hookNeutralizationDirectory: join(executionRootsDirectory, ".hook-neutralization"),
    environment,
    fixtureHookNeutralizationDirectory,
    repository,
    db,
    workspaces,
    worktrees,
    executionRoots,
    currentInstantMs: EPOCH_MS,
  };

  insertMount(REPO_MOUNT_ID, repository.root);
});

afterEach(() => {
  // The per-session append lock is a MODULE SINGLETON — a case that left a queue
  // entry behind would stall the next case on the same session id.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.fixtureRoot, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// Row fixtures and reads
// ----------------------------------------------------------------------------

/** `vcs_type` takes its `'git'` default — the capability matrix reads it. */
function insertMount(repoMountId: string, canonicalRoot: string): void {
  ctx.db
    .prepare(
      `INSERT INTO repo_mounts (
         id, node_id, local_path, canonical_root, state, attached_at, updated_at
       ) VALUES (?, 'node-1', ?, ?, 'attached', ?, ?)`,
    )
    .run(repoMountId, canonicalRoot, canonicalRoot, clock(), clock());
}

/**
 * Seed a workspace directly.
 *
 * Raw INSERT rather than `WorkspaceService.bind`: a bind lands `preparing`
 * with no root, and these cases start from a workspace that already has one.
 * Every case that cares about a TRANSITION still drives the real primitives
 * through the service under test.
 */
function insertWorkspace(options: {
  readonly workspaceId: string;
  readonly executionMode: string;
  readonly fsRoot: string;
  readonly state?: string;
}): void {
  ctx.db
    .prepare(
      `INSERT INTO workspaces (
         id, session_id, repo_mount_id, execution_mode, fs_root, state,
         metadata, created_at, updated_at
       ) VALUES (@id, @session_id, @repo_mount_id, @execution_mode, @fs_root, @state, '{}', @now, @now)`,
    )
    .run({
      id: options.workspaceId,
      session_id: SESSION_ID,
      repo_mount_id: REPO_MOUNT_ID,
      execution_mode: options.executionMode,
      fs_root: options.fsRoot,
      state: options.state ?? "ready",
      now: clock(),
    });
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
  const row = ctx.db
    .prepare<[string], WorktreeTestRow>(
      `SELECT id, repo_mount_id, created_by_session_id, created_by_run_id, branch_name,
              fs_root, state, cleaned_at
         FROM worktrees WHERE id = ?`,
    )
    .get(worktreeId);
  if (row === undefined) {
    throw new Error(`expected a worktrees row for ${worktreeId}`);
  }
  return row;
}

function readWorktreeRows(): readonly WorktreeTestRow[] {
  return ctx.db
    .prepare<[], WorktreeTestRow>(
      `SELECT id, repo_mount_id, created_by_session_id, created_by_run_id, branch_name,
              fs_root, state, cleaned_at
         FROM worktrees ORDER BY created_at ASC, id ASC`,
    )
    .all();
}

interface WorkspaceTestRow {
  readonly id: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly state: string;
  readonly metadata: string;
}

function readWorkspaceRow(workspaceId: string): WorkspaceTestRow {
  const row = ctx.db
    .prepare<
      [string],
      WorkspaceTestRow
    >(`SELECT id, execution_mode, fs_root, state, metadata FROM workspaces WHERE id = ?`)
    .get(workspaceId);
  if (row === undefined) {
    throw new Error(`expected a workspaces row for ${workspaceId}`);
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
}

function readBranchContexts(): readonly BranchContextTestRow[] {
  return ctx.db
    .prepare<[], BranchContextTestRow>(
      `SELECT id, workspace_id, worktree_id, base_branch, head_branch, created_at
         FROM branch_contexts ORDER BY id ASC`,
    )
    .all();
}

function readEventTypes(): readonly string[] {
  return ctx.db
    .prepare<[string], { type: string }>(
      `SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence ASC`,
    )
    .all(SESSION_ID)
    .map((row) => row.type);
}

async function captureRejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (rejection) {
    return rejection;
  }
  throw new Error("expected the call to reject, but it resolved");
}

/** Unwrap an optional the case has already established must be present. */
function requireValue(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new Error(`expected ${label} to be present`);
  }
  return value;
}

/** The happy-path create layer, with `refuse` (the wire posture). */
function createWorktree(branchName: string, onCollision: "refuse" | "suffix" = "refuse") {
  return ctx.worktrees.create({
    repoMountId: REPO_MOUNT_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    branchName,
    onCollision,
  });
}

// ----------------------------------------------------------------------------
// A run on a git mount lands in provisioned-worktree mode
// ----------------------------------------------------------------------------

describe("a run on a git repository defaults to provisioned-worktree mode", () => {
  it("projects provisioned-worktree as the default mode for a git mount", () => {
    const capabilities = computeExecutionModeCapabilities({ vcsType: "git" });

    expect(capabilities.defaultMode).toBe("provisioned-worktree");
    expect(capabilities.availableModes).toEqual(["bound-root", "provisioned-worktree"]);
  });

  it(
    "materializes a real linked worktree and never substitutes the mode",
    async () => {
      insertWorkspace({
        workspaceId: WORKSPACE_ID,
        executionMode: "provisioned-worktree",
        fsRoot: ctx.repository.root,
      });
      const branchName = deriveWorktreeBranchName({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        taskSummary: "Fix login",
      });

      const prepared = await ctx.executionRoots.prepare({
        workspaceId: WORKSPACE_ID,
        branchName,
        runId: RUN_ID,
      });

      // The dispatched mode is the requested one, and the root is path rather
      // than any fallback.
      expect(prepared.executionMode).toBe("provisioned-worktree");
      expect(prepared.branchName).toBe(branchName);
      const worktreeId = requireValue(prepared.worktreeId, "prepared.worktreeId");
      expect(prepared.executionRoot).toBe(
        join(ctx.executionRootsDirectory, REPO_MOUNT_ID, "worktrees", worktreeId),
      );

      // Real git is the authority for the next three claims.
      expect(existsSync(prepared.executionRoot)).toBe(true);
      const worktreeHead = await ctx.repository.git(
        ["symbolic-ref", "--short", "HEAD"],
        prepared.executionRoot,
      );
      expect(worktreeHead.trim()).toBe(branchName);
      const registeredWorktrees = await ctx.repository.git(["worktree", "list", "--porcelain"]);
      expect(registeredWorktrees).toContain(prepared.executionRoot);
      // The checkout is populated, not an empty directory.
      expect(readFileSync(join(prepared.executionRoot, "README.md"), "utf8")).toBe(
        "# fixture repository\n",
      );

      const contexts = readBranchContexts();
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({
        workspace_id: WORKSPACE_ID,
        worktree_id: worktreeId,
        base_branch: DEFAULT_BRANCH,
        head_branch: branchName,
      });

      expect(readWorkspaceRow(WORKSPACE_ID)).toMatchObject({
        execution_mode: "provisioned-worktree",
        fs_root: prepared.executionRoot,
        state: "ready",
      });
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );
});

// ----------------------------------------------------------------------------
// The lifecycle walk
// ----------------------------------------------------------------------------

describe("the worktree lifecycle on real git: create -> dirty -> merged -> retire -> sweep", () => {
  it(
    "creates the derived branch as a real linked worktree cut from the mount HEAD",
    async () => {
      const branchName = deriveWorktreeBranchName({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        taskSummary: "Fix login",
      });
      const mainCommit = (await ctx.repository.git(["rev-parse", DEFAULT_BRANCH])).trim();

      const created = await createWorktree(branchName);

      expect(created).toMatchObject({
        repoMountId: REPO_MOUNT_ID,
        branchName,
        baseRef: DEFAULT_BRANCH,
        state: "ready",
      });
      expect(readWorktreeRow(created.worktreeId)).toMatchObject({
        state: "ready",
        branch_name: branchName,
        created_by_session_id: SESSION_ID,
        created_by_run_id: RUN_ID,
        cleaned_at: null,
      });

      // Real git: the branch exists, points at the mount HEAD, and is checked out
      // in the new root rather than in the main checkout.
      const branchCommit = await ctx.repository.git(["rev-parse", branchName]);
      expect(branchCommit.trim()).toBe(mainCommit);
      const worktreeHead = await ctx.repository.git(
        ["symbolic-ref", "--short", "HEAD"],
        created.fsRoot,
      );
      expect(worktreeHead.trim()).toBe(branchName);
      expect((await ctx.repository.git(["symbolic-ref", "HEAD"])).trim()).toBe(
        `refs/heads/${DEFAULT_BRANCH}`,
      );

      expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "reports a dirty checkout only with acknowledgement, and never writes the dirty state",
    async () => {
      const created = await createWorktree("feature/login");
      // A real uncommitted change in the real checkout — `status --porcelain`
      // reads it, nothing is modeled.
      writeFileSync(join(created.fsRoot, "scratch-notes.txt"), "work in progress\n");

      // The unacknowledged candidate REFUSES.
      const refusal = await captureRejection(() =>
        ctx.worktrees.validateReuse({
          worktreeId: created.worktreeId,
          repoMountId: REPO_MOUNT_ID,
          branchName: "feature/login",
        }),
      );
      expect(refusal).toBeInstanceOf(WorktreeReuseConflictError);
      expect(refusal).toMatchObject({ reason: "dirty_unacknowledged" });

      const acknowledged = await ctx.worktrees.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
        acknowledgeDirtyCandidate: true,
      });
      expect(acknowledged.dirty).toBe(true);
      // Provenance survives the check.
      expect(acknowledged.createdBySessionId).toBe(SESSION_ID);
      expect(acknowledged.createdByRunId).toBe(RUN_ID);

      // The adjudicated boundary: dirtiness is REPORTED, never recorded. The
      // `-> dirty` row transition and its event belong to the Phase 3 binder.
      expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
      expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);

      // Committing the work makes the same call report a clean candidate — the
      // negative control for the dirty arm.
      await ctx.repository.git(["add", "-A"], created.fsRoot);
      await ctx.repository.git(["commit", "-q", "-m", "work in progress"], created.fsRoot);
      const clean = await ctx.worktrees.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
      });
      expect(clean.dirty).toBe(false);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "treats a merged branch as a git fact while the row keeps holding the branch",
    async () => {
      const created = await createWorktree("feature/login");
      writeFileSync(join(created.fsRoot, "src", "login.ts"), "export const login = true;\n");
      await ctx.repository.git(["add", "-A"], created.fsRoot);
      await ctx.repository.git(["commit", "-q", "-m", "add login"], created.fsRoot);

      // The MERGE is performed by the fixture, standing in for the human or the
      // Phase 3 binder. No service merges anything.
      await ctx.repository.git(["merge", "--no-ff", "-m", "merge login", "feature/login"]);

      // "Merged" as git answers it, not as a row claims it.
      const ancestry = await ctx.repository.gitCapturing([
        "merge-base",
        "--is-ancestor",
        "feature/login",
        DEFAULT_BRANCH,
      ]);
      expect(ancestry.exitCode).toBe(0);

      // The row is untouched by the merge: the `-> merged` transition belongs to
      // the binder, and the branch is still HELD by a live worktree...
      expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
      // ...which is why a second create on the same branch still collides.
      const collision = await captureRejection(() => createWorktree("feature/login"));
      expect(collision).toBeInstanceOf(WorktreeBranchCollisionError);
      expect(collision).toMatchObject({ branchName: "feature/login" });
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "retires without touching disk, and only the cleanup pass removes the root",
    async () => {
      const created = await createWorktree("feature/login");

      const retired = await ctx.worktrees.retire(created.worktreeId);
      expect(retired.state).toBe("retired");

      // The retirement is recorded, the root survives, and the row is still
      // queryable with its provenance.
      const afterRetire = readWorktreeRow(created.worktreeId);
      expect(afterRetire.state).toBe("retired");
      expect(afterRetire.cleaned_at).toBeNull();
      expect(existsSync(created.fsRoot)).toBe(true);
      expect(await ctx.repository.git(["worktree", "list", "--porcelain"])).toContain(
        created.fsRoot,
      );

      const pass = await ctx.worktrees.cleanupPass();
      expect(pass.cleanedWorktreeIds).toEqual([created.worktreeId]);

      const afterSweep = readWorktreeRow(created.worktreeId);
      expect(afterSweep.cleaned_at).not.toBeNull();
      expect(afterSweep.created_by_session_id).toBe(SESSION_ID);
      expect(afterSweep.created_by_run_id).toBe(RUN_ID);
      expect(existsSync(created.fsRoot)).toBe(false);
      // `worktree prune` really ran: git no longer advertises the registration.
      expect(await ctx.repository.git(["worktree", "list", "--porcelain"])).not.toContain(
        created.fsRoot,
      );
      expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready", "worktree.retired"]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "refuses to retire a worktree whose workspace is holding it busy",
    async () => {
      insertWorkspace({
        workspaceId: WORKSPACE_ID,
        executionMode: "provisioned-worktree",
        fsRoot: ctx.repository.root,
      });
      const prepared = await ctx.executionRoots.prepare({
        workspaceId: WORKSPACE_ID,
        branchName: "feature/login",
        runId: RUN_ID,
      });
      const worktreeId = requireValue(prepared.worktreeId, "prepared.worktreeId");

      // The real hold, taken against a root that really exists.
      await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);

      const conflict = await captureRejection(() => ctx.worktrees.retire(worktreeId));
      expect(conflict).toBeInstanceOf(WorktreeRetireConflictError);
      expect(conflict).toMatchObject({ holdingWorkspaceId: WORKSPACE_ID });
      expect(readWorktreeRow(worktreeId).state).toBe("ready");
      expect(existsSync(prepared.executionRoot)).toBe(true);

      expect(ctx.workspaces.releaseBusy(WORKSPACE_ID)).toBe(true);
      const retired = await ctx.worktrees.retire(worktreeId);
      expect(retired.state).toBe("retired");
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );
});

// ----------------------------------------------------------------------------
// Repository-controlled code never runs
// ----------------------------------------------------------------------------

describe("no repository-controlled code executes during provisioning", () => {
  it(
    "negative control: an un-neutralized worktree add DOES fire the repository's hooks",
    async () => {
      // Without this case, every "no hooks fired" assertion below is satisfied by
      // sentinels that were never armed. It runs in a THROWAWAY repository so the
      // ref and worktree registration it leaves behind cannot perturb anything.
      const hostileRepository = await buildFixtureRepository({
        parentDirectory: ctx.fixtureRoot,
        name: "hook-control-repository",
        environment: ctx.environment,
        hookNeutralizationDirectory: ctx.fixtureHookNeutralizationDirectory,
      });
      expect(hostileRepository.firedHooks()).toEqual([]);

      const added = await hostileRepository.gitWithHooksLive([
        "worktree",
        "add",
        "-b",
        "control/branch",
        join(ctx.fixtureRoot, "hook-control-worktree"),
        DEFAULT_BRANCH,
      ]);
      expect(added.exitCode).toBe(0);
      expect(hostileRepository.firedHooks()).toContain("post-checkout");
      expect(hostileRepository.firedHooks()).toContain("reference-transaction");
      // The checkout population also consults the config-named fsmonitor hook —
      // the leg `core.hooksPath` cannot reach.
      expect(hostileRepository.firedHooks()).toContain(FSMONITOR_SENTINEL_MARKER);

      // `core.hooksPath` alone suppresses the `hooks/`-resident sentinels and
      // NOTHING else: the fsmonitor sentinel still fires, exactly alone. This is
      // the arm that pins the services' second flag as load-bearing rather than
      // decorative.
      hostileRepository.clearFiredHooks();
      const hooksPathOnly = await hostileRepository.gitWithHooksPathOnly([
        "worktree",
        "add",
        "-b",
        "control/second-branch",
        join(ctx.fixtureRoot, "hook-control-second-worktree"),
        DEFAULT_BRANCH,
      ]);
      expect(hooksPathOnly.exitCode).toBe(0);
      expect(hostileRepository.firedHooks()).toEqual([FSMONITOR_SENTINEL_MARKER]);

      // And the full service prefix — both flags — fires nothing: the A/B/C
      // that attributes each suppression to its mechanism rather than to
      // coincidence.
      hostileRepository.clearFiredHooks();
      const neutralized = await hostileRepository.gitCapturing([
        "worktree",
        "add",
        "-b",
        "control/third-branch",
        join(ctx.fixtureRoot, "hook-control-third-worktree"),
        DEFAULT_BRANCH,
      ]);
      expect(neutralized.exitCode).toBe(0);
      expect(hostileRepository.firedHooks()).toEqual([]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "runs no hook across a whole worktree lifecycle, and points core.hooksPath at an empty directory",
    async () => {
      await proveSentinelsAreArmed(ctx.repository);

      const created = await createWorktree("feature/login");
      writeFileSync(join(created.fsRoot, "scratch-notes.txt"), "work in progress\n");
      await ctx.worktrees.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
        acknowledgeDirtyCandidate: true,
      });
      await ctx.worktrees.retire(created.worktreeId);
      await ctx.worktrees.cleanupPass();

      expect(ctx.repository.firedHooks()).toEqual([]);
      // An EMPTY directory is the mechanism: `core.hooksPath` pointing at a
      // directory with no hooks in it is what makes every lookup miss.
      expect(existsSync(ctx.hookNeutralizationDirectory)).toBe(true);
      expect(readdirSync(ctx.hookNeutralizationDirectory)).toEqual([]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );
});

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

describe("derived-name collisions against real git", () => {
  it(
    "suffixes a colliding derived name into the next free ordinals",
    async () => {
      const derivedName = deriveWorktreeBranchName({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        taskSummary: "Fix login",
      });

      const first = await createWorktree(derivedName, "suffix");
      const second = await createWorktree(derivedName, "suffix");
      const third = await createWorktree(derivedName, "suffix");

      expect([first.branchName, second.branchName, third.branchName]).toEqual([
        derivedName,
        `${derivedName}-2`,
        `${derivedName}-3`,
      ]);

      // Every ordinal is a REAL branch on a real checkout of its own.
      for (const created of [first, second, third]) {
        const head = await ctx.repository.git(["symbolic-ref", "--short", "HEAD"], created.fsRoot);
        expect(head.trim()).toBe(created.branchName);
      }
      const roster = await ctx.repository.git(["for-each-ref", "--format=%(refname:short)"]);
      expect(roster.split("\n")).toEqual(
        expect.arrayContaining([derivedName, `${derivedName}-2`, `${derivedName}-3`]),
      );
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "refuses instead of suffixing when the wire posture is refuse",
    async () => {
      const derivedName = deriveWorktreeBranchName({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        taskSummary: "Fix login",
      });
      await createWorktree(derivedName);

      const collision = await captureRejection(() => createWorktree(derivedName));

      expect(collision).toBeInstanceOf(WorktreeBranchCollisionError);
      expect(collision).toMatchObject({ repoMountId: REPO_MOUNT_ID, branchName: derivedName });
      // Refused BEFORE git: exactly one worktree, one branch, one pair of events.
      expect(readWorktreeRows()).toHaveLength(1);
      expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );
});

// ----------------------------------------------------------------------------
// Branch-name divergence: free in the index, taken in git
// ----------------------------------------------------------------------------

describe("a branch free in the index but taken in git", () => {
  it(
    "surfaces a creation failure rather than a branch collision under refuse",
    async () => {
      // The divergence: a branch that real git holds and the index has never
      // heard of. This is the recorded outcome of the residual on
      // `../worktree-service.ts` — the honest answer would be a 409 branch
      // collision, and what the caller actually sees is a 500 creation failure.
      await ctx.repository.git(["branch", "feature/taken"]);

      const failure = await captureRejection(() => createWorktree("feature/taken"));

      expect(failure).toBeInstanceOf(WorktreeCreateFailedError);
      expect(failure).not.toBeInstanceOf(WorktreeBranchCollisionError);
      expect(failure).toMatchObject({ reason: "git_invocation_failed" });

      // Fail-closed: the row records the failure, no root survives, and the
      // creation event is the only one — `-> failed` emits nothing.
      const rows = readWorktreeRows();
      expect(rows).toHaveLength(1);
      const failedRow = rows[0];
      expect(failedRow).toMatchObject({ state: "failed", branch_name: "feature/taken" });
      expect(existsSync(requireValue(failedRow?.fs_root, "the failed row's fs_root"))).toBe(false);
      expect(readEventTypes()).toEqual(["worktree.created"]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "cannot advance the ordinal under suffix either",
    async () => {
      await ctx.repository.git(["branch", "feature/taken"]);

      const failure = await captureRejection(() => createWorktree("feature/taken", "suffix"));

      // The second half of the same residual: the ordinal loop retries only on a
      // SQLite UNIQUE violation, and this failure never reaches the database — so
      // `suffix` refuses exactly where `refuse` does, on the bare name.
      expect(failure).toBeInstanceOf(WorktreeCreateFailedError);
      expect(failure).toMatchObject({ reason: "git_invocation_failed" });
      const rows = readWorktreeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "failed", branch_name: "feature/taken" });
      // No `-2` was ever attempted.
      const roster = await ctx.repository.git(["for-each-ref", "--format=%(refname:short)"]);
      expect(roster.split("\n")).not.toContain("feature/taken-2");
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );
});

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

describe("the main checkout across every failure path", () => {
  it(
    "leaves the working tree, HEAD and the branch roster byte-identical",
    async () => {
      // Setup for the four failure paths (a)-(d), all of it BEFORE the snapshot.
      await ctx.repository.git(["branch", "feature/taken"]);
      const live = await createWorktree("feature/live");
      writeFileSync(join(live.fsRoot, "scratch-notes.txt"), "work in progress\n");

      const before = await snapshotMainCheckout(ctx.repository);

      // (a) creation refused because the branch is taken in git.
      expect(await captureRejection(() => createWorktree("feature/taken"))).toBeInstanceOf(
        WorktreeCreateFailedError,
      );
      // (b) the same divergence under the suffix posture.
      expect(
        await captureRejection(() => createWorktree("feature/taken", "suffix")),
      ).toBeInstanceOf(WorktreeCreateFailedError);
      // (c) an unacknowledged dirty reuse.
      expect(
        await captureRejection(() =>
          ctx.worktrees.validateReuse({
            worktreeId: live.worktreeId,
            repoMountId: REPO_MOUNT_ID,
            branchName: "feature/live",
          }),
        ),
      ).toBeInstanceOf(WorktreeReuseConflictError);
      // (d) a reuse whose branch disagrees, acknowledgement notwithstanding.
      expect(
        await captureRejection(() =>
          ctx.worktrees.validateReuse({
            worktreeId: live.worktreeId,
            repoMountId: REPO_MOUNT_ID,
            branchName: "feature/some-other-branch",
            acknowledgeDirtyCandidate: true,
          }),
        ),
      ).toMatchObject({ reason: "branch_mismatch" });

      const after = await snapshotMainCheckout(ctx.repository);
      expect(after).toEqual(before);
      // Spelled out as well as compared, so a snapshot that silently stopped
      // capturing a field cannot pass this case by matching itself.
      expect(after.headSymbolicRef).toBe(`refs/heads/${DEFAULT_BRANCH}`);
      expect(after.porcelainStatus).toBe("");
      expect(ctx.repository.firedHooks()).toEqual([]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "records the failure on the workspace and substitutes no mode when preparation fails",
    async () => {
      await ctx.repository.git(["branch", "feature/taken"]);
      insertWorkspace({
        workspaceId: WORKSPACE_ID,
        executionMode: "provisioned-worktree",
        fsRoot: ctx.repository.root,
      });
      const before = await snapshotMainCheckout(ctx.repository);

      const failure = await captureRejection(() =>
        ctx.executionRoots.prepare({
          workspaceId: WORKSPACE_ID,
          branchName: "feature/taken",
          runId: RUN_ID,
        }),
      );

      // The run is BLOCKED with the original typed cause — no lesser mode, no
      // fallback root — and the workspace records why.
      expect(failure).toBeInstanceOf(WorktreeCreateFailedError);
      const workspace = readWorkspaceRow(WORKSPACE_ID);
      expect(workspace.state).toBe("stale");
      expect(workspace.metadata).toContain("worktree.create_failed");
      expect(readBranchContexts()).toEqual([]);
      expect(await snapshotMainCheckout(ctx.repository)).toEqual(before);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );
});

// ----------------------------------------------------------------------------
// Reuse stays explicit and stays linked
// ----------------------------------------------------------------------------

describe("a reused worktree stays linked to its branch and prior context", () => {
  it(
    "rebinds the same worktree, root and branch-context row",
    async () => {
      insertWorkspace({
        workspaceId: WORKSPACE_ID,
        executionMode: "provisioned-worktree",
        fsRoot: ctx.repository.root,
      });
      const first = await ctx.executionRoots.prepare({
        workspaceId: WORKSPACE_ID,
        branchName: "feature/login",
        runId: RUN_ID,
      });
      const worktreeId = requireValue(first.worktreeId, "the first prepare's worktreeId");
      const priorContexts = readBranchContexts();
      expect(priorContexts).toHaveLength(1);

      // A later run names the candidate EXPLICITLY.
      advanceClock(60_000);
      const second = await ctx.executionRoots.prepare({
        workspaceId: WORKSPACE_ID,
        branchName: "feature/login",
        reuseWorktreeId: worktreeId,
        runId: RUN_ID,
      });

      expect(second.worktreeId).toBe(worktreeId);
      expect(second.executionRoot).toBe(first.executionRoot);
      expect(second.branchName).toBe("feature/login");
      expect(second.branchContextId).toBe(first.branchContextId);

      // The PRIOR context survived: one row, the same id, the same creation
      // stamp, and the base branch carried forward rather than re-derived.
      const contexts = readBranchContexts();
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({
        id: priorContexts[0]?.id,
        created_at: priorContexts[0]?.created_at,
        worktree_id: worktreeId,
        base_branch: DEFAULT_BRANCH,
        head_branch: "feature/login",
      });

      // The worktree itself is untouched — same row, same provenance, and real
      // git still has it checked out on the branch.
      expect(readWorktreeRow(worktreeId)).toMatchObject({
        state: "ready",
        branch_name: "feature/login",
        created_by_run_id: RUN_ID,
      });
      const head = await ctx.repository.git(
        ["symbolic-ref", "--short", "HEAD"],
        second.executionRoot,
      );
      expect(head.trim()).toBe("feature/login");
      // No second worktree was minted behind the reuse.
      expect(readWorktreeRows()).toHaveLength(1);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "never reuses implicitly: an unnamed candidate is refused, not rebound",
    async () => {
      insertWorkspace({
        workspaceId: WORKSPACE_ID,
        executionMode: "provisioned-worktree",
        fsRoot: ctx.repository.root,
      });
      const first = await ctx.executionRoots.prepare({
        workspaceId: WORKSPACE_ID,
        branchName: "feature/login",
        runId: RUN_ID,
      });
      const worktreeId = requireValue(first.worktreeId, "the first prepare's worktreeId");

      // The same branch, no `reuseWorktreeId`. An implicit-reuse implementation
      // would hand back the existing worktree says it refuses.
      const refusal = await captureRejection(() =>
        ctx.executionRoots.prepare({
          workspaceId: WORKSPACE_ID,
          branchName: "feature/login",
          runId: RUN_ID,
        }),
      );

      expect(refusal).toBeInstanceOf(WorktreeBranchCollisionError);
      expect(readWorktreeRow(worktreeId).state).toBe("ready");
      expect(readBranchContexts()).toHaveLength(1);
      expect(readWorkspaceRow(WORKSPACE_ID).state).toBe("stale");
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );
});

// ----------------------------------------------------------------------------
// Ambient GIT_OBJECT_DIRECTORY — the strip the worktree service inherits
// ----------------------------------------------------------------------------
//
// THIS TIER OR NOWHERE. The service builds its child environment inside its
// default `execFile` runner, and its git seam is `(argv, {timeoutMs})` — it
// carries no environment at all. The sibling unit suite injects a fake runner
// for every case, which bypasses that builder entirely, so a strip assertion
// written there could only ever observe the fake. This suite is the one place
// the seam is left at its production default, which makes it the only place
// the environment the child actually receives is on the table.
//
// The variable is `GIT_OBJECT_DIRECTORY`, and it is NOT a discovery redirector
// in the `GIT_DIR` sense: git substitutes it into its own is-this-a-repository
// predicate, so a value naming nothing accessible makes every candidate fail
// that predicate and every invocation refuse with `not a git repository` at exit
// 128 (git 2.50.1). The service strips it because it shares
// `DISCOVERY_REDIRECTING_GIT_ENV_KEYS` with `../../workspace/repo-root-resolver.ts`,
// which is where the full observation and its mechanism note live.
//
// ORDER IS LOAD-BEARING in each case below. The fixture environment is captured
// by `buildFixtureEnvironment` in `beforeEach`, BEFORE any stub, so fixture-side
// git keeps a clean environment throughout and the read-back assertions are
// never themselves running under the hijack. The services read `process.env` at
// CALL time, so the stub reaches them and nothing else.
describe("ambient GIT_OBJECT_DIRECTORY cannot reach the worktree service's git", () => {
  /** A path that names nothing — the shape that blinds git's predicate. */
  function poisonedObjectDirectory(): string {
    return join(ctx.fixtureRoot, "absent-object-directory");
  }

  /** Run `work` with the poisoned variable exported, restoring it either way. */
  async function withPoisonedObjectDirectory<T>(work: () => Promise<T>): Promise<T> {
    try {
      vi.stubEnv("GIT_OBJECT_DIRECTORY", poisonedObjectDirectory());
      return await work();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it("negative control — raw git IS blinded by GIT_OBJECT_DIRECTORY", async () => {
    // Without this, the case below is satisfied by a variable that never
    // mattered. `spawnGit` takes the environment explicitly, so this control
    // poisons the fixture environment rather than `process.env`.
    const blinded = await spawnGit(
      ["-C", ctx.repository.root, "rev-parse", "--show-toplevel"],
      { ...ctx.environment, GIT_OBJECT_DIRECTORY: poisonedObjectDirectory() },
      ctx.fixtureRoot,
    );

    // git's fatal exit, and the wording every blinded invocation below would
    // otherwise have drawn.
    expect(blinded.exitCode).toBe(128);
    expect(blinded.stderr).toContain("not a git repository");
  });

  it(
    "creates a real linked worktree with GIT_OBJECT_DIRECTORY exported",
    async () => {
      const branchName = "feature/ambient-object-directory";
      const mainCommit = (await ctx.repository.git(["rev-parse", DEFAULT_BRANCH])).trim();

      const created = await withPoisonedObjectDirectory(() => createWorktree(branchName));

      expect(created.state).toBe("ready");
      expect(readWorktreeRow(created.worktreeId)).toMatchObject({
        state: "ready",
        branch_name: branchName,
      });
      // Real git facts, read back under the clean fixture environment: the branch
      // exists at the mount HEAD and is checked out in the new root.
      expect((await ctx.repository.git(["rev-parse", branchName])).trim()).toBe(mainCommit);
      expect(
        (await ctx.repository.git(["symbolic-ref", "--short", "HEAD"], created.fsRoot)).trim(),
      ).toBe(branchName);
      // Nothing was written to the hijacked location, and no hook fired.
      expect(existsSync(poisonedObjectDirectory())).toBe(false);
      expect(ctx.repository.firedHooks()).toEqual([]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );
});

// ----------------------------------------------------------------------------
// Bound-root mode against real git
// ----------------------------------------------------------------------------

describe("bound-root mode — the main checkout as the execution root", () => {
  it(
    "binds the mount's own checkout and mutates nothing",
    async () => {
      // The one mode whose execution root IS the user's checkout —
      // the exact blast radius this tier polices — driven through the real
      // bracket: `assertWritable` → bind-verify (real `symbolic-ref`) →
      // `beginRootPreparation` → `completeRootPreparation`.
      const before = await snapshotMainCheckout(ctx.repository);
      insertWorkspace({
        workspaceId: BOUND_ROOT_WORKSPACE_ID,
        executionMode: "bound-root",
        fsRoot: ctx.repository.root,
      });

      const prepared = await ctx.executionRoots.prepare({
        workspaceId: BOUND_ROOT_WORKSPACE_ID,
        branchName: DEFAULT_BRANCH,
        runId: RUN_ID,
      });

      expect(prepared.executionMode).toBe("bound-root");
      expect(prepared.executionRoot).toBe(ctx.repository.root);
      expect(readWorkspaceRow(BOUND_ROOT_WORKSPACE_ID).state).toBe("ready");
      // The context row fills no worktree column (the bound-root arm) and
      // self-anchors — bound-root mode cuts nothing, so there is no cut point to
      // record.
      const contextRow = ctx.db
        .prepare<
          [string],
          {
            worktree_id: string | null;
            base_branch: string;
            head_branch: string;
          }
        >(
          `SELECT worktree_id, base_branch, head_branch
             FROM branch_contexts WHERE workspace_id = ?`,
        )
        .get(BOUND_ROOT_WORKSPACE_ID);
      expect(contextRow).toMatchObject({
        worktree_id: null,
        base_branch: DEFAULT_BRANCH,
        head_branch: DEFAULT_BRANCH,
      });
      // Not one byte moved: working tree, HEAD and branch roster all identical.
      expect(await snapshotMainCheckout(ctx.repository)).toEqual(before);
      expect(ctx.repository.firedHooks()).toEqual([]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a detached main checkout as a mismatch through real git's exit status",
    async () => {
      // The seam contract `#verifyBoundRootBranch` discriminates on — detached
      // HEAD means `symbolic-ref --quiet --short HEAD` exits 1 with empty
      // stdout — pinned here against real git. Any other
      // exit status would surface as the anonymous invariant carrier instead
      // of the ratified `workspace.branch_mismatch` refusal.
      insertWorkspace({
        workspaceId: BOUND_ROOT_WORKSPACE_ID,
        executionMode: "bound-root",
        fsRoot: ctx.repository.root,
      });
      await ctx.repository.git(["checkout", "--quiet", "--detach", "HEAD"]);
      // Premise check: the shared helper's `headSymbolicRef` is null exactly
      // when `symbolic-ref --quiet` exits non-zero — the same exit-status
      // contract `#verifyBoundRootBranch` reads.
      const before = await snapshotMainCheckout(ctx.repository);
      expect(before.headSymbolicRef).toBeNull();

      const rejection = await captureRejection(() =>
        ctx.executionRoots.prepare({
          workspaceId: BOUND_ROOT_WORKSPACE_ID,
          branchName: DEFAULT_BRANCH,
          runId: RUN_ID,
        }),
      );

      expect(rejection).toBeInstanceOf(WorkspaceBranchMismatchError);
      expect(rejection).toMatchObject({
        requestedBranchName: DEFAULT_BRANCH,
        currentBranchName: "(detached HEAD)",
      });
      // Bind-only verification: the refusal switched no branch, wrote no row,
      // and left the detached checkout exactly as it found it.
      expect(readWorkspaceRow(BOUND_ROOT_WORKSPACE_ID).state).toBe("ready");
      expect(await snapshotMainCheckout(ctx.repository)).toEqual(before);
      expect(ctx.repository.firedHooks()).toEqual([]);
    },
    ACCEPTANCE_TEST_TIMEOUT_MS,
  );
});
