// RepoMountService behavior.
//
// Drives the real service against a real temp-file SQLite database (canonical
// `openDatabase` factory → per-test tmp dir → `afterEach` close + unlink), a
// real `EventLogService` append path, a real `WorkspaceService` for the binds a
// detach cascades over, a real `SessionService`, and REAL git repositories on
// disk built with `execFile` — the same fixture approach
// `repo-root-resolver.test.ts` uses, because "attach through a subdirectory
// resolves to the repository root" is only a real claim if git actually
// answered it.
//
// Five deliberate test-only mechanisms:
//   * REAL git fixtures, built once in `beforeAll` under a hermetic environment.
//     A mocked resolver would let every canonical-root assertion in this file
//     pass against a value the test itself invented.
//   * An INTERFERING CLOCK that mutates the database once, on its first read.
//     `detach` reads the clock between its pre-transaction row read and the
//     transaction, so whatever the clock writes lands in exactly the window the
//     compare-and-swap and the in-transaction dependent read exist for. A race
//     left to real concurrency is either flaky or never reached.
//   * An injected `newRepoMountId` that mints a COLLIDING id, to reach a
//     constraint failure the production id source cannot produce.
//   * A FAILING EMITTER subclass whose first `workspace.archived` append
//     rejects, for the post-commit announcement path. That failure is
//     environmental (a size refusal, a full disk) and has no other trigger.
//   * An INJECTED `platform`, so the win32 git-pinning guard is exercised on
//     every CI leg rather than only on a Windows runner — the argument
//     `repo-root-resolver.ts` already makes for its injected `path` module.
//
// Negative controls accompany the guards that could otherwise pass vacuously:
// the uniqueness arm proves a non-uniqueness constraint failure is NOT
// translated, the in-transaction-read arm would archive nothing if the read had
// happened outside the transaction, the git-seam arm would succeed if the
// injected executable path were dropped, the win32 guard has a companion arm
// proving it refuses an OMISSION rather than refusing win32, and the busy
// refusal carries TWO busy dependents so it cannot pass on a throw-on-first
// implementation.

import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { NodeId, RepoMountId, SessionId } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService, TestSeedingAppendToken } from "../../session/session-service.js";
import {
  RepoAlreadyAttachedError,
  RepoDetachConflictError,
  RepoMountNotFoundError,
  RepoRootResolutionError,
} from "../repo-errors.js";
import {
  RepoMountService,
  RepoMountServiceInvariantError,
  type RepoMountServiceDeps,
} from "../repo-mount-service.js";
import { RepoRootResolver } from "../repo-root-resolver.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import type { FilesystemPathProbe } from "../workspace-projector.js";
import { WorkspaceService, type FilesystemPathProbeFn } from "../workspace-service.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000001" as SessionId;
const OTHER_SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000002" as SessionId;
const NODE_ID: NodeId = "node-local" as NodeId;
const OTHER_NODE_ID: NodeId = "node-remote" as NodeId;
const UNKNOWN_MOUNT_ID: RepoMountId = "0190f9a1-0000-7000-8000-00000000ffff" as RepoMountId;

const USER_ACTOR: string = "0190f9a4-0000-7000-8000-000000000001";
const DETACH_CORRELATION_ID: string = "0190f9a5-0000-7000-8000-000000000002";
const RUN_ID: string = "0190f9a6-0000-7000-8000-000000000001";
const OTHER_RUN_ID: string = "0190f9a6-0000-7000-8000-000000000002";
// Stands in for a size refusal or a disk error at append time — the class
// of post-commit failure the detach announcement loop has to survive.
const SIMULATED_APPEND_FAILURE_MESSAGE: string = "simulated append failure";

// Real UUIDs for the injected id sources: a counter would fail the branded
// schemas, which is exactly why those parses exist.
const MOUNT_ID_POOL: readonly string[] = [
  "0190f9a1-0000-7000-8000-000000000001",
  "0190f9a1-0000-7000-8000-000000000002",
  "0190f9a1-0000-7000-8000-000000000003",
  "0190f9a1-0000-7000-8000-000000000004",
];
const WORKSPACE_ID_POOL: readonly string[] = [
  "0190f9a2-0000-7000-8000-000000000001",
  "0190f9a2-0000-7000-8000-000000000002",
  "0190f9a2-0000-7000-8000-000000000003",
  "0190f9a2-0000-7000-8000-000000000004",
  "0190f9a2-0000-7000-8000-000000000005",
  "0190f9a2-0000-7000-8000-000000000006",
];
const INJECTED_WORKSPACE_ID: string = "0190f9a2-0000-7000-8000-00000000aaaa";
// The single id a colliding mount-id source hands out. Named rather than reached
// for as `MOUNT_ID_POOL[0]`, which needs a cast to shed `| undefined` and quietly
// couples the arm to the pool's first element.
const INJECTED_MOUNT_ID: string = "0190f9a1-0000-7000-8000-00000000aaaa";

/**
 * An emitter whose FIRST `workspace.archived` append rejects; later ones append
 * for real.
 *
 * Drives the post-commit failure path. It has to fail the FIRST of two so the
 * arm can tell "the loop continued past a failure" from "the loop stopped" —
 * failing the last one would leave both behaviors indistinguishable.
 */
class FirstArchiveAppendFailingEmitter extends WorkspaceEventEmitter {
  #failuresRemaining: number = 1;
  /** Every workspace id the service ATTEMPTED to announce, in call order. */
  readonly attemptedWorkspaceIds: string[] = [];

