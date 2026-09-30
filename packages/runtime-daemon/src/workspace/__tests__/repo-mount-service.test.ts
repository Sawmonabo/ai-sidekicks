// RepoMountService behavior, against a real temp-file SQLite database, a real event log, real
// `WorkspaceService` and `SessionService`, and real git repositories built with `execFile` (the
// approach `repo-root-resolver.test.ts` uses): "attach through a subdirectory resolves to the
// repository root" is only a real claim if git answered it.
//
// Test-only mechanisms:
//   * Real git fixtures under a hermetic environment; a mocked resolver would let every
//     canonical-root assertion pass against a value the test invented.
//   * An interfering clock that mutates the database on its first read. `detach` reads the clock
//     between its pre-transaction row read and the transaction, the window the compare-and-swap
//     and the in-transaction dependent read exist for; real concurrency would be flaky or would
//     never reach it.
//   * An injected `newRepoMountId` that mints a colliding id, to reach a constraint failure the
//     production id source cannot produce.
//   * An emitter whose first `workspace.archived` append rejects, for the post-commit announcement
//     path; that failure (a size refusal, a full disk) has no other trigger.
//   * An injected `platform`, so the win32 git-pinning guard runs on every CI leg, not only on
//     Windows.

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
import { WorkspaceService } from "../workspace-service.js";
import { type FilesystemPathProbeFn } from "../workspace-row-guards.js";

const SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000001" as SessionId;
const OTHER_SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000002" as SessionId;
const NODE_ID: NodeId = "node-local" as NodeId;
const OTHER_NODE_ID: NodeId = "node-remote" as NodeId;
const UNKNOWN_MOUNT_ID: RepoMountId = "0190f9a1-0000-7000-8000-00000000ffff" as RepoMountId;

const USER_ACTOR: string = "0190f9a4-0000-7000-8000-000000000001";
const DETACH_CORRELATION_ID: string = "0190f9a5-0000-7000-8000-000000000002";
const RUN_ID: string = "0190f9a6-0000-7000-8000-000000000001";
const OTHER_RUN_ID: string = "0190f9a6-0000-7000-8000-000000000002";
// A post-commit append failure, such as a size refusal or a disk error.
const SIMULATED_APPEND_FAILURE_MESSAGE: string = "simulated append failure";

// Real UUIDs: a counter would fail the branded schemas.
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
// Named because `MOUNT_ID_POOL[0]` needs a cast to shed `| undefined`.
const INJECTED_MOUNT_ID: string = "0190f9a1-0000-7000-8000-00000000aaaa";

/**
 * An emitter whose first `workspace.archived` append rejects; later ones append for real.
 * Failing the first of two lets an arm tell a loop that continued from one that stopped.
 */
