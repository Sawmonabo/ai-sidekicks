// Acceptance walk over the repo/workspace surface: repo mounts, workspaces and their events.
//
// It runs through the public entry points against a real temp-file SQLite database from
// `openDatabase`, a real `EventLogService` append path and real git repositories on disk. The
// per-module suites prove each branch; this one proves the claims a user sees, so every seam
// they inject (resolvers, filesystem probes, id sources, failing emitters) stays at its
// production default. Only two things are test-only: the seeded `session.created` row that
// `replay` needs, and one stepping clock shared by both services so `updated_at` comparisons
// never tie on a fast machine (no assertion reads a stamp value, only the order of stamps).
//
// The claims:
//   - Attaching a repository yields a durable repo mount with canonical-root metadata.
//   - One session binds workspaces across multiple repo mounts.
//   - An execution root that becomes unavailable makes the workspace `stale` and blocks writes.
//   - A mode switch reprovisions the workspace in place.
//   - The detach cascade archives the dependents and produces a fixed event sequence.
//
// Why no arm passes vacuously:
//   - Event-sequence arms assert the ordered type list, so an extra, missing or reordered event
//     fails.
//   - The stale arm deletes a real directory, then re-creates it: mount health recovers while
//     the workspace stays stale.
//   - Non-transition arms (a second `list`, a second `detach`, a busy/release pair) assert the
//     event log is unchanged, the only way to observe the negative half.

import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { NodeId, RepoAttachResponse, SessionId } from "@ai-sidekicks/contracts";
import { WorkspaceListResponseSchema } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService, TestSeedingAppendToken } from "../../session/session-service.js";
import { RepoMountService } from "../repo-mount-service.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import { WorkspaceService, WorkspaceStaleError } from "../workspace-service.js";

// Fixtures

const SESSION_ID: SessionId = "0190fa10-0000-7000-8000-000000000001" as SessionId;
// A second session that binds nothing: the control that shows `list` is scoped to a session.
const OTHER_SESSION_ID: SessionId = "0190fa10-0000-7000-8000-000000000002" as SessionId;
const NODE_ID: NodeId = "node-local" as NodeId;

const RUN_ID: string = "0190fa16-0000-7000-8000-000000000001";

/**
 * The mount-root-relative subdirectory one bind names. It is checked at bind time; the execution
 * root still comes from provisioning, not from this path.
 */
const BOUND_SUBDIRECTORY: string = "packages";

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
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly state: string;
}

// Real-git fixtures

/**
 * The hermetic environment fixture git runs under: no system or global config, a `HOME` inside
 * the temp root, an explicit identity. Discovery redirectors such as `GIT_DIR` are stripped so a
 * developer's ambient environment cannot make a fixture resolve elsewhere. Test files do not
 * import from one another, so this repeats the helper in `repo-mount-service.test.ts`.
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
 * Run a fixture git command, rejecting on any non-zero exit. `cwd` is pinned inside the fixture
 * root so git cannot discover the repository under development and bleed the fixture into it.
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

interface AcceptanceFixtures {
  readonly fixtureRoot: string;
  /** The hermetic environment fixture git runs under. */
  readonly environment: NodeJS.ProcessEnv;
  /** A real git repository root — what `rev-parse --show-toplevel` reports. */
  readonly repositoryRoot: string;
  /** A directory below `repositoryRoot`; attaching it must persist the root. */
  readonly nestedDirectory: string;
  /** The second real repository, for the multiple-mounts claim. */
  readonly secondRepositoryRoot: string;
}

let fixtures: AcceptanceFixtures;