  override async emitWorkspaceArchived(
    input: Parameters<WorkspaceEventEmitter["emitWorkspaceArchived"]>[0],
  ): ReturnType<WorkspaceEventEmitter["emitWorkspaceArchived"]> {
    this.attemptedWorkspaceIds.push(input.workspaceId);
    if (this.#failuresRemaining > 0) {
      this.#failuresRemaining -= 1;
      throw new Error(SIMULATED_APPEND_FAILURE_MESSAGE);
    }
    return super.emitWorkspaceArchived(input);
  }
}

interface StoredMountRow {
  readonly id: string;
  readonly node_id: string;
  readonly local_path: string;
  readonly canonical_root: string;
  readonly vcs_type: string;
  readonly state: string;
  readonly attached_at: string;
  readonly updated_at: string;
}

interface StoredWorkspaceRow {
  readonly id: string;
  readonly state: string;
}

// ----------------------------------------------------------------------------
// Real-git fixtures
// ----------------------------------------------------------------------------

/**
 * The hermetic environment FIXTURE git runs under — no system config, no global
 * config, a `HOME` inside the temp root, an explicit identity. Mirrors
 * `repo-root-resolver.test.ts`'s helper of the same name; the discovery
 * redirectors are stripped so a developer's ambient `GIT_DIR` cannot make a
 * fixture resolve somewhere else.
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
 * Run a fixture git command, rejecting on any non-zero exit.
 *
 * `cwd` is pinned INSIDE the fixture root — stronger than the sibling suite
 * needs, and deliberate here: this file's fixtures are built while the process
 * working directory is the repository under development, and a git invocation
 * that discovered THAT repository would be a fixture bleeding into the host.
 */
function runFixtureGit(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { encoding: "utf8", env: environment, cwd, timeout: 30_000 },
      (error, _stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`fixture git ${args.join(" ")} failed: ${stderr}`));
          return;
        }
        resolve();
      },
    ).on("error", reject);
  });
}

interface GitFixtures {
  readonly fixtureRoot: string;
  /** The hermetic environment fixture git runs under. */
  readonly environment: NodeJS.ProcessEnv;
  /** A real git repository root — what `rev-parse --show-toplevel` reports. */
  readonly repositoryRoot: string;
  /** A directory BELOW `repositoryRoot`; attaching it must persist the root. */
  readonly nestedDirectory: string;
  /** A second, unrelated repository — the envelope-admission control's target. */
  readonly unrelatedRepositoryRoot: string;
  /** A directory that is not a repository at all, refused as `not_a_git_repository`. */
  readonly plainDirectory: string;
  /** An absolute path that does not exist. */
  readonly absentPath: string;
  /** An absolute path to a `git` that is not there (the win32 seam's control). */
  readonly missingGitExecutable: string;
}

let gitFixtures: GitFixtures;

beforeAll(async () => {
  // Realpath the temp root ONCE: on macOS `os.tmpdir()` is `/var/folders/…`,
  // itself a symlink. The resolver canonicalizes, so an expectation built from
  // the un-resolved `mkdtemp` output would mismatch on every assertion.
  const fixtureRoot: string = await realpath(
    await mkdtemp(join(tmpdir(), "ai-sidekicks-repo-mount-service-")),
  );
  const environment = buildFixtureEnvironment(fixtureRoot);

  const repositoryRoot = join(fixtureRoot, "repo");
  const nestedDirectory = join(repositoryRoot, "packages", "daemon");
  const unrelatedRepositoryRoot = join(fixtureRoot, "unrelated-repo");
  const plainDirectory = join(fixtureRoot, "plain");
  for (const directory of [nestedDirectory, plainDirectory]) {
    mkdirSync(directory, { recursive: true });
  }

  await runFixtureGit(["init", "-q", repositoryRoot], environment, fixtureRoot);
  await runFixtureGit(["init", "-q", unrelatedRepositoryRoot], environment, fixtureRoot);

  gitFixtures = {
    fixtureRoot,
    environment,
    repositoryRoot,
    nestedDirectory,
    unrelatedRepositoryRoot,
    plainDirectory,
    absentPath: join(fixtureRoot, "definitely-not-here"),
    missingGitExecutable: join(fixtureRoot, "definitely-not-a-git-binary"),
  };
}, 120_000);