class FirstArchiveAppendFailingEmitter extends WorkspaceEventEmitter {
  #failuresRemaining: number = 1;
  /** Every workspace id the service attempted to announce, in call order. */
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

/**
 * The hermetic environment fixture git runs under: no system or global config, a `HOME` inside the
 * temp root, an explicit identity, and the discovery variables (`GIT_DIR` and the like) stripped
 * so an ambient one cannot redirect a fixture. Same as the helper in `repo-root-resolver.test.ts`.
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
 * Runs a fixture git command, rejecting on any non-zero exit. `cwd` is pinned inside the fixture
 * root so git cannot discover the repository under development and bleed into the host.
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
  /** A second, unrelated repository. */
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
  // Realpath the temp root once: on macOS `os.tmpdir()` is under `/var/folders/`, a symlink, and
  // the resolver canonicalizes, so an unresolved root would mismatch every assertion.
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

interface TestHarness {
  /** Mutable: the durability arm closes this handle and reopens the same file. */
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
 * Builds a service over the harness database, optionally overriding one seam. With no overrides it
 * drives real git and real directories through the production primitives.
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
 * The session's event types without the seeded `session.created` anchor, which `replay` requires
 * as the chain's start and which would bury the sequence each arm is about.
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
 * A clock that advances one second per read, so arms that compare two stamps do not tie:
 * `toISOString` has millisecond resolution and two calls microseconds apart give the same string.
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
 * A clock that runs `interfere()` once on its first read, then answers a fixed stamp. `detach`
 * reads the clock after its pre-transaction row read and before the transaction opens, so this
 * drives the race arms. Use it only for the `detach` call; `attach` reads the clock too.
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
  // The per-session append lock is a module singleton; a leftover queue entry would stall the next
  // case on the same session id and look like an unrelated timeout.
  __resetSessionAppendLocksForTest();
  harness.db.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

describe("RepoMountService.attach", () => {
  it("persists the resolved root of a SUBDIRECTORY attach, and it survives a reopen", async () => {
    const response = await harness.service.attach({
      // Below the repository root: the only shape where the entered path and canonical root differ.
      localPath: gitFixtures.nestedDirectory,
    });

    expect(response.state).toBe("attached");
    expect(response.vcsType).toBe("git");
    expect(response.canonicalRoot).toBe(gitFixtures.repositoryRoot);
    expect(response.canonicalRoot).not.toBe(gitFixtures.nestedDirectory);

    // Durability: close the handle, reopen the same file, and read; an uncommitted row would not
    // survive.
    harness.db.close();
    harness.db = openDatabase(harness.dbPath);

    const mount = requireMountRow(response.repoMountId);
    expect(mount.canonical_root).toBe(gitFixtures.repositoryRoot);
    // The entered path is kept alongside the resolved root, and the two differ.
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
      // Relative: the resolver refuses it rather than resolving it against the working directory.
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
    // The machine already has an attached mount at `repositoryRoot`. A containment check at attach
    // would refuse anything outside it, and must not.
    const first = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });

    const second = await harness.service.attach({
      // A sibling repository, not under the first.
      localPath: gitFixtures.unrelatedRepositoryRoot,
    });

    expect(second.canonicalRoot).toBe(gitFixtures.unrelatedRepositoryRoot);
    expect(second.repoMountId).not.toBe(first.repoMountId);
    expect(countMountRows()).toBe(2);
  });