beforeAll(async () => {
  // On macOS `os.tmpdir()` is under `/var/folders`, a symlink. The resolver canonicalizes, so
  // expectations built from the unresolved path would mismatch.
  const fixtureRoot: string = await realpath(
    await mkdtemp(join(tmpdir(), "ai-sidekicks-repo-workspace-acceptance-")),
  );
  const environment = buildFixtureEnvironment(fixtureRoot);

  const repositoryRoot = join(fixtureRoot, "repo-alpha");
  // One tree serves both "resolve upward to the root" and "bind downward to a subpath".
  const nestedDirectory = join(repositoryRoot, BOUND_SUBDIRECTORY, "daemon");
  const secondRepositoryRoot = join(fixtureRoot, "repo-beta");
  mkdirSync(nestedDirectory, { recursive: true });

  await runFixtureGit(["init", "-q", repositoryRoot], environment, fixtureRoot);
  await runFixtureGit(["init", "-q", secondRepositoryRoot], environment, fixtureRoot);

  fixtures = {
    fixtureRoot,
    environment,
    repositoryRoot,
    nestedDirectory,
    secondRepositoryRoot,
  };
}, 120_000);

afterAll(() => {
  if (fixtures !== undefined) {
    rmSync(fixtures.fixtureRoot, { recursive: true, force: true });
  }
});

// Per-test harness

/**
 * The whole repo/workspace service stack over one database handle. Durability arms rebuild it on
 * the reopened handle, because each service holds statements bound to its own handle.
 */
interface DaemonStack {
  readonly emitter: WorkspaceEventEmitter;
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService;
  readonly mounts: RepoMountService;
}

function buildDaemonStack(database: DatabaseType, now: () => string): DaemonStack {
  const emitter = new WorkspaceEventEmitter({
    sessionEvents: new EventLogService({
      db: database,
    }),
  });
  // The production id sources run; assertions name ids by identity or set membership.
  const sessions = new SessionService(database, {
    allowTestSeedingAppend: TestSeedingAppendToken.forTestsOnly(),
  });
  const workspaces = new WorkspaceService({ database, events: emitter, sessions, now });
  return {
    emitter,
    workspaces,
    sessions,
    mounts: new RepoMountService({ database, events: emitter, nodeId: NODE_ID, now }),
  };
}

interface TestHarness {
  /** Mutable: the durability arms close this handle and reopen the same file. */
  db: DatabaseType;
  readonly dbPath: string;
  readonly tmpDir: string;
  /** Mutable for the same reason as `db`. */
  stack: DaemonStack;
  /** The shared clock both services were constructed with. */
  readonly now: () => string;
  /** A per-test directory an arm may git-init and delete to make a mount root vanish. */
  readonly disposableMountRoot: string;
  /** Stands in for the provisioned worktree root. */
  readonly provisionedWorktreeRoot: string;
  /** Stands in for the root of a second mode switch. */
  readonly boundRootCheckout: string;
}

let harness: TestHarness;

/**
 * A clock that advances one second per read, from a fixed epoch. Both services share it, so
 * their stamps come from one sequence.
 */
function steppingClock(): () => string {
  let currentMs: number = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const stamp = new Date(currentMs).toISOString();
    currentMs += 1_000;
    return stamp;
  };
}