afterAll(() => {
  if (gitFixtures !== undefined) {
    rmSync(gitFixtures.fixtureRoot, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Per-test harness
// ----------------------------------------------------------------------------

interface TestHarness {
  /** MUTABLE: the durability arm closes this handle and reopens the same file. */
  db: DatabaseType;
  readonly dbPath: string;
  readonly emitter: WorkspaceEventEmitter;
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService;
  readonly service: RepoMountService;
  readonly tmpDir: string;
  /** A per-test directory that arms may delete to make a root vanish. */
  readonly disposableRoot: string;
}

let harness: TestHarness;

function makeIdSource(pool: readonly string[], label: string): () => string {
  let index: number = 0;
  return () => {
    const value = pool[index];
    if (value === undefined) {
      throw new Error(`${label} id pool exhausted; add more UUIDs`);
    }
    index += 1;
    return value;
  };
}

/** Seed a session's log so `SessionService.replay` returns a snapshot for it. */
function seedSession(sessionId: SessionId): void {
  harness.sessions.append({
    id: `evt-${sessionId}`,
    sessionId,
    sequence: 0,
    occurredAt: "2026-08-05T00:00:00.000Z",
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: null,
    payload: { sessionId },
    correlationId: null,
    causationId: null,
    version: "1.0",
  });
}

/**
 * Build a service over the harness database, optionally overriding one seam.
 *
 * The default construction injects no resolver and no probe, so the default arms
 * drive real git and real directories through the production primitives.
 */
function createService(overrides: Partial<RepoMountServiceDeps> = {}): RepoMountService {
  return new RepoMountService({
    database: harness.db,
    events: harness.emitter,
    nodeId: NODE_ID,
    newRepoMountId: makeIdSource(MOUNT_ID_POOL, "repo mount"),
    ...overrides,
  });
}

/** Bind a `preparing` workspace on a mount for `sessionId`, returning its id. */
async function bindWorkspace(
  repoMountId: RepoMountId,
  sessionId: SessionId = SESSION_ID,
): Promise<string> {
  const bound = await harness.workspaces.bind({
    sessionId,
    repoMountId,
    executionMode: "bound-root",
  });
  return bound.workspaceId;
}

/** Bind a workspace and complete its provisioning at the repository root, so it is `ready`. */
async function bindReadyWorkspace(repoMountId: RepoMountId): Promise<string> {
  const workspaceId = await bindWorkspace(repoMountId);
  await harness.workspaces.completeRootPreparation(workspaceId, gitFixtures.repositoryRoot);
  return workspaceId;
}

function readMountRow(repoMountId: string): StoredMountRow | undefined {
  return harness.db
    .prepare(
      `SELECT id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at
         FROM repo_mounts WHERE id = ?`,
    )
    .get(repoMountId) as StoredMountRow | undefined;
}

function requireMountRow(repoMountId: string): StoredMountRow {
  const row = readMountRow(repoMountId);
  if (row === undefined) {
    throw new Error(`repo mount ${repoMountId} is absent; the caller expected a row`);
  }
  return row;
}

function readWorkspaceRow(workspaceId: string): StoredWorkspaceRow | undefined {
  return harness.db.prepare("SELECT id, state FROM workspaces WHERE id = ?").get(workspaceId) as
    | StoredWorkspaceRow
    | undefined;
}

function requireWorkspaceRow(workspaceId: string): StoredWorkspaceRow {
  const row = readWorkspaceRow(workspaceId);
  if (row === undefined) {
    throw new Error(`workspace ${workspaceId} is absent; the caller expected a row`);
  }
  return row;
}

function countMountRows(): number {
  return (
    harness.db.prepare("SELECT COUNT(*) AS total FROM repo_mounts").get() as {
      readonly total: number;
    }
  ).total;
}

/**
 * The session's event types WITHOUT the seeded `session.created` anchor.
 *
 * Dropped rather than asserted in every arm: the anchor exists only because
 * `replay` refuses a chain that does not start with it, and repeating it in
 * every expectation would bury the sequence each arm is actually about.
 */
function readLifecycleEventTypes(sessionId: string = SESSION_ID): readonly string[] {
  return (
    harness.db
      .prepare("SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence ASC")
      .all(sessionId) as ReadonlyArray<{ readonly type: string }>
  )
    .map((row) => row.type)
    .filter((type) => type !== "session.created");
}

interface StoredEventEnvelopeRow {
  readonly type: string;
  readonly actor: string | null;
  readonly correlation_id: string | null;
  readonly payload: string;
}

function readLifecycleEnvelopes(sessionId: string = SESSION_ID): readonly StoredEventEnvelopeRow[] {
  return (
    harness.db
      .prepare(
        `SELECT type, actor, correlation_id, payload FROM session_events
          WHERE session_id = ? ORDER BY sequence ASC`,
      )
      .all(sessionId) as readonly StoredEventEnvelopeRow[]
  ).filter((row) => row.type !== "session.created");
}

/** Run `body` and return whatever it rejected with, so an arm can assert on the carrier. */
async function captureRejection(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to reject, but it resolved");
}

function captureThrow(body: () => unknown): unknown {
  try {
    body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to throw, but it returned");
}

/**
 * A clock that advances one second per read, from a fixed epoch.
 *
 * For arms that compare two stamps this service wrote. `toISOString` is
 * millisecond-resolution and two calls a few hundred microseconds apart produce
 * the SAME string, so a wall-clock version of those arms passes or fails on
 * machine speed.
 */
function steppingClock(): () => string {
  let currentMs: number = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const stamp = new Date(currentMs).toISOString();
    currentMs += 1_000;
    return stamp;
  };
}

/**
 * A clock that runs `interfere()` ONCE, on its first read, then answers a fixed
 * stamp.
 *
 * The interleaving driver for the race arms: `detach` reads the clock after its
 * pre-transaction row read and before the transaction opens. Build a service
 * with it only for the detach call — attach reads the clock too.
 */
function interferingClock(interfere: () => void): () => string {
  let fired: boolean = false;
  return () => {
    if (!fired) {
      fired = true;
      interfere();
    }
    return "2026-08-05T00:00:02.000Z";
  };
}

/** A probe seam that records the path it was handed, then answers truthfully. */
function recordingProbe(record: (path: string) => void): FilesystemPathProbeFn {
  return (path: string) => {
    record(path);
    return Promise.resolve({
      probedPath: path,
      reachable: true,
      checkedAt: "2026-08-05T00:00:00.000Z",
    } satisfies FilesystemPathProbe);
  };
}

/** A probe seam that reports having measured a path other than the one asked for. */
function mispairedProbe(probedPathOverride: string): FilesystemPathProbeFn {
  return (_path: string) =>
    Promise.resolve({
      probedPath: probedPathOverride,
      reachable: true,
      checkedAt: "2026-08-05T00:00:00.000Z",
    } satisfies FilesystemPathProbe);
}

beforeEach(async () => {
  const tmpDir: string = await realpath(
    await mkdtemp(join(tmpdir(), "ai-sidekicks-repo-mount-service-db-")),
  );
  const dbPath = join(tmpDir, "test.db");
  const db: DatabaseType = openDatabase(dbPath);
  const emitter = new WorkspaceEventEmitter({
    sessionEvents: new EventLogService({
      db,
    }),
  });
  const sessions = new SessionService(db, {
    allowTestSeedingAppend: TestSeedingAppendToken.forTestsOnly(),
  });
  const workspaces = new WorkspaceService({
    database: db,
    events: emitter,
    sessions,
    newWorkspaceId: makeIdSource(WORKSPACE_ID_POOL, "workspace"),
  });
  const disposableRoot = join(tmpDir, "disposable-root");
  mkdirSync(disposableRoot, { recursive: true });

  harness = {
    db,
    dbPath,
    emitter,
    workspaces,
    sessions,
    service: new RepoMountService({
      database: db,
      events: emitter,
      nodeId: NODE_ID,
      newRepoMountId: makeIdSource(MOUNT_ID_POOL, "repo mount"),
    }),
    tmpDir,
    disposableRoot,
  };

  seedSession(SESSION_ID);
  seedSession(OTHER_SESSION_ID);
});

afterEach(() => {
  // The per-session append lock is a module singleton; a leftover queue entry
  // would stall the next case against the same session id and present as an
  // unrelated timeout.
  __resetSessionAppendLocksForTest();
  harness.db.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// attach
// ----------------------------------------------------------------------------

describe("RepoMountService.attach", () => {
  it("persists the resolved root of a SUBDIRECTORY attach, and it survives a reopen", async () => {
    const response = await harness.service.attach({
      // The entered path is BELOW the repository root — the only shape in which
      // the entered path and the canonical root differ.
      localPath: gitFixtures.nestedDirectory,
    });

    expect(response.state).toBe("attached");
    expect(response.vcsType).toBe("git");
    expect(response.canonicalRoot).toBe(gitFixtures.repositoryRoot);
    expect(response.canonicalRoot).not.toBe(gitFixtures.nestedDirectory);

    // The durability leg: close the handle, reopen the same FILE, and read. An
    // in-memory or uncommitted row would not survive this.
    harness.db.close();
    harness.db = openDatabase(harness.dbPath);

    const mount = requireMountRow(response.repoMountId);
    expect(mount.canonical_root).toBe(gitFixtures.repositoryRoot);
    // PROVENANCE survives alongside resolved identity, and the two differ —
    // which is what makes keeping both meaningful.
    expect(mount.local_path).toBe(gitFixtures.nestedDirectory);
    expect(mount.local_path).not.toBe(mount.canonical_root);
    // The request names no node; the service stamps its own.
    expect(mount.node_id).toBe(NODE_ID);
    expect(mount.vcs_type).toBe("git");
    expect(mount.state).toBe("attached");
  });

  it("refuses a path that is not a git repository, and persists nothing", async () => {
    const error = await captureRejection(() =>
      harness.service.attach({ localPath: gitFixtures.plainDirectory }),
    );

    expect(error).toBeInstanceOf(RepoRootResolutionError);
    expect((error as RepoRootResolutionError).code).toBe("repo.root_resolution_failed");
    expect((error as RepoRootResolutionError).reason).toBe("not_a_git_repository");
    expect(countMountRows()).toBe(0);
  });

  it("persists NOTHING when the root cannot be resolved", async () => {
    for (const unresolvable of [
      gitFixtures.absentPath,
      // Relative — the resolver refuses rather than completing it against the
      // daemon's working directory.
      "relative/not/absolute",
    ]) {
      const error = await captureRejection(() =>
        harness.service.attach({ localPath: unresolvable }),
      );
      expect(error).toBeInstanceOf(RepoRootResolutionError);
      expect((error as RepoRootResolutionError).code).toBe("repo.root_resolution_failed");
    }

    expect(countMountRows()).toBe(0);
  });

  it("admits a path with NO containment check — attach IS envelope admission", async () => {
    // The machine already has an envelope: one attached mount at
    // `repositoryRoot`. A containment check at attach would refuse anything
    // outside it, which is precisely what must NOT happen here.
    const first = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });

    const second = await harness.service.attach({
      // An unrelated repository, a sibling of the first and under no part of it.
      localPath: gitFixtures.unrelatedRepositoryRoot,
    });

    expect(second.canonicalRoot).toBe(gitFixtures.unrelatedRepositoryRoot);
    expect(second.repoMountId).not.toBe(first.repoMountId);
    expect(countMountRows()).toBe(2);
  });

  it("refuses the attach response — and writes nothing — when the identity is unrepresentable", async () => {
    // A minted id the branded schema refuses. The projection runs BEFORE the
    // write precisely so this leaves no durable mount: a mount that exists and
    // cannot be reported is one the caller never learns the id of, and so cannot
    // detach either.
    const service = createService({ newRepoMountId: () => "not-a-uuid" });

    const error = await captureRejection(() =>
      service.attach({ localPath: gitFixtures.repositoryRoot }),
    );

    expect(error).toBeInstanceOf(RepoMountServiceInvariantError);
    expect((error as RepoMountServiceInvariantError).kind).toBe("repo_mount_row_unprojectable");
    expect(countMountRows()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// attach — active-root uniqueness
// ----------------------------------------------------------------------------

describe("RepoMountService.attach — active-root uniqueness", () => {
  it("refuses a duplicate active root and writes nothing", async () => {
    const first = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });

    const error = await captureRejection(() =>
      harness.service.attach({
        // A DIFFERENT entered path resolving to the SAME canonical root — the
        // shape that proves the index keys `canonical_root`, not `local_path`.
        localPath: gitFixtures.nestedDirectory,
      }),
    );

    expect(error).toBeInstanceOf(RepoAlreadyAttachedError);
    expect((error as RepoAlreadyAttachedError).conflictingRepoMountId).toBe(first.repoMountId);
    expect((error as RepoAlreadyAttachedError).code).toBe("repo.already_attached");
    expect(countMountRows()).toBe(1);
  });

  it("attaches the same root cleanly on a different node", async () => {
    await harness.service.attach({ localPath: gitFixtures.repositoryRoot });

    // The same absolute path on two nodes names two node-local filesystems, and
    // both may attach (the node-scoped key).
    const otherNodeService = createService({
      nodeId: OTHER_NODE_ID,
      newRepoMountId: makeIdSource(MOUNT_ID_POOL.slice(1), "other-node repo mount"),
    });
    const otherNode = await otherNodeService.attach({ localPath: gitFixtures.repositoryRoot });

    expect(otherNode.canonicalRoot).toBe(gitFixtures.repositoryRoot);
    expect(requireMountRow(otherNode.repoMountId).node_id).toBe(OTHER_NODE_ID);
    expect(countMountRows()).toBe(2);
  });

  it("re-attaches a detached root as a NEW row", async () => {
    const first = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    await harness.service.detach({ repoMountId: first.repoMountId });

    const second = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });

    expect(second.repoMountId).not.toBe(first.repoMountId);
    // The durable record of the first mount is RETAINED, not replaced.
    expect(requireMountRow(first.repoMountId).state).toBe("detached");
    expect(requireMountRow(second.repoMountId).state).toBe("attached");
    expect(countMountRows()).toBe(2);
  });

  it("does NOT translate a constraint failure that is not the uniqueness index", async () => {
    // NEGATIVE CONTROL for the translation's discrimination. Two different roots
    // under one minted id: the failure is the primary key, and no active mount
    // holds the second root — so `repo.already_attached` would be a lie, and the
    // original error must surface untranslated.
    const service = createService({ newRepoMountId: () => INJECTED_MOUNT_ID });

    await service.attach({ localPath: gitFixtures.repositoryRoot });

    const error = await captureRejection(() =>
      service.attach({ localPath: gitFixtures.unrelatedRepositoryRoot }),
    );

    expect(error).not.toBeInstanceOf(RepoAlreadyAttachedError);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as { code?: unknown }).code)).toContain("SQLITE_CONSTRAINT");
    expect(countMountRows()).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// read
// ----------------------------------------------------------------------------

describe("RepoMountService.read", () => {
  it("projects the row and enriches it with a fresh health verdict", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.nestedDirectory });

    const response = await harness.service.read(attached.repoMountId);

    // BARE `id` on a read projection, per the contract's naming note.
    expect(response.id).toBe(attached.repoMountId);
    expect(response.nodeId).toBe(NODE_ID);
    expect(response.localPath).toBe(gitFixtures.nestedDirectory);
    expect(response.canonicalRoot).toBe(gitFixtures.repositoryRoot);
    expect(response.localPath).not.toBe(response.canonicalRoot);
    expect(response.vcsType).toBe("git");
    expect(response.state).toBe("attached");
    expect(response.health.status).toBe("healthy");
    // FRESH on-read probe floor: `checkedAt` is when this read measured the
    // root, not when the mount was attached. Asserting it is not BEFORE
    // `attachedAt` is the strongest ordering claim available without freezing
    // the clock — and it fails if `checkedAt` were ever sourced from the row
    // rather than the probe.
    expect(Date.parse(response.health.checkedAt)).not.toBeNaN();
    expect(Date.parse(response.health.checkedAt)).toBeGreaterThanOrEqual(
      Date.parse(requireMountRow(attached.repoMountId).attached_at),
    );
    expect(response.attachedAt).toBe(requireMountRow(attached.repoMountId).attached_at);
  });

  it("probes the row's canonical_root VERBATIM", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.nestedDirectory });

    const probedPaths: string[] = [];
    const service = createService({ probePath: recordingProbe((path) => probedPaths.push(path)) });
    await service.read(attached.repoMountId);

    // The ROW's canonical root, byte for byte — not the entered path, and not a
    // re-normalized spelling of either.
    expect(probedPaths).toEqual([gitFixtures.repositoryRoot]);
  });

  it("reports a vanished root as unreachable, and changes nothing", async () => {
    await runFixtureGit(
      ["init", "-q", harness.disposableRoot],
      gitFixtures.environment,
      gitFixtures.fixtureRoot,
    );
    const attached = await harness.service.attach({ localPath: harness.disposableRoot });
    // A REAL deletion, not a mocked verdict.
    rmSync(harness.disposableRoot, { recursive: true, force: true });

    const response = await harness.service.read(attached.repoMountId);

    expect(response.health.status).toBe("unreachable");
    // Health is a projection, never a persisted column and never a transition:
    // the mount is still `attached`.
    expect(response.state).toBe("attached");
    expect(requireMountRow(attached.repoMountId).state).toBe("attached");
  });

  it("answers for a DETACHED mount, and its health stays orthogonal to lifecycle", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    await harness.service.detach({ repoMountId: attached.repoMountId });

    const response = await harness.service.read(attached.repoMountId);

    // keeps the durable record, and a record that could not be read would not be
    // kept in any useful sense.
    expect(response.state).toBe("detached");
    // The root is still on disk, so the mount is `healthy`. Folding lifecycle
    // into health would invent a semantics the ratified shape does not carry.
    expect(response.health.status).toBe("healthy");
  });

  it("refuses an unknown mount id with repo.not_found", async () => {
    const error = await captureRejection(() => harness.service.read(UNKNOWN_MOUNT_ID));
    expect(error).toBeInstanceOf(RepoMountNotFoundError);
    expect((error as RepoMountNotFoundError).repoMountId).toBe(UNKNOWN_MOUNT_ID);
  });

  it("refuses a probe that measured some other path", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    const service = createService({
      probePath: mispairedProbe(gitFixtures.unrelatedRepositoryRoot),
    });

    const error = await captureRejection(() => service.read(attached.repoMountId));

    expect(error).toBeInstanceOf(RepoMountServiceInvariantError);
    expect((error as RepoMountServiceInvariantError).kind).toBe("repo_mount_row_unprojectable");
    expect((error as RepoMountServiceInvariantError).repoMountId).toBe(attached.repoMountId);
  });
});

