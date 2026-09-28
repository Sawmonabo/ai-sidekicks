// Repo/workspace acceptance suite.
//
// The integration walk over the whole repo/workspace surface: the migration,
// the event emitter, `RepoMountService`, `WorkspaceService` and the health
// projector — driven end to end against a real temp-FILE SQLite database
// opened by the canonical `openDatabase` factory (pragma and migration order
// are never re-derived in a test), a real `EventLogService` append path, and
// REAL git repositories built on disk with `execFile`.
//
// This is deliberately NOT a second copy of the per-module suites. Those prove
// each module's branches; this file proves the claims the SPEC MAKES TO A USER,
// and proves them the only way an acceptance test can — through the public
// entry points, over durable state, with nothing mocked that the claim depends
// on. Every seam the sibling suites inject to reach a branch (resolvers,
// filesystem probes, id sources, interfering clocks, failing emitters) is left
// at its production default here. Beyond the two this package's harnesses all
// share — a fixed daemon signing key, and the seeded `session.created` anchor
// `replay` requires of every chain — two mechanisms are test-only:
//
//   * REAL git fixtures, built once in `beforeAll` under a hermetic
//     environment.
//   * ONE stepping clock, shared by both services so their `updated_at` stamps
//     come from a single sequence. `toISOString` is millisecond-resolution, so
//     the `updated_at` comparisons would otherwise tie and fail on machine
//     speed. No assertion here reads a stamp VALUE — only relations between
//     stamps this code wrote.
//
// The claims:
//   • Attaching a repository yields a durable repo mount with canonical-root
//     metadata: the durability arms close the handle and reopen the same FILE
//     before reading anything.
//   • One session binds workspaces across multiple repo mounts.
//   • An execution root that becomes unavailable makes the workspace `stale`
//     and blocks new write runs.
//   • The in-place reprovision cycle.
//   • The archive cascade and the durable-event sequence it produces.
//
// Why no arm here can pass vacuously:
//   * The event-sequence arms assert the ORDERED type list, not membership, so
//     an extra, missing or reordered event fails.
//   * The stale arms delete a REAL directory, so "reports stale" is
//     distinguishable from "was already stale"; the stale arm additionally
//     re-creates it, so "never heals" is separable from "the daemon cannot see
//     the repair" — mount health recovers while the workspace stays stale.
//   * The non-transition arms (a second `list`, a second `detach`, a
//     busy/release pair) assert the event log is UNCHANGED, which is the only
//     way the negative half is observable at all.

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
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService, UnsignedPlaceholderAppendToken } from "../../session/session-service.js";
import { RepoMountService } from "../repo-mount-service.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import { WorkspaceService, WorkspaceStaleError } from "../workspace-service.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "0190fa10-0000-7000-8000-000000000001" as SessionId;
// A second session that binds nothing — the isolation control for the "one
// session binds" claim, which is meaningless if `list` is not scoped.
const OTHER_SESSION_ID: SessionId = "0190fa10-0000-7000-8000-000000000002" as SessionId;
const NODE_ID: NodeId = "node-local" as NodeId;

const RUN_ID: string = "0190fa16-0000-7000-8000-000000000001";

/**
 * The mount-root-relative subdirectory one bind names.
 *
 * Checked against the trust envelope at bind time; the workspace's execution
 * root still comes from provisioning, not from this path.
 */
const BOUND_SUBDIRECTORY: string = "packages";

const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(
  17,
) as Ed25519PrivateKey;

/** Fixed-key signer — key custody is `signing-key-source.test.ts`'s beat. */
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

// ----------------------------------------------------------------------------
// Real-git fixtures
// ----------------------------------------------------------------------------

/**
 * The hermetic environment FIXTURE git runs under — no system config, no global
 * config, a `HOME` inside the temp root, an explicit identity. A module-private
 * twin of `repo-mount-service.test.ts`'s helper of the same name, per this
 * package's test convention (test files never import from one another): the
 * discovery redirectors are stripped so a developer's ambient `GIT_DIR` cannot
 * make a fixture resolve somewhere else.
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
 * `cwd` is pinned INSIDE the fixture root: these fixtures are built while the
 * process working directory is the repository under development, and a git
 * invocation that discovered THAT repository would be a fixture bleeding into
 * the host.
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
  /** A directory BELOW `repositoryRoot`; attaching it must persist the root. */
  readonly nestedDirectory: string;
  /** The second real repository — the "multiple repo mounts" needs two. */
  readonly secondRepositoryRoot: string;
}