  it("refuses the attach response — and writes nothing — when the identity is unrepresentable", async () => {
    // A minted id the branded schema refuses. The projection runs before the write so no durable
    // mount is left behind: a mount that cannot be reported is one the caller can never detach.
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

describe("RepoMountService.attach — active-root uniqueness", () => {
  it("refuses a duplicate active root and writes nothing", async () => {
    const first = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });

    const error = await captureRejection(() =>
      harness.service.attach({
        // A different entered path resolving to the same canonical root: the index keys
        // `canonical_root`.
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

    // The same path on two nodes names two node-local filesystems, so both may attach.
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
    // The first mount's record is retained, not replaced.
    expect(requireMountRow(first.repoMountId).state).toBe("detached");
    expect(requireMountRow(second.repoMountId).state).toBe("attached");
    expect(countMountRows()).toBe(2);
  });

  it("does NOT translate a constraint failure that is not the uniqueness index", async () => {
    // Negative control: two different roots under one minted id fail on the primary key. No active
    // mount holds the second root, so `repo.already_attached` would be wrong and the original error
    // must surface.
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

describe("RepoMountService.read", () => {
  it("projects the row and enriches it with a fresh health verdict", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.nestedDirectory });

    const response = await harness.service.read(attached.repoMountId);

    // A read projection carries a bare `id`.
    expect(response.id).toBe(attached.repoMountId);
    expect(response.nodeId).toBe(NODE_ID);
    expect(response.localPath).toBe(gitFixtures.nestedDirectory);
    expect(response.canonicalRoot).toBe(gitFixtures.repositoryRoot);
    expect(response.localPath).not.toBe(response.canonicalRoot);
    expect(response.vcsType).toBe("git");
    expect(response.state).toBe("attached");
    expect(response.health.status).toBe("healthy");
    // `checkedAt` comes from this read's probe, so it is not before `attachedAt`.
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

    // The row's canonical root byte for byte, not the entered path or a re-normalized spelling.
    expect(probedPaths).toEqual([gitFixtures.repositoryRoot]);
  });

  it("reports a vanished root as unreachable, and changes nothing", async () => {
    await runFixtureGit(
      ["init", "-q", harness.disposableRoot],
      gitFixtures.environment,
      gitFixtures.fixtureRoot,
    );
    const attached = await harness.service.attach({ localPath: harness.disposableRoot });
    // A real deletion, not a mocked verdict.
    rmSync(harness.disposableRoot, { recursive: true, force: true });

    const response = await harness.service.read(attached.repoMountId);

    expect(response.health.status).toBe("unreachable");
    // Health is a projection, not a persisted column or a transition; the mount stays `attached`.
    expect(response.state).toBe("attached");
    expect(requireMountRow(attached.repoMountId).state).toBe("attached");
  });

  it("answers for a DETACHED mount, and its health stays orthogonal to lifecycle", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    await harness.service.detach({ repoMountId: attached.repoMountId });

    const response = await harness.service.read(attached.repoMountId);

    // A detached mount keeps its durable record, and the record stays readable.
    expect(response.state).toBe("detached");
    // The root is still on disk, so health is `healthy`; health does not fold in lifecycle.
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

describe("RepoMountService.detach", () => {
  it("archives every dependent and announces each to the session that bound it", async () => {
    // A stepping clock: the `updated_at` assertions compare attach and detach stamps, which would
    // tie on the millisecond-resolution wall clock and fail intermittently.
    const service = createService({ now: steppingClock() });

    const attached = await service.attach({ localPath: gitFixtures.repositoryRoot });
    // One dependent per session: each archival must reach the log of the session that bound it.
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
    // The flip stamps `updated_at` and leaves `attached_at` alone; a flip that wrote neither, or
    // the wrong one, would still pass every `state` assertion.
    expect(Date.parse(detachedMount.updated_at)).toBeGreaterThan(
      Date.parse(mountBeforeDetach.updated_at),
    );
    expect(detachedMount.attached_at).toBe(mountBeforeDetach.attached_at);

    for (const [sessionId, workspaceId] of workspaceIdBySession) {
      expect(requireWorkspaceRow(workspaceId).state).toBe("archived");
      // The session's own bind then its own archival, and nothing about the other session or the
      // mount.
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
      // The dependent archival names its mount.
      expect(payload.repoMountId).toBe(attached.repoMountId);
      // The caller's actor and correlation id are the only link that groups the cascade's events.
      expect(archived[0]?.actor).toBe(USER_ACTOR);
      expect(archived[0]?.correlation_id).toBe(DETACH_CORRELATION_ID);
    }
  });

  it("refuses while dependents are busy, naming EVERY busy one, and persists nothing", async () => {
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    const firstWorkspaceId = await bindReadyWorkspace(attached.repoMountId);
    const secondWorkspaceId = await bindReadyWorkspace(attached.repoMountId);

    // Two busy dependents, not one: with a single one the arm cannot tell a refusal that collects
    // every blocker from one that throws on the first. Naming one of two would send someone to free
    // that run and retry, only to be refused again.
    await harness.workspaces.markBusy(firstWorkspaceId, RUN_ID);
    await harness.workspaces.markBusy(secondWorkspaceId, OTHER_RUN_ID);
    const eventsBeforeRefusal = readLifecycleEventTypes();

    const error = await captureRejection(() =>
      harness.service.detach({ repoMountId: attached.repoMountId }),
    );

    expect(error).toBeInstanceOf(RepoDetachConflictError);
    // Order is the dependent query's `created_at ASC, id ASC`: the first bind precedes the second
    // and the ids ascend, so both keys agree.
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
    // Planted directly, standing in for a workspace archived earlier. `archived` is terminal, so
    // re-archiving is not a transition and gets no event.
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
    // An empty array is valid: this call archived nothing.
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

    // The transaction committed, but the caller is told the log is incomplete, not handed a
    // success.
    expect(error).toBeInstanceOf(RepoMountServiceInvariantError);
    expect((error as RepoMountServiceInvariantError).kind).toBe("detach_notification_incomplete");
    expect((error as RepoMountServiceInvariantError).repoMountId).toBe(attached.repoMountId);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe(SIMULATED_APPEND_FAILURE_MESSAGE);

    // The loop attempted both announcements; stopping at the first failure would leave
    // `attemptedWorkspaceIds` one element long.
    expect(emitter.attemptedWorkspaceIds).toEqual([firstWorkspaceId, secondWorkspaceId]);

    // The rows are correct; the failure is confined to the log.
    expect(requireMountRow(attached.repoMountId).state).toBe("detached");
    expect(requireWorkspaceRow(firstWorkspaceId).state).toBe("archived");
    expect(requireWorkspaceRow(secondWorkspaceId).state).toBe("archived");

    // Exactly one `workspace.archived` landed, for the second workspace, whose append ran after the
    // failure. That proves the loop continued.
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

    // Calling again does not recover the missing event: the mount is already `detached`, so the
    // call is a no-op with an empty answer, not a second cascade.
    const retry = await service.detach({ repoMountId: attached.repoMountId });
    expect(retry.state).toBe("detached");
    expect(retry.archivedWorkspaceIds).toEqual([]);
    expect(readLifecycleEventTypes().filter((type) => type === "workspace.archived")).toHaveLength(
      1,
    );
  });

  it("archives a dependent that appeared AFTER the pre-transaction read", async () => {
    // A `ready` workspace is committed on this mount between `detach`'s row read and its
    // transaction, where a bind that passed the `state = 'attached'` guard would land. Had the
    // dependent set been read outside the transaction, this workspace would be missed and a live
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

    // The winner's write lands after this call read the row as `attached`.
    const service = createService({
      now: interferingClock(() => {
        harness.db
          .prepare("UPDATE repo_mounts SET state = 'detached' WHERE id = ?")
          .run(attached.repoMountId);
      }),
    });

    const response = await service.detach({ repoMountId: attached.repoMountId });

    // The loser reports the winner's outcome and archived nothing.
    expect(response.state).toBe("detached");
    expect(response.archivedWorkspaceIds).toEqual([]);
    expect(readLifecycleEventTypes()).toEqual(["workspace.preparing"]);
    // The compare-and-swap aborted the whole transaction, so the cascade's archive write rolled
    // back too.
    expect(requireWorkspaceRow(workspaceId).state).toBe("preparing");
  });
});

describe("RepoMountService construction", () => {
  it("refuses to construct a bare-git resolver on win32", () => {
    // Fail-closed. Driven through the injected platform so it runs on every CI leg; a guard keyed
    // off `process.platform` would run only on Windows, which is why `repo-root-resolver.ts`
    // derives win32-ness from its injected `path` module.
    const error = captureThrow(() => createService({ platform: "win32" }));

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toContain("win32");
  });

  it("accepts a win32 construction that pins git, by either seam", () => {
    // Negative control: the guard must refuse an omission, not win32. Both legal shapes construct,
    // and `linux` shows the guard is win32-scoped.
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
    // An absolute path to a git that is not there. Were the seam dropped, the default resolver
    // would run the host's real `git` and the attach would succeed.
    const service = createService({ gitExecutablePath: gitFixtures.missingGitExecutable });

    const error = await captureRejection(() =>
      service.attach({ localPath: gitFixtures.repositoryRoot }),
    );

    expect(error).toBeInstanceOf(RepoRootResolutionError);
    // `vcs_error`, not `not_a_git_repository`: a repository whose git could not run is still a
    // repository.
    expect((error as RepoRootResolutionError).reason).toBe("vcs_error");
    expect(countMountRows()).toBe(0);
  });
});