// ----------------------------------------------------------------------------
// detach
// ----------------------------------------------------------------------------

describe("RepoMountService.detach", () => {
  it("archives every dependent and announces each to the session that bound it", async () => {
    // A STEPPING clock, not the wall clock. The `updated_at` assertions below
    // compare the attach stamp to the detach stamp, and `toISOString` is
    // millisecond-resolution — a real clock lets the two calls tie and the arm
    // fails intermittently for a reason that has nothing to do with the code.
    const service = createService({ now: steppingClock() });

    const attached = await service.attach({ localPath: gitFixtures.repositoryRoot });
    // One dependent per session: each archival must reach the log of the
    // session that bound it, never the other one.
    const workspaceIdBySession = new Map<SessionId, string>([
      [SESSION_ID, await bindWorkspace(attached.repoMountId, SESSION_ID)],
      [OTHER_SESSION_ID, await bindWorkspace(attached.repoMountId, OTHER_SESSION_ID)],
    ]);
    const mountBeforeDetach = requireMountRow(attached.repoMountId);

    const response = await service.detach({
      repoMountId: attached.repoMountId,
      actor: USER_ACTOR,
      correlationId: DETACH_CORRELATION_ID,
    });

    expect(response.state).toBe("detached");
    expect([...response.archivedWorkspaceIds].sort()).toEqual(
      [...workspaceIdBySession.values()].sort(),
    );

    const detachedMount = requireMountRow(attached.repoMountId);
    expect(detachedMount.state).toBe("detached");
    // The flip stamps `updated_at` and leaves `attached_at` alone: the two
    // answer different questions ("when did this mount come into being" vs "when
    // did it last move"), and a flip that wrote neither — or wrote the wrong one
    // — would still pass every `state` assertion in this file.
    expect(Date.parse(detachedMount.updated_at)).toBeGreaterThan(
      Date.parse(mountBeforeDetach.updated_at),
    );
    expect(detachedMount.attached_at).toBe(mountBeforeDetach.attached_at);

    for (const [sessionId, workspaceId] of workspaceIdBySession) {
      expect(requireWorkspaceRow(workspaceId).state).toBe("archived");
      // The session's own bind, then its own archival — and nothing about the
      // other session's workspace or the mount itself.
      expect(readLifecycleEventTypes(sessionId)).toEqual([
        "workspace.preparing",
        "workspace.archived",
      ]);
      const archived = readLifecycleEnvelopes(sessionId).filter(
        (row) => row.type === "workspace.archived",
      );
      const payload = JSON.parse(archived[0]?.payload ?? "{}") as {
        readonly workspaceId?: string;
        readonly repoMountId?: string;
      };
      expect(payload.workspaceId).toBe(workspaceId);
      // The dependent archival names its mount, per the cascade contract.
      expect(payload.repoMountId).toBe(attached.repoMountId);
      // The caller's linkage is the only thing that collates the cascade.
      expect(archived[0]?.actor).toBe(USER_ACTOR);
      expect(archived[0]?.correlation_id).toBe(DETACH_CORRELATION_ID);
    }
  });

  it("refuses while dependents are busy, naming EVERY busy one, and persists nothing", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    const firstWorkspaceId = await bindReadyWorkspace(attached.repoMountId);
    const secondWorkspaceId = await bindReadyWorkspace(attached.repoMountId);

    // TWO busy dependents, not one. With a single busy workspace the arm cannot
    // tell a refusal that COLLECTS every blocker from one that throws on the
    // first it meets — both produce a one-element array. The operator-facing
    // difference is real: a refusal naming one of two busy workspaces sends
    // someone to free that run and retry, only to be refused again.
    await harness.workspaces.markBusy(firstWorkspaceId, RUN_ID);
    await harness.workspaces.markBusy(secondWorkspaceId, OTHER_RUN_ID);
    const eventsBeforeRefusal = readLifecycleEventTypes();

    const error = await captureRejection(() =>
      harness.service.detach({ repoMountId: attached.repoMountId }),
    );

    expect(error).toBeInstanceOf(RepoDetachConflictError);
    // Order is the dependent statement's `created_at ASC, id ASC`: the first
    // bind precedes the second and the pooled ids ascend, so the two keys agree.
    expect((error as RepoDetachConflictError).busyWorkspaceIds).toEqual([
      firstWorkspaceId,
      secondWorkspaceId,
    ]);
    expect((error as RepoDetachConflictError).code).toBe("repo.detach_conflict");

    // Nothing moved and nothing was appended.
    expect(requireMountRow(attached.repoMountId).state).toBe("attached");
    expect(requireWorkspaceRow(firstWorkspaceId).state).toBe("busy");
    expect(requireWorkspaceRow(secondWorkspaceId).state).toBe("busy");
    expect(readLifecycleEventTypes()).toEqual(eventsBeforeRefusal);
  });

  it("emits no second workspace.archived for an already-archived dependent", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    const liveWorkspaceId = await bindWorkspace(attached.repoMountId);
    const archivedWorkspaceId = await bindWorkspace(attached.repoMountId);
    // Planted directly — a stand-in for a workspace archived on some earlier
    // path. An `archived` row is terminal, so re-archiving it is not a
    // transition, and a non-transition gets no event.
    harness.db
      .prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?")
      .run(archivedWorkspaceId);

    const response = await harness.service.detach({ repoMountId: attached.repoMountId });

    expect(response.archivedWorkspaceIds).toEqual([liveWorkspaceId]);
    expect(readLifecycleEventTypes()).toEqual([
      "workspace.preparing",
      "workspace.preparing",
      "workspace.archived",
    ]);
  });

  it("is a no-op success on an already-detached mount, with no event", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    await bindWorkspace(attached.repoMountId);
    await harness.service.detach({ repoMountId: attached.repoMountId });
    const eventsAfterFirstDetach = readLifecycleEventTypes();

    const second = await harness.service.detach({ repoMountId: attached.repoMountId });

    expect(second.state).toBe("detached");
    // An EMPTY array is valid and not degenerate: this call archived nothing.
    expect(second.archivedWorkspaceIds).toEqual([]);
    expect(readLifecycleEventTypes()).toEqual(eventsAfterFirstDetach);
  });

  it("refuses an unknown mount id with repo.not_found", async () => {
    const error = await captureRejection(() =>
      harness.service.detach({ repoMountId: UNKNOWN_MOUNT_ID }),
    );
    expect(error).toBeInstanceOf(RepoMountNotFoundError);
    expect(countMountRows()).toBe(0);
  });

  it("announces the remaining dependents when one archived append fails, then rejects", async () => {
    const emitter = new FirstArchiveAppendFailingEmitter({
      sessionEvents: new EventLogService({
        db: harness.db,
      }),
    });
    const service = createService({ events: emitter });

    const attached = await service.attach({ localPath: gitFixtures.repositoryRoot });
    const firstWorkspaceId = await bindWorkspace(attached.repoMountId);
    const secondWorkspaceId = await bindWorkspace(attached.repoMountId);

    const error = await captureRejection(() =>
      service.detach({ repoMountId: attached.repoMountId }),
    );

    // NEVER MASKED: the transaction committed, but the caller is told the log
    // is incomplete rather than handed a clean success.
    expect(error).toBeInstanceOf(RepoMountServiceInvariantError);
    expect((error as RepoMountServiceInvariantError).kind).toBe("detach_notification_incomplete");
    expect((error as RepoMountServiceInvariantError).repoMountId).toBe(attached.repoMountId);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe(SIMULATED_APPEND_FAILURE_MESSAGE);

    // NOT STRANDED: the loop attempted BOTH announcements. Stopping at the first
    // failure would leave `attemptedWorkspaceIds` one element long.
    expect(emitter.attemptedWorkspaceIds).toEqual([firstWorkspaceId, secondWorkspaceId]);

    // The rows are the truth and they are all correct — the failure is confined
    // to the log.
    expect(requireMountRow(attached.repoMountId).state).toBe("detached");
    expect(requireWorkspaceRow(firstWorkspaceId).state).toBe("archived");
    expect(requireWorkspaceRow(secondWorkspaceId).state).toBe("archived");

    // Exactly ONE `workspace.archived` landed, and it is the SECOND workspace —
    // the one whose append ran after the failure. That identity is what proves
    // the loop continued rather than the first append having quietly succeeded.
    expect(readLifecycleEventTypes()).toEqual([
      "workspace.preparing",
      "workspace.preparing",
      "workspace.archived",
    ]);
    const archivedEnvelopes = readLifecycleEnvelopes().filter(
      (row) => row.type === "workspace.archived",
    );
    expect(
      (JSON.parse(archivedEnvelopes[0]?.payload ?? "{}") as { workspaceId?: string }).workspaceId,
    ).toBe(secondWorkspaceId);

    // Calling again does NOT recover the missing event: the mount is already
    // `detached`, so this is the documented no-op. A caller that treats the
    // rejection as "retry the detach" gets a truthful empty answer, not a
    // second cascade.
    const retry = await service.detach({ repoMountId: attached.repoMountId });
    expect(retry.state).toBe("detached");
    expect(retry.archivedWorkspaceIds).toEqual([]);
    expect(readLifecycleEventTypes().filter((type) => type === "workspace.archived")).toHaveLength(
      1,
    );
  });

  it("archives a dependent that appeared AFTER the pre-transaction read", async () => {
    // The race the bind-side predicate closes from its end. The interference
    // commits a `ready` workspace on this mount in the window between
    // `detach`'s row read and its transaction — exactly where a bind that passed
    // the mount's `state = 'attached'` guard would land.
    //
    // DISCRIMINATING: if the dependent set were read outside the transaction,
    // this workspace would not be in it, nothing would be archived, and a live
    // execution root would survive on a detached mount.
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });

    const service = createService({
      now: interferingClock(() => {
        harness.db
          .prepare(
            `INSERT INTO workspaces (
               id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata,
               created_at, updated_at
             ) VALUES (
               @id, @session_id, @repo_mount_id, 'bound-root', @fs_root, 'ready', '{}', @now, @now
             )`,
          )
          .run({
            id: INJECTED_WORKSPACE_ID,
            session_id: SESSION_ID,
            repo_mount_id: attached.repoMountId,
            fs_root: gitFixtures.repositoryRoot,
            now: "2026-08-05T00:00:01.000Z",
          });
      }),
    });

    const response = await service.detach({ repoMountId: attached.repoMountId });

    expect(response.archivedWorkspaceIds).toEqual([INJECTED_WORKSPACE_ID]);
    expect(requireWorkspaceRow(INJECTED_WORKSPACE_ID).state).toBe("archived");
    expect(readLifecycleEventTypes()).toEqual(["workspace.archived"]);
  });

  it("rolls back and reports the winner when a concurrent detach wins the flip", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    const workspaceId = await bindWorkspace(attached.repoMountId);

    // The winner's write, landing after this call read the row as `attached`.
    const service = createService({
      now: interferingClock(() => {
        harness.db
          .prepare("UPDATE repo_mounts SET state = 'detached' WHERE id = ?")
          .run(attached.repoMountId);
      }),
    });

    const response = await service.detach({ repoMountId: attached.repoMountId });

    // The loser reports the WINNER's outcome rather than inventing one, and
    // claims to have archived nothing — because it did not.
    expect(response.state).toBe("detached");
    expect(response.archivedWorkspaceIds).toEqual([]);
    expect(readLifecycleEventTypes()).toEqual(["workspace.preparing"]);
    // The compare-and-swap aborted the whole transaction, so the cascade's
    // archive write rolled back with it.
    expect(requireWorkspaceRow(workspaceId).state).toBe("preparing");
  });
});