/** Seed a session's log so `SessionService.replay` returns a snapshot for it. */
function seedSession(sessionId: SessionId): void {
  harness.stack.sessions.append({
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

beforeEach(async () => {
  const tmpDir: string = await realpath(
    await mkdtemp(join(tmpdir(), "ai-sidekicks-repo-workspace-acceptance-db-")),
  );
  const dbPath = join(tmpDir, "test.db");
  const database: DatabaseType = openDatabase(dbPath);
  const now = steppingClock();

  const disposableMountRoot = join(tmpDir, "disposable-mount-root");
  const provisionedWorktreeRoot = join(tmpDir, "provisioned-worktree");
  const boundRootCheckout = join(tmpDir, "bound-root-checkout");
  for (const directory of [disposableMountRoot, provisionedWorktreeRoot, boundRootCheckout]) {
    mkdirSync(directory, { recursive: true });
  }

  harness = {
    db: database,
    dbPath,
    tmpDir,
    stack: buildDaemonStack(database, now),
    now,
    disposableMountRoot,
    provisionedWorktreeRoot,
    boundRootCheckout,
  };

  seedSession(SESSION_ID);
  seedSession(OTHER_SESSION_ID);
});

afterEach(() => {
  // The per-session append lock is a module singleton; a leftover entry would stall the next
  // case on the same session id as an unrelated timeout.
  __resetSessionAppendLocksForTest();
  harness.db.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

// Row and event readers use raw SQL, not a service call: durability is a claim about what is on
// disk, and reading back through the writing service would prove only that it agrees with itself.

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
  return harness.db
    .prepare(
      `SELECT id, repo_mount_id, execution_mode, fs_root, state
         FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as StoredWorkspaceRow | undefined;
}

function requireWorkspaceRow(workspaceId: string): StoredWorkspaceRow {
  const row = readWorkspaceRow(workspaceId);
  if (row === undefined) {
    throw new Error(`workspace ${workspaceId} is absent; the caller expected a row`);
  }
  return row;
}

function countRows(table: "workspaces" | "repo_mounts"): number {
  return (
    harness.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
      readonly total: number;
    }
  ).total;
}

/**
 * The session's event types without the seeded `session.created` anchor, which exists only
 * because `replay` refuses a chain that does not start with it.
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
  readonly payload: string;
}

function readLifecycleEnvelopes(): readonly StoredEventEnvelopeRow[] {
  return (
    harness.db
      .prepare(
        `SELECT type, actor, payload FROM session_events
          WHERE session_id = ? ORDER BY sequence ASC`,
      )
      .all(SESSION_ID) as readonly StoredEventEnvelopeRow[]
  ).filter((row) => row.type !== "session.created");
}

interface LifecycleEventPayload {
  readonly repoMountId?: string;
  readonly workspaceId?: string;
  readonly state?: string;
}

function readPayloadsOfType(type: string): readonly LifecycleEventPayload[] {
  return readLifecycleEnvelopes()
    .filter((row) => row.type === type)
    .map((row) => JSON.parse(row.payload) as LifecycleEventPayload);
}

/** Runs `body` and returns what it rejected with; throws if it resolved. */
async function captureRejection(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to reject, but it resolved");
}

/** Make `directory` a real git repository, so an attach of it resolves. */
function initRepository(directory: string): Promise<void> {
  return runFixtureGit(["init", "-q", directory], fixtures.environment, fixtures.fixtureRoot);
}

/** Bind a workspace and complete its provisioning at `fsRoot`, so it is `ready`. */
async function bindReadyWorkspace(
  repoMountId: RepoAttachResponse["repoMountId"],
  fsRoot: string,
): Promise<string> {
  const bound = await harness.stack.workspaces.bind({
    sessionId: SESSION_ID,
    repoMountId,
    executionMode: "bound-root",
  });
  await harness.stack.workspaces.completeRootPreparation(bound.workspaceId, fsRoot);
  return String(bound.workspaceId);
}

// The shared setup

interface AttachedMounts {
  /** A git repository, entered through a nested subdirectory. */
  readonly alpha: RepoAttachResponse;
  /** A second, unrelated git repository. */
  readonly beta: RepoAttachResponse;
}

/**
 * Attach two real git repositories. Their canonical roots must differ:
 * `idx_repo_mounts_active_root` is unique over `(node_id, canonical_root)` for `attached` rows.
 */
async function attachAcceptanceMounts(): Promise<AttachedMounts> {
  const alpha = await harness.stack.mounts.attach({ localPath: fixtures.nestedDirectory });
  const beta = await harness.stack.mounts.attach({ localPath: fixtures.secondRepositoryRoot });
  return { alpha, beta };
}

describe("attaching yields a durable repo mount with canonical-root metadata", () => {
  it("keeps both mounts across an openDatabase reopen", async () => {
    const attached = await attachAcceptanceMounts();

    // The resolved root, not the entered path; alpha is entered through a nested directory so
    // the two differ.
    expect(attached.alpha.canonicalRoot).toBe(fixtures.repositoryRoot);
    expect(attached.alpha.canonicalRoot).not.toBe(fixtures.nestedDirectory);
    expect(attached.beta.canonicalRoot).toBe(fixtures.secondRepositoryRoot);
    expect(attached.alpha.repoMountId).not.toBe(attached.beta.repoMountId);

    // Close and reopen the same file: an in-memory or uncommitted row does not survive this. The
    // stack from `beforeEach` is bound to the closed handle, so the rest reads raw SQL.
    harness.db.close();
    harness.db = openDatabase(harness.dbPath);

    expect(countRows("repo_mounts")).toBe(2);
    // An attach creates no workspace; a session binds one explicitly.
    expect(countRows("workspaces")).toBe(0);

    const expectedMounts: ReadonlyArray<{
      readonly attachResponse: RepoAttachResponse;
      readonly enteredPath: string;
      readonly canonicalRoot: string;
    }> = [
      {
        attachResponse: attached.alpha,
        enteredPath: fixtures.nestedDirectory,
        canonicalRoot: fixtures.repositoryRoot,
      },
      {
        attachResponse: attached.beta,
        enteredPath: fixtures.secondRepositoryRoot,
        canonicalRoot: fixtures.secondRepositoryRoot,
      },
    ];

    for (const expected of expectedMounts) {
      const mount = requireMountRow(expected.attachResponse.repoMountId);
      expect(mount.canonical_root).toBe(expected.canonicalRoot);
      // The entered path survives alongside the resolved root.
      expect(mount.local_path).toBe(expected.enteredPath);
      expect(mount.node_id).toBe(NODE_ID);
      expect(mount.vcs_type).toBe("git");
      expect(mount.state).toBe("attached");
      expect(Date.parse(mount.attached_at)).not.toBeNaN();
    }

    // Alpha shows the entered path and the resolved root differ.
    const alphaMount = requireMountRow(attached.alpha.repoMountId);
    expect(alphaMount.local_path).not.toBe(alphaMount.canonical_root);

    // Attaching writes no event to a session log.
    expect(readLifecycleEventTypes()).toEqual([]);
  });

  it("answers reads through a stack rebuilt on the reopened handle, appending nothing", async () => {
    const attached = await attachAcceptanceMounts();

    harness.db.close();
    harness.db = openDatabase(harness.dbPath);
    harness.stack = buildDaemonStack(harness.db, harness.now);

    const alphaRead = await harness.stack.mounts.read(attached.alpha.repoMountId);
    expect(alphaRead.id).toBe(attached.alpha.repoMountId);
    expect(alphaRead.canonicalRoot).toBe(fixtures.repositoryRoot);
    expect(alphaRead.localPath).toBe(fixtures.nestedDirectory);
    expect(alphaRead.vcsType).toBe("git");
    expect(alphaRead.state).toBe("attached");
    // Health is derived on each read; there is no persisted column to trust.
    expect(alphaRead.health.status).toBe("healthy");

    // Reads are not transitions.
    expect(readLifecycleEventTypes()).toEqual([]);
  });
});

describe("one session binds workspaces across multiple repo mounts", () => {
  it("lists every workspace across every mount with its state", async () => {
    const attached = await attachAcceptanceMounts();

    const rootWorkspace = await harness.stack.workspaces.bind({
      sessionId: SESSION_ID,
      repoMountId: attached.alpha.repoMountId,
      executionMode: "bound-root",
    });
    // A second workspace on alpha, naming a subdirectory of the mount.
    const subdirectoryWorkspace = await harness.stack.workspaces.bind({
      sessionId: SESSION_ID,
      repoMountId: attached.alpha.repoMountId,
      executionMode: "provisioned-worktree",
      directory: BOUND_SUBDIRECTORY,
    });
    const betaWorkspace = await harness.stack.workspaces.bind({
      sessionId: SESSION_ID,
      repoMountId: attached.beta.repoMountId,
      executionMode: "provisioned-worktree",
    });

    // Every bind lands `preparing` with no execution root until provisioning supplies one.
    for (const bound of [rootWorkspace, subdirectoryWorkspace, betaWorkspace]) {
      expect(bound.state).toBe("preparing");
      expect(requireWorkspaceRow(bound.workspaceId).fs_root).toBeNull();
    }

    const listed = await harness.stack.workspaces.list({ sessionId: SESSION_ID });

    // The listing must satisfy the wire schema, not only the in-process type.
    expect(WorkspaceListResponseSchema.parse(listed)).toEqual(listed);

    expect(
      new Map(
        listed.workspaces.map((workspace) => [
          String(workspace.id),
          [workspace.executionMode, workspace.state],
        ]),
      ),
    ).toEqual(
      new Map([
        [String(rootWorkspace.workspaceId), ["bound-root", "preparing"]],
        [String(subdirectoryWorkspace.workspaceId), ["provisioned-worktree", "preparing"]],
        [String(betaWorkspace.workspaceId), ["provisioned-worktree", "preparing"]],
      ]),
    );

    // The listing spans both mounts; a per-mount listing would not.
    expect(new Set(listed.workspaces.map((workspace) => String(workspace.repoMountId)))).toEqual(
      new Set([String(attached.alpha.repoMountId), String(attached.beta.repoMountId)]),
    );

    // It is still scoped: one mount's slice, and a session that bound nothing sees nothing.
    const alphaOnly = await harness.stack.workspaces.list({
      sessionId: SESSION_ID,
      repoMountId: attached.alpha.repoMountId,
    });
    expect(new Set(alphaOnly.workspaces.map((workspace) => String(workspace.id)))).toEqual(
      new Set([String(rootWorkspace.workspaceId), String(subdirectoryWorkspace.workspaceId)]),
    );

    const otherSession = await harness.stack.workspaces.list({ sessionId: OTHER_SESSION_ID });
    expect(otherSession.workspaces).toEqual([]);
    expect(readLifecycleEventTypes(OTHER_SESSION_ID)).toEqual([]);
  });
});

describe("the full-lifecycle event sequence", () => {
  it("emits exactly one event per transition, and one archival per dependent", async () => {
    const alpha = await harness.stack.mounts.attach({ localPath: fixtures.nestedDirectory });
    // A second mount the detach must not touch; a cascade over the whole roster would pass a
    // single-mount arm.
    const beta = await harness.stack.mounts.attach({ localPath: fixtures.secondRepositoryRoot });

    const alphaWorkspace = await harness.stack.workspaces.bind({
      sessionId: SESSION_ID,
      repoMountId: alpha.repoMountId,
      executionMode: "provisioned-worktree",
    });
    expect(requireWorkspaceRow(alphaWorkspace.workspaceId).state).toBe("preparing");
    await harness.stack.workspaces.completeRootPreparation(
      alphaWorkspace.workspaceId,
      harness.provisionedWorktreeRoot,
    );
    expect(requireWorkspaceRow(alphaWorkspace.workspaceId).fs_root).toBe(
      harness.provisionedWorktreeRoot,
    );
    const subdirectoryWorkspace = await harness.stack.workspaces.bind({
      sessionId: SESSION_ID,
      repoMountId: alpha.repoMountId,
      executionMode: "bound-root",
      directory: BOUND_SUBDIRECTORY,
    });
    const betaWorkspace = await harness.stack.workspaces.bind({
      sessionId: SESSION_ID,
      repoMountId: beta.repoMountId,
      executionMode: "provisioned-worktree",
    });

    // The provisioned root really vanishes; the next read derives and persists the stale state.
    rmSync(harness.provisionedWorktreeRoot, { recursive: true, force: true });
    const afterLoss = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(
      new Map(afterLoss.workspaces.map((workspace) => [String(workspace.id), workspace.state])),
    ).toEqual(
      new Map([
        [String(alphaWorkspace.workspaceId), "stale"],
        [String(subdirectoryWorkspace.workspaceId), "preparing"],
        [String(betaWorkspace.workspaceId), "preparing"],
      ]),
    );

    // A second read of the same state is not a second transition.
    const eventsBeforeSecondRead = readLifecycleEventTypes();
    await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(readLifecycleEventTypes()).toEqual(eventsBeforeSecondRead);

    const mountBeforeDetach = requireMountRow(alpha.repoMountId);
    const detached = await harness.stack.mounts.detach({ repoMountId: alpha.repoMountId });
    expect(detached.state).toBe("detached");
    expect([...detached.archivedWorkspaceIds].sort()).toEqual(
      [String(alphaWorkspace.workspaceId), String(subdirectoryWorkspace.workspaceId)].sort(),
    );

    // Detach keeps the record: `updated_at` moves forward and `attached_at` stays. The stepping
    // clock keeps the two stamps from tying.
    const mountAfterDetach = requireMountRow(alpha.repoMountId);
    expect(mountAfterDetach.state).toBe("detached");
    expect(Date.parse(mountAfterDetach.updated_at)).toBeGreaterThan(
      Date.parse(mountBeforeDetach.updated_at),
    );
    expect(mountAfterDetach.attached_at).toBe(mountBeforeDetach.attached_at);

    // Detaching an already-detached mount is a no-op success, not a transition.
    const secondDetach = await harness.stack.mounts.detach({ repoMountId: alpha.repoMountId });
    expect(secondDetach.state).toBe("detached");
    expect(secondDetach.archivedWorkspaceIds).toEqual([]);

    // The mount announces nothing; each archival follows the commit that made it true.
    expect(readLifecycleEventTypes()).toEqual([
      "workspace.preparing",
      "workspace.ready",
      "workspace.preparing",
      "workspace.preparing",
      "workspace.stale",
      "workspace.archived",
      "workspace.archived",
    ]);

    // Each cascaded archival names its workspace and its mount, once.
    const archivedPayloads = readPayloadsOfType("workspace.archived");
    expect(new Set(archivedPayloads.map((payload) => payload.workspaceId))).toEqual(
      new Set([String(alphaWorkspace.workspaceId), String(subdirectoryWorkspace.workspaceId)]),
    );
    for (const payload of archivedPayloads) {
      expect(payload.repoMountId).toBe(String(alpha.repoMountId));
      expect(payload.state).toBe("archived");
    }

    const stalePayloads = readPayloadsOfType("workspace.stale");
    expect(stalePayloads).toHaveLength(1);
    expect(stalePayloads[0]?.workspaceId).toBe(String(alphaWorkspace.workspaceId));

    // The cascade stopped at the mount boundary.
    expect(requireMountRow(beta.repoMountId).state).toBe("attached");
    expect(requireWorkspaceRow(betaWorkspace.workspaceId).state).toBe("preparing");
    expect(requireWorkspaceRow(alphaWorkspace.workspaceId).state).toBe("archived");
    expect(requireWorkspaceRow(subdirectoryWorkspace.workspaceId).state).toBe("archived");
  });
});

describe("a mode switch reprovisions IN PLACE", () => {
  it("keeps the id and the row through two full cycles, updating mode and root", async () => {
    const alpha = await harness.stack.mounts.attach({ localPath: fixtures.repositoryRoot });
    const workspaceId = await bindReadyWorkspace(alpha.repoMountId, fixtures.repositoryRoot);
    const beforeCycles = requireWorkspaceRow(workspaceId);
    expect(beforeCycles.execution_mode).toBe("bound-root");
    expect(beforeCycles.fs_root).toBe(fixtures.repositoryRoot);
    expect(countRows("workspaces")).toBe(1);

    await harness.stack.workspaces.beginRootPreparation(workspaceId, "provisioned-worktree");
    const midCycle = requireWorkspaceRow(workspaceId);
    expect(midCycle.state).toBe("preparing");
    expect(midCycle.execution_mode).toBe("provisioned-worktree");
    // The old root is dropped when the switch begins, so a run is not handed a path the new mode
    // does not use.
    expect(midCycle.fs_root).toBeNull();

    await harness.stack.workspaces.completeRootPreparation(
      workspaceId,
      harness.provisionedWorktreeRoot,
    );

    // A second switch, to another mode and root: one cycle cannot tell a stable id from an id
    // that is stable once.
    await harness.stack.workspaces.beginRootPreparation(workspaceId, "bound-root");
    await harness.stack.workspaces.completeRootPreparation(workspaceId, harness.boundRootCheckout);

    const afterCycles = requireWorkspaceRow(workspaceId);
    expect(afterCycles.id).toBe(workspaceId);
    expect(afterCycles.repo_mount_id).toBe(String(alpha.repoMountId));
    expect(afterCycles.state).toBe("ready");
    expect(afterCycles.execution_mode).toBe("bound-root");
    expect(afterCycles.fs_root).toBe(harness.boundRootCheckout);
    // No row was created or destroyed; a second inserted row would also leave the id looking
    // stable.
    expect(countRows("workspaces")).toBe(1);

    const listed = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(listed.workspaces).toHaveLength(1);
    expect(String(listed.workspaces[0]?.id)).toBe(workspaceId);
    expect(listed.workspaces[0]?.executionMode).toBe("bound-root");
    expect(listed.workspaces[0]?.fsRoot).toBe(harness.boundRootCheckout);

    expect(readLifecycleEventTypes()).toEqual([
      "workspace.preparing",
      "workspace.ready",
      "workspace.preparing",
      "workspace.ready",
      "workspace.preparing",
      "workspace.ready",
    ]);
  });
});

describe("a root that vanishes makes its workspace stale", () => {
  it("persists the transition, refuses writes, and never auto-heals", async () => {
    // A healthy sibling on a root that stays put, so "the write gate refuses" differs from "the
    // write gate refuses everything".
    const sibling = await harness.stack.mounts.attach({ localPath: fixtures.repositoryRoot });
    const siblingWorkspaceId = await bindReadyWorkspace(
      sibling.repoMountId,
      fixtures.repositoryRoot,
    );
    // The victim: a mount rooted at a directory this arm owns and deletes.
    await initRepository(harness.disposableMountRoot);
    const victim = await harness.stack.mounts.attach({ localPath: harness.disposableMountRoot });
    const victimWorkspaceId = await bindReadyWorkspace(
      victim.repoMountId,
      harness.disposableMountRoot,
    );

    rmSync(harness.disposableMountRoot, { recursive: true, force: true });

    const listedAfterLoss = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(
      new Map(
        listedAfterLoss.workspaces.map((workspace) => [String(workspace.id), workspace.state]),
      ),
    ).toEqual(
      new Map([
        [siblingWorkspaceId, "ready"],
        [victimWorkspaceId, "stale"],
      ]),
    );
    // Persisted, not merely reported: the next reader sees the row without re-probing.
    expect(requireWorkspaceRow(victimWorkspaceId).state).toBe("stale");

    // The mount read reports the loss as health, not as a lifecycle change: the row stays
    // `attached`.
    const victimMount = await harness.stack.mounts.read(victim.repoMountId);
    expect(victimMount.health.status).toBe("unreachable");
    expect(victimMount.state).toBe("attached");
    expect(requireMountRow(victim.repoMountId).state).toBe("attached");

    const refusal = await captureRejection(() =>
      harness.stack.workspaces.assertWritable(victimWorkspaceId),
    );
    expect(refusal).toBeInstanceOf(WorkspaceStaleError);
    expect((refusal as WorkspaceStaleError).code).toBe("workspace.stale");
    expect((refusal as WorkspaceStaleError).workspaceId).toBe(victimWorkspaceId);
    await expect(
      harness.stack.workspaces.assertWritable(siblingWorkspaceId),
    ).resolves.toBeUndefined();

    // The directory comes back. Mount health recovers because it is derived per read; the
    // workspace stays stale, because a run resumed on a re-created empty directory would lose
    // data silently.
    mkdirSync(harness.disposableMountRoot, { recursive: true });
    const listedAfterRepair = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(
      listedAfterRepair.workspaces.find((workspace) => String(workspace.id) === victimWorkspaceId)
        ?.state,
    ).toBe("stale");
    expect((await harness.stack.mounts.read(victim.repoMountId)).health.status).toBe("healthy");

    // One `workspace.stale` across all the reads.
    expect(readLifecycleEventTypes()).toEqual([
      "workspace.preparing",
      "workspace.ready",
      "workspace.preparing",
      "workspace.ready",
      "workspace.stale",
    ]);

    // The run hold has no registered event type: `ready -> busy -> ready` moves the row and
    // appends nothing.
    const eventsBeforeHold = readLifecycleEventTypes();
    await harness.stack.workspaces.markBusy(siblingWorkspaceId, RUN_ID);
    expect(requireWorkspaceRow(siblingWorkspaceId).state).toBe("busy");
    expect(harness.stack.workspaces.releaseBusy(siblingWorkspaceId)).toBe(true);
    expect(requireWorkspaceRow(siblingWorkspaceId).state).toBe("ready");
    expect(readLifecycleEventTypes()).toEqual(eventsBeforeHold);
  });
});