let fixtures: AcceptanceFixtures;

beforeAll(async () => {
  // Realpath the temp root ONCE: on macOS `os.tmpdir()` is `/var/folders/…`,
  // itself a symlink. The resolver canonicalizes, so an expectation built from
  // the un-resolved `mkdtemp` output would mismatch on every assertion.
  const fixtureRoot: string = await realpath(
    await mkdtemp(join(tmpdir(), "ai-sidekicks-repo-workspace-acceptance-")),
  );
  const environment = buildFixtureEnvironment(fixtureRoot);

  const repositoryRoot = join(fixtureRoot, "repo-alpha");
  // Two levels deep, and its parent is the subdirectory a bind names — one tree
  // serving the "resolve upward to the root" and "bind downward to a subpath"
  // halves keeps the fixture set honest about them being the same tree.
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

// ----------------------------------------------------------------------------
// Per-test harness
// ----------------------------------------------------------------------------

/**
 * The whole repo/workspace service stack over one database handle.
 *
 * Built by a factory rather than inline because durability arms REBUILD it
 * against the reopened handle: every service here holds prepared statements
 * bound to the handle it was constructed with, so a reopen without a rebuild
 * would be testing a closed database.
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
      signingKeySource: new FixedDaemonSigningKeySource(),
    }),
  });
  // No `newWorkspaceId` / `newRepoMountId` override: the production `mintUuidV7`
  // sources run, and every assertion below names ids by identity or set
  // membership rather than by position in a pool.
  const sessions = new SessionService(database, {
    allowUnsignedPlaceholderAppend: UnsignedPlaceholderAppendToken.forTestsOnly(),
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
  /** MUTABLE: the durability arms close this handle and reopen the same file. */
  db: DatabaseType;
  readonly dbPath: string;
  readonly tmpDir: string;
  /** MUTABLE for the same reason as `db` — see {@link DaemonStack}. */
  stack: DaemonStack;
  /** The shared clock both services were constructed with. */
  readonly now: () => string;
  /** A per-test directory an arm may git-init and DELETE to make a mount root vanish. */
  readonly disposableMountRoot: string;
  /** Stands in for the provisioned worktree root. */
  readonly provisionedWorktreeRoot: string;
  /** …and for the root of a second, different mode switch. */
  readonly boundRootCheckout: string;
}

let harness: TestHarness;

/**
 * A clock that advances one second per read, from a fixed epoch.
 *
 * Shared by BOTH services: they stamp different columns of the same lifecycle
 * (`repo_mounts.updated_at`, `workspaces.updated_at`), and two independent
 * clocks would make any cross-service ordering claim accidental.
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
  // The per-session append lock is a module singleton; a leftover queue entry
  // would stall the next case against the same session id and present as an
  // unrelated timeout.
  __resetSessionAppendLocksForTest();
  harness.db.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// Row / event readers — deliberately RAW SQL, not a service call
// ----------------------------------------------------------------------------
//
// Durability is a claim about what is on disk. Reading it back through the same
// service that wrote it would prove only that the service is self-consistent.

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
 * The session's event types WITHOUT the seeded `session.created` anchor.
 *
 * Dropped rather than restated in every arm: the anchor exists only because
 * `replay` refuses a chain that does not start with it, and repeating it would
 * bury the sequence each arm is actually about.
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

/** Run `body` and return whatever it rejected with, so an arm can assert on the carrier. */
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
  await harness.stack.workspaces.completeReprovision(bound.workspaceId, fsRoot);
  return String(bound.workspaceId);
}

// ----------------------------------------------------------------------------
// The shared setup
// ----------------------------------------------------------------------------

interface AttachedMounts {
  /** A git repository, entered through a nested subdirectory. */
  readonly alpha: RepoAttachResponse;
  /** A second, unrelated git repository. */
  readonly beta: RepoAttachResponse;
}

/**
 * Attach two real git repositories.
 *
 * The two canonical roots are distinct on purpose: `idx_repo_mounts_active_root`
 * is partial-unique over `(node_id, canonical_root)` for `attached` rows, so a
 * corpus that resolved both entries to the same root would be refused with
 * `repo.already_attached`.
 */
async function attachAcceptanceMounts(): Promise<AttachedMounts> {
  const alpha = await harness.stack.mounts.attach({ localPath: fixtures.nestedDirectory });
  const beta = await harness.stack.mounts.attach({ localPath: fixtures.secondRepositoryRoot });
  return { alpha, beta };
}