// ----------------------------------------------------------------------------
// Construction — the Windows `git` seam
// ----------------------------------------------------------------------------

describe("RepoMountService construction", () => {
  it("refuses to construct a bare-git resolver on win32", () => {
    // FAIL-CLOSED, and driven through the injected platform rather than the real
    // one so it runs on every CI leg. A guard keyed off `process.platform` would
    // be exercised only on a Windows runner — which is the argument
    // `repo-root-resolver.ts` already makes for deriving win32-ness from its
    // injected `path` module instead of the process.
    const error = captureThrow(() => createService({ platform: "win32" }));

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toContain("win32");
  });

  it("accepts a win32 construction that pins git, by either seam", () => {
    // NEGATIVE CONTROL for the guard above: it must refuse an OMISSION, not
    // refuse win32. Both legal shapes construct, and the same call without
    // `platform` proves the guard is win32-scoped rather than always-on.
    expect(() =>
      createService({ platform: "win32", gitExecutablePath: gitFixtures.missingGitExecutable }),
    ).not.toThrow();
    expect(() =>
      createService({ platform: "win32", resolver: new RepoRootResolver() }),
    ).not.toThrow();
    expect(() => createService({ platform: "linux" })).not.toThrow();
  });

  it("refuses both a resolver and a gitExecutablePath", () => {
    const error = captureThrow(() =>
      createService({
        resolver: new RepoRootResolver(),
        gitExecutablePath: gitFixtures.missingGitExecutable,
      }),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toContain("not both");
  });

  it("forwards gitExecutablePath to the resolver it constructs", async () => {
    // An ABSOLUTE path to a git that is not there. If the seam were dropped, the
    // default resolver would run the host's real `git` and this attach would
    // SUCCEED — which is what makes the arm discriminating rather than a
    // restatement of "missing binaries fail".
    const service = createService({ gitExecutablePath: gitFixtures.missingGitExecutable });

    const error = await captureRejection(() =>
      service.attach({ localPath: gitFixtures.repositoryRoot }),
    );

    expect(error).toBeInstanceOf(RepoRootResolutionError);
    // `vcs_error`, never `not_a_git_repository`: a repository whose git could
    // not run is still a repository.
    expect((error as RepoRootResolutionError).reason).toBe("vcs_error");
    expect(countMountRows()).toBe(0);
  });
});