// ----------------------------------------------------------------------------
// A DURABLE mount with canonical-root metadata
// ----------------------------------------------------------------------------

describe("attaching yields a durable repo mount with canonical-root metadata", () => {
  it("keeps both mounts across an openDatabase reopen", async () => {
    const attached = await attachAcceptanceMounts();

    // The RESOLVED root, not the entered path — only observable when the two
    // differ, which is why alpha is entered through a nested subdirectory.
    expect(attached.alpha.canonicalRoot).toBe(fixtures.repositoryRoot);
    expect(attached.alpha.canonicalRoot).not.toBe(fixtures.nestedDirectory);
    expect(attached.beta.canonicalRoot).toBe(fixtures.secondRepositoryRoot);
    expect(attached.alpha.repoMountId).not.toBe(attached.beta.repoMountId);

    // THE DURABILITY LEG: close the handle and reopen the same FILE. An
    // in-memory row, or one left in an uncommitted transaction, does not
    // survive this. The stack built in `beforeEach` holds statements against
    // the closed handle and is not used again in this arm — the assertions
    // below all read raw SQL through the reopened handle.
    harness.db.close();
    harness.db = openDatabase(harness.dbPath);

    expect(countRows("repo_mounts")).toBe(2);
    // An attach creates no workspace: a mount belongs to the machine, and a
    // session binds workspaces on it explicitly.
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
      // PROVENANCE survives alongside resolved identity.
      expect(mount.local_path).toBe(expected.enteredPath);
      expect(mount.node_id).toBe(NODE_ID);
      expect(mount.vcs_type).toBe("git");
      expect(mount.state).toBe("attached");
      expect(Date.parse(mount.attached_at)).not.toBeNaN();
    }

    // The alpha mount is the one that proves provenance and identity DIFFER.
    const alphaMount = requireMountRow(attached.alpha.repoMountId);
    expect(alphaMount.local_path).not.toBe(alphaMount.canonical_root);

    // No session's log carries an attach.
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
    // Health is DERIVED per read, so a restarted daemon re-measures rather
    // than trusting a persisted verdict — there is no column to trust.
    expect(alphaRead.health.status).toBe("healthy");

    // Reads are not transitions (the negative half).
    expect(readLifecycleEventTypes()).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// One session binds workspaces across multiple repo mounts
// ----------------------------------------------------------------------------

describe("one session binds workspaces across multiple repo mounts", () => {
  it("lists every workspace across every mount with its state", async () => {
    const attached = await attachAcceptanceMounts();

    const rootWorkspace = await harness.stack.workspaces.bind({
      sessionId: SESSION_ID,
      repoMountId: attached.alpha.repoMountId,
      executionMode: "bound-root",
    });
    // A second workspace on alpha, naming a SUBDIRECTORY of the mount.
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

    // Every bind lands `provisioning` with no execution root yet: the
    // provisioner supplies the root that ends the cycle.
    for (const bound of [rootWorkspace, subdirectoryWorkspace, betaWorkspace]) {
      expect(bound.state).toBe("provisioning");
      expect(requireWorkspaceRow(bound.workspaceId).fs_root).toBeNull();
    }

    const listed = await harness.stack.workspaces.list({ sessionId: SESSION_ID });

    // REPRESENTABLE on the wire, not merely well-typed in-process: the listing
    // is what a client sees, and a projection the response schema refuses would
    // fail at the IPC seam instead of here.
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
        [String(rootWorkspace.workspaceId), ["bound-root", "provisioning"]],
        [String(subdirectoryWorkspace.workspaceId), ["provisioned-worktree", "provisioning"]],
        [String(betaWorkspace.workspaceId), ["provisioned-worktree", "provisioning"]],
      ]),
    );

    // The listing spans BOTH mounts — the "multiple repo mounts" half of the
    // claim, which a per-mount listing would satisfy vacuously.
    expect(new Set(listed.workspaces.map((workspace) => String(workspace.repoMountId)))).toEqual(
      new Set([String(attached.alpha.repoMountId), String(attached.beta.repoMountId)]),
    );

    // …and it is still SCOPED: one mount's slice, and a session that bound
    // nothing sees nothing.
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

// ----------------------------------------------------------------------------
// One durable event per real transition, across the FULL lifecycle
// ----------------------------------------------------------------------------

describe("the full-lifecycle event sequence", () => {
  it("emits exactly one event per transition, and one archival per dependent", async () => {
    const alpha = await harness.stack.mounts.attach({ localPath: fixtures.nestedDirectory });
    // A SECOND mount, untouched by everything below: the detach cascade is
    // scoped to one mount, and a cascade that archived the session's whole
    // roster would pass a single-mount arm.
    const beta = await harness.stack.mounts.attach({ localPath: fixtures.secondRepositoryRoot });

    // The provisioning cycle on alpha's first workspace: provisioning -> ready.
    const alphaWorkspace = await harness.stack.workspaces.bind({
      sessionId: SESSION_ID,
      repoMountId: alpha.repoMountId,
      executionMode: "provisioned-worktree",
    });
    expect(requireWorkspaceRow(alphaWorkspace.workspaceId).state).toBe("provisioning");
    await harness.stack.workspaces.completeReprovision(
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

    // The provisioned root vanishes — a real deletion, not a mocked verdict —
    // and the next read derives AND persists the stale transition.
    rmSync(harness.provisionedWorktreeRoot, { recursive: true, force: true });
    const afterLoss = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(
      new Map(afterLoss.workspaces.map((workspace) => [String(workspace.id), workspace.state])),
    ).toEqual(
      new Map([
        [String(alphaWorkspace.workspaceId), "stale"],
        [String(subdirectoryWorkspace.workspaceId), "provisioning"],
        [String(betaWorkspace.workspaceId), "provisioning"],
      ]),
    );

    // A SECOND read of the same state is not a second transition.
    const eventsBeforeSecondRead = readLifecycleEventTypes();
    await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(readLifecycleEventTypes()).toEqual(eventsBeforeSecondRead);

    const mountBeforeDetach = requireMountRow(alpha.repoMountId);
    const detached = await harness.stack.mounts.detach({ repoMountId: alpha.repoMountId });
    expect(detached.state).toBe("detached");
    expect([...detached.archivedWorkspaceIds].sort()).toEqual(
      [String(alphaWorkspace.workspaceId), String(subdirectoryWorkspace.workspaceId)].sort(),
    );

    // Detach keeps the durable RECORD. `updated_at` is the lifecycle-mutation
    // timestamp: the flip moves it forward and leaves `attached_at` alone,
    // because the two answer different questions ("when did this mount come
    // into being" versus "when did it last move"). This is the pair the shared
    // stepping clock exists for — at wall-clock millisecond resolution the two
    // stamps would tie on a fast machine and the arm would fail for a reason
    // that has nothing to do with the code.
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

    // The mount itself announces nothing; each archival follows the commit
    // that made it true.
    expect(readLifecycleEventTypes()).toEqual([
      "workspace.provisioning",
      "workspace.ready",
      "workspace.provisioning",
      "workspace.provisioning",
      "workspace.stale",
      "workspace.archived",
      "workspace.archived",
    ]);

    // Each cascaded archival names its workspace AND its mount, once.
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
    expect(requireWorkspaceRow(betaWorkspace.workspaceId).state).toBe("provisioning");
    expect(requireWorkspaceRow(alphaWorkspace.workspaceId).state).toBe("archived");
    expect(requireWorkspaceRow(subdirectoryWorkspace.workspaceId).state).toBe("archived");
  });
});

// ----------------------------------------------------------------------------
// The workspace id is stable across mode switches
// ----------------------------------------------------------------------------

describe("a mode switch reprovisions IN PLACE", () => {
  it("keeps the id and the row through two full cycles, updating mode and root", async () => {
    const alpha = await harness.stack.mounts.attach({ localPath: fixtures.repositoryRoot });
    const workspaceId = await bindReadyWorkspace(alpha.repoMountId, fixtures.repositoryRoot);
    const beforeCycles = requireWorkspaceRow(workspaceId);
    expect(beforeCycles.execution_mode).toBe("bound-root");
    expect(beforeCycles.fs_root).toBe(fixtures.repositoryRoot);
    expect(countRows("workspaces")).toBe(1);

    await harness.stack.workspaces.beginReprovision(workspaceId, "provisioned-worktree");
    const midCycle = requireWorkspaceRow(workspaceId);
    expect(midCycle.state).toBe("provisioning");
    expect(midCycle.execution_mode).toBe("provisioned-worktree");
    // The old root is dropped the moment the switch begins: a `provisioning`
    // row still advertising the previous execution root would hand a run a
    // path the new mode does not use.
    expect(midCycle.fs_root).toBeNull();

    await harness.stack.workspaces.completeReprovision(
      workspaceId,
      harness.provisionedWorktreeRoot,
    );

    // A SECOND switch, to a different mode and a different root — one cycle
    // would not distinguish "the id is stable" from "the id is stable once".
    await harness.stack.workspaces.beginReprovision(workspaceId, "bound-root");
    await harness.stack.workspaces.completeReprovision(workspaceId, harness.boundRootCheckout);

    const afterCycles = requireWorkspaceRow(workspaceId);
    expect(afterCycles.id).toBe(workspaceId);
    expect(afterCycles.repo_mount_id).toBe(String(alpha.repoMountId));
    expect(afterCycles.state).toBe("ready");
    expect(afterCycles.execution_mode).toBe("bound-root");
    expect(afterCycles.fs_root).toBe(harness.boundRootCheckout);
    // NO row was created or destroyed on the way — the id would also look
    // "stable" if the service had inserted a second row and left the first.
    expect(countRows("workspaces")).toBe(1);

    const listed = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(listed.workspaces).toHaveLength(1);
    expect(String(listed.workspaces[0]?.id)).toBe(workspaceId);
    expect(listed.workspaces[0]?.executionMode).toBe("bound-root");
    expect(listed.workspaces[0]?.fsRoot).toBe(harness.boundRootCheckout);

    // One event per transition: the first provisioning, then both cycles.
    expect(readLifecycleEventTypes()).toEqual([
      "workspace.provisioning",
      "workspace.ready",
      "workspace.provisioning",
      "workspace.ready",
      "workspace.provisioning",
      "workspace.ready",
    ]);
  });
});

// ----------------------------------------------------------------------------
// An unavailable root is `stale` on every read surface, and the write gate
// refuses it
// ----------------------------------------------------------------------------

describe("a root that vanishes makes its workspace stale", () => {
  it("persists the transition, refuses writes, and never auto-heals", async () => {
    // The healthy SIBLING: a workspace on a fixture root that stays put.
    // Without it, "the write gate refuses" could not be told from "the write
    // gate refuses everything".
    const sibling = await harness.stack.mounts.attach({ localPath: fixtures.repositoryRoot });
    const siblingWorkspaceId = await bindReadyWorkspace(
      sibling.repoMountId,
      fixtures.repositoryRoot,
    );
    // The VICTIM: a mount rooted at a directory this arm owns and deletes. Its
    // workspace is the only one rooted there, so the stale count below is
    // unambiguous.
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
    // PERSISTED, not merely reported: the claim is about the row, so the next
    // reader sees it without re-probing.
    expect(requireWorkspaceRow(victimWorkspaceId).state).toBe("stale");

    // The mount read reports the same loss, and does NOT confuse it with a
    // lifecycle change — the row is still `attached`.
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

    // The directory comes BACK. Mount health recovers, because it is derived
    // per read; the workspace does NOT, because repair is a decision, not an
    // observation — a run resumed against a re-created empty directory is the
    // silent-data-loss case this rule exists to prevent.
    mkdirSync(harness.disposableMountRoot, { recursive: true });
    const listedAfterRepair = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(
      listedAfterRepair.workspaces.find((workspace) => String(workspace.id) === victimWorkspaceId)
        ?.state,
    ).toBe("stale");
    expect((await harness.stack.mounts.read(victim.repoMountId)).health.status).toBe("healthy");

    // ONE `workspace.stale`, across three read surfaces and two probes.
    expect(readLifecycleEventTypes()).toEqual([
      "workspace.provisioning",
      "workspace.ready",
      "workspace.provisioning",
      "workspace.ready",
      "workspace.stale",
    ]);

    // The run hold is a state change with NO registered event type, so the
    // closed six-type registry stays closed: `ready -> busy -> ready` moves
    // the row and appends nothing.
    const eventsBeforeHold = readLifecycleEventTypes();
    await harness.stack.workspaces.markBusy(siblingWorkspaceId, RUN_ID);
    expect(requireWorkspaceRow(siblingWorkspaceId).state).toBe("busy");
    expect(harness.stack.workspaces.releaseBusy(siblingWorkspaceId)).toBe(true);
    expect(requireWorkspaceRow(siblingWorkspaceId).state).toBe("ready");
    expect(readLifecycleEventTypes()).toEqual(eventsBeforeHold);
  });
});
