// Plan-009 Phase 2 acceptance suite — T2.6.
//
// The AC-mapped integration walk over the WHOLE shipped Phase-2 surface: the
// `0010-repo-workspaces` migration (T2.1), the event emitter (T2.2),
// `RepoMountService` (T2.3), `WorkspaceService` (T2.4) and the health /
// capability projector (T2.5) — driven end to end against a real temp-FILE
// SQLite database opened by the canonical `openDatabase` factory (pragma and
// migration order are never re-derived in a test), a real `EventLogService`
// append path, and REAL git repositories built on disk with `execFile`.
//
// This is deliberately NOT a second copy of the per-module suites. Those prove
// each module's branches; this file proves the claims the SPEC MAKES TO A USER,
// and proves them the only way an acceptance test can — through the public
// entry points, over durable state, with nothing mocked that the claim depends
// on. Every seam the sibling suites inject to reach a branch (resolvers,
// filesystem probes, id sources, interfering signing keys, failing emitters) is
// left at its production default here. Beyond the two this package's harnesses
// all share — a fixed daemon signing key, and the seeded `session.created`
// anchor `replay` requires of every chain — two mechanisms are test-only:
//
//   * REAL git fixtures, built once in `beforeAll` under a hermetic
//     environment. AC1 is a claim about a CANONICAL ROOT; a stubbed resolver
//     would let every root assertion below pass against a value this file
//     invented.
//   * ONE stepping clock, shared by both services so their `updated_at` stamps
//     come from a single sequence. `toISOString` is millisecond-resolution, so
//     the `updated_at` comparisons would otherwise tie and fail on machine
//     speed. No assertion here reads a stamp VALUE — only relations between
//     stamps this code wrote.
//
// Spec coverage:
//   • `Spec-009 §Acceptance Criteria` AC1 — "Attaching a repository yields a
//     durable repo mount with canonical root metadata": the durability arms
//     close the handle and reopen the same FILE before reading anything.
//   • `Spec-009 §Acceptance Criteria` AC2 — "A session can contain multiple
//     repo mounts and multiple bound workspaces" (the automated multi-mount
//     leg), with `Spec-009 §Required Behavior` — "The system must support
//     multiple repo mounts in one session."
//   • `Spec-009 §Acceptance Criteria` AC3 — "Non-git directory workspaces
//     remain usable without pretending to support git-only features": the
//     plain-directory mount keeps `read-only` AND is refused the three
//     git-backed modes by reason, never by silent substitution.
//   • `Spec-009 §Fallback Behavior` — an execution root that becomes
//     unavailable makes the workspace `stale` and blocks new write runs.
//   • `Spec-009 §Execution Mode Transitions` — the in-place reprovision cycle.
//   • `Spec-009 §Detach Semantics (V1 Definition)` — the archive cascade and
//     the durable-event sequence it produces.
//
// Verifies invariant (integration): I-009-5 (a stored mount carries resolved
// identity AND provenance, and both survive a reopen), I-009-6 (the workspace
// id is stable across mode switches — the row is updated in place, never
// recreated), I-009-7 (an unavailable root is observable as `stale` on every
// read surface and the write gate refuses it), I-009-8 (capability projection
// never silently substitutes a mode), I-009-9 (exactly one durable event per
// real transition, and none for a non-transition).
//
// Why no arm here can pass vacuously:
//   * The event-sequence arms assert the ORDERED type list, not membership, so
//     an extra, missing or reordered event fails. The detach leg additionally
//     asserts the INDEX relation `repo.detached` < first `workspace.archived`,
//     which is the specific ordering the 2026-08-05 `Plan-009 §Notes` repair
//     settled: the mount event carries the prelude that wrote every cascade
//     row, and an archive announcement may only follow the commit that made it
//     true.
//   * The stale arms delete a REAL directory, so "reports stale" is
//     distinguishable from "was already stale"; the I-009-7 arm additionally
//     re-creates it, so "never heals" is separable from "the daemon cannot see
//     the repair" — mount health recovers while the workspace stays stale.
//   * The AC3 arm asserts the mode partition over a LOCAL roster of the
//     taxonomy pinned exhaustive at compile time, so a fifth mode added to
//     contracts cannot leave the partition passing over a stale list.
//   * The non-transition arms (a second `list`, a second `detach`, a
//     busy/release pair) assert the event log is UNCHANGED, which is the only
//     way I-009-9's negative half is observable at all.

import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  ExecutionMode,
  NodeId,
  RepoAttachResponse,
  SessionId,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";
import { WorkspaceListResponseSchema } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService, UnsignedPlaceholderAppendToken } from "../../session/session-service.js";
import { RepoMountService } from "../repo-mount-service.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import { computeExecutionModeCapabilities } from "../workspace-projector.js";
import {
  WorkspaceModeUnsupportedError,
  WorkspaceService,
  WorkspaceStaleError,
} from "../workspace-service.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "0190fa10-0000-7000-8000-000000000001" as SessionId;
// A second session that attaches nothing — the isolation control for AC2's
// "a session can contain" claim, which is meaningless if `list` is not scoped.
const OTHER_SESSION_ID: SessionId = "0190fa10-0000-7000-8000-000000000002" as SessionId;
const NODE_ID: NodeId = "node-local" as NodeId;

const PARTICIPANT_ACTOR: string = "0190fa14-0000-7000-8000-000000000001";
const RUN_ID: string = "0190fa16-0000-7000-8000-000000000001";

/**
 * The mount-root-relative subdirectory AC2's second workspace binds.
 *
 * A SUBDIRECTORY rather than the mount root: two workspaces on one mount are
 * only distinguishable in the listing if they differ in something, and the
 * execution root is the thing a caller chose.
 */
const BOUND_SUBDIRECTORY: string = "packages";

/**
 * The canonical execution-mode taxonomy in `ADR-006 §Decision` order.
 *
 * Contracts exports the union but no ordered roster, so this file declares its
 * own — with the same pair of checks the projector applies to its own array:
 * `satisfies` proves every element is a real mode, and the `_AssertExtends` pin
 * below proves every mode is an element. Without the pin, a fifth mode added to
 * contracts would leave the AC3 partition assertion passing VACUOUSLY over a
 * stale list, which is exactly the drift I-009-8 exists to catch.
 */
const ALL_EXECUTION_MODES = [
  "read-only",
  "branch",
  "worktree",
  "ephemeral clone",
] as const satisfies readonly ExecutionMode[];

// The `_` prefix is what the root eslint config's `varsIgnorePattern` exempts
// from `no-unused-vars`; the alias exists to be type-checked, not read.
type _AssertExtends<A extends B, B> = A;
type _AssertExecutionModeRosterIsComplete = _AssertExtends<
  ExecutionMode,
  (typeof ALL_EXECUTION_MODES)[number]
>;

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
  readonly session_id: string;
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
  readonly session_id: string;
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
  /** A real git repository root — what `rev-parse --show-toplevel` reports. */
  readonly repositoryRoot: string;
  /** A directory BELOW `repositoryRoot`; attaching it must persist the root. */
  readonly nestedDirectory: string;
  /** The second real repository — AC2's "multiple repo mounts" needs two. */
  readonly secondRepositoryRoot: string;
  /** Not a repository at all: AC3's subject, `vcs_type 'none'`. */
  readonly plainDirectory: string;
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
  // Two levels deep, and its parent is the subdirectory AC2 binds — one tree
  // serving the "resolve upward to the root" and "bind downward to a subpath"
  // halves keeps the fixture set honest about them being the same tree.
  const nestedDirectory = join(repositoryRoot, BOUND_SUBDIRECTORY, "daemon");
  const secondRepositoryRoot = join(fixtureRoot, "repo-beta");
  const plainDirectory = join(fixtureRoot, "plain-directory");
  for (const directory of [nestedDirectory, plainDirectory]) {
    mkdirSync(directory, { recursive: true });
  }

  await runFixtureGit(["init", "-q", repositoryRoot], environment, fixtureRoot);
  await runFixtureGit(["init", "-q", secondRepositoryRoot], environment, fixtureRoot);

  fixtures = {
    fixtureRoot,
    repositoryRoot,
    nestedDirectory,
    secondRepositoryRoot,
    plainDirectory,
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
 * The whole Phase-2 service stack over one database handle.
 *
 * Built by a factory rather than inline because the AC1 durability arms REBUILD
 * it against the reopened handle: every service here holds prepared statements
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
  // No `newWorkspaceId` / `newRepoMountId` override: the production `randomUUID`
  // sources run, and every assertion below names ids by identity or set
  // membership rather than by position in a pool.
  const workspaces = new WorkspaceService({ database, events: emitter, now });
  const sessions = new SessionService(database, {
    allowUnsignedPlaceholderAppend: UnsignedPlaceholderAppendToken.forTestsOnly(),
  });
  return {
    emitter,
    workspaces,
    sessions,
    mounts: new RepoMountService({ database, events: emitter, workspaces, sessions, now }),
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
  /** A per-test directory an arm may DELETE to make a mount root vanish. */
  readonly disposableMountRoot: string;
  /** Stands in for Plan-010's provisioned worktree root. */
  readonly provisionedWorktreeRoot: string;
  /** …and for the root of a second, different mode switch. */
  readonly provisionedBranchRoot: string;
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
  const provisionedBranchRoot = join(tmpDir, "provisioned-branch-checkout");
  for (const directory of [disposableMountRoot, provisionedWorktreeRoot, provisionedBranchRoot]) {
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
    provisionedBranchRoot,
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
      `SELECT id, session_id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at
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
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state
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

/** The restricted modes of a projection, read WITHOUT casting a key back. */
function restrictedModesOf(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
): ExecutionMode[] {
  return ALL_EXECUTION_MODES.filter((mode) => capabilities.restrictions?.[mode] !== undefined);
}

// ----------------------------------------------------------------------------
// The shared setup: the exact corpus AC1 and AC2 describe
// ----------------------------------------------------------------------------

interface AttachedMounts {
  /** A git repository, entered through a nested subdirectory (I-009-5). */
  readonly alpha: RepoAttachResponse;
  /** A second, unrelated git repository. */
  readonly beta: RepoAttachResponse;
  /** A plain directory — AC3's subject, and D-009-4's single funnel. */
  readonly plain: RepoAttachResponse;
}

/**
 * Attach two real git repositories and one plain directory to ONE session.
 *
 * The three canonical roots are distinct on purpose: `idx_repo_mounts_active_root`
 * is partial-unique over `(session_id, node_id, canonical_root)` for `attached`
 * rows, so a corpus that resolved two entries to the same root would be refused
 * with `repo.already_attached` rather than exercising AC2.
 */
async function attachAcceptanceMounts(): Promise<AttachedMounts> {
  const alpha = await harness.stack.mounts.attach({
    sessionId: SESSION_ID,
    localPath: fixtures.nestedDirectory,
    nodeId: NODE_ID,
  });
  const beta = await harness.stack.mounts.attach({
    sessionId: SESSION_ID,
    localPath: fixtures.secondRepositoryRoot,
    nodeId: NODE_ID,
  });
  const plain = await harness.stack.mounts.attach({
    sessionId: SESSION_ID,
    localPath: fixtures.plainDirectory,
    nodeId: NODE_ID,
  });
  return { alpha, beta, plain };
}

/** The six events three attaches must have produced, and nothing else. */
const THREE_ATTACH_EVENT_SEQUENCE: readonly string[] = [
  "repo.attached",
  "workspace.ready",
  "repo.attached",
  "workspace.ready",
  "repo.attached",
  "workspace.ready",
];

// ----------------------------------------------------------------------------
// AC1 — `Spec-009 §Acceptance Criteria`: a DURABLE mount with canonical-root
// metadata (I-009-5)
// ----------------------------------------------------------------------------

describe("AC1 — attaching yields a durable repo mount with canonical-root metadata", () => {
  it("keeps all three mounts and their default workspaces across an openDatabase reopen", async () => {
    const attached = await attachAcceptanceMounts();

    // The RESOLVED root, not the entered path — the half of I-009-5 that is
    // only observable when the two differ, which is why alpha is entered
    // through a nested subdirectory.
    expect(attached.alpha.canonicalRoot).toBe(fixtures.repositoryRoot);
    expect(attached.alpha.canonicalRoot).not.toBe(fixtures.nestedDirectory);
    expect(attached.beta.canonicalRoot).toBe(fixtures.secondRepositoryRoot);
    expect(attached.plain.canonicalRoot).toBe(fixtures.plainDirectory);
    const distinctMountIds = new Set([
      attached.alpha.repoMountId,
      attached.beta.repoMountId,
      attached.plain.repoMountId,
    ]);
    expect(distinctMountIds.size).toBe(3);

    // THE DURABILITY LEG: close the handle and reopen the same FILE. An
    // in-memory row, or one left in an uncommitted transaction, does not
    // survive this. The stack built in `beforeEach` holds statements against
    // the closed handle and is not used again in this arm — the assertions
    // below all read raw SQL through the reopened handle.
    harness.db.close();
    harness.db = openDatabase(harness.dbPath);

    expect(countRows("repo_mounts")).toBe(3);
    expect(countRows("workspaces")).toBe(3);

    const expectedMounts: ReadonlyArray<{
      readonly attachResponse: RepoAttachResponse;
      readonly enteredPath: string;
      readonly canonicalRoot: string;
      readonly vcsType: string;
    }> = [
      {
        attachResponse: attached.alpha,
        enteredPath: fixtures.nestedDirectory,
        canonicalRoot: fixtures.repositoryRoot,
        vcsType: "git",
      },
      {
        attachResponse: attached.beta,
        enteredPath: fixtures.secondRepositoryRoot,
        canonicalRoot: fixtures.secondRepositoryRoot,
        vcsType: "git",
      },
      {
        attachResponse: attached.plain,
        enteredPath: fixtures.plainDirectory,
        canonicalRoot: fixtures.plainDirectory,
        vcsType: "none",
      },
    ];

    for (const expected of expectedMounts) {
      const mount = requireMountRow(expected.attachResponse.repoMountId);
      expect(mount.canonical_root).toBe(expected.canonicalRoot);
      // PROVENANCE survives alongside resolved identity — I-009-5 keeps both.
      expect(mount.local_path).toBe(expected.enteredPath);
      expect(mount.session_id).toBe(SESSION_ID);
      expect(mount.node_id).toBe(NODE_ID);
      expect(mount.vcs_type).toBe(expected.vcsType);
      expect(mount.state).toBe("attached");
      expect(Date.parse(mount.attached_at)).not.toBeNaN();

      // The default workspace D-009-7 requires of EVERY mount, git or not, is
      // durable too — a mount whose workspace vanished on restart would satisfy
      // the letter of AC1 and none of its use.
      const workspace = requireWorkspaceRow(expected.attachResponse.defaultWorkspaceId);
      expect(workspace.repo_mount_id).toBe(expected.attachResponse.repoMountId);
      expect(workspace.session_id).toBe(SESSION_ID);
      expect(workspace.execution_mode).toBe("read-only");
      expect(workspace.state).toBe("ready");
      // Rooted at the mount's CANONICAL root, never the entered subdirectory.
      expect(workspace.fs_root).toBe(expected.canonicalRoot);
    }

    // The alpha mount is the one that proves provenance and identity DIFFER.
    const alphaMount = requireMountRow(attached.alpha.repoMountId);
    expect(alphaMount.local_path).not.toBe(alphaMount.canonical_root);

    // The timeline survived the reopen with the rows (I-009-9): three attaches,
    // three default workspaces, nothing else.
    expect(readLifecycleEventTypes()).toEqual(THREE_ATTACH_EVENT_SEQUENCE);
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
    // Health is DERIVED per read (D-009-2), so a restarted daemon re-measures
    // rather than trusting a persisted verdict — there is no column to trust.
    expect(alphaRead.health.status).toBe("healthy");

    const listed = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(listed.workspaces).toHaveLength(3);
    expect(new Set(listed.workspaces.map((workspace) => workspace.state))).toEqual(
      new Set(["ready"]),
    );

    // Reads are not transitions: the reopened log holds exactly what the three
    // attaches wrote (I-009-9's negative half).
    expect(readLifecycleEventTypes()).toEqual(THREE_ATTACH_EVENT_SEQUENCE);
  });
});

// ----------------------------------------------------------------------------
// AC2 — `Spec-009 §Acceptance Criteria` + `Spec-009 §Required Behavior`:
// multiple mounts and multiple bound workspaces in one session
// ----------------------------------------------------------------------------

describe("AC2 — one session holds multiple repo mounts and multiple bound workspaces", () => {
  it("lists every workspace across every mount with its state", async () => {
    const attached = await attachAcceptanceMounts();

    // A second workspace on alpha, rooted at a SUBDIRECTORY of the mount.
    const subdirectoryWorkspace = await harness.stack.workspaces.bind({
      repoMountId: attached.alpha.repoMountId,
      executionMode: "read-only",
      directory: BOUND_SUBDIRECTORY,
    });
    // A WRITABLE bind on beta: `provisioning` with no execution root yet —
    // `Spec-009 §Execution Mode Transitions` cycles a writable mode through
    // `provisioning`, and Plan-010 supplies the root that ends the cycle. The
    // read-only bind above needs no cycle, which is why the two land in
    // different states from the same call.
    const writableWorkspace = await harness.stack.workspaces.bind({
      repoMountId: attached.beta.repoMountId,
      executionMode: "worktree",
    });

    expect(subdirectoryWorkspace.state).toBe("ready");
    expect(subdirectoryWorkspace.fsRoot).toBe(join(fixtures.repositoryRoot, BOUND_SUBDIRECTORY));
    expect(writableWorkspace.state).toBe("provisioning");
    expect(writableWorkspace.fsRoot).toBeUndefined();
    expect(requireWorkspaceRow(writableWorkspace.workspaceId).fs_root).toBeNull();

    const listed = await harness.stack.workspaces.list({ sessionId: SESSION_ID });

    // REPRESENTABLE on the wire, not merely well-typed in-process: the listing
    // is what a client sees, and a projection the response schema refuses would
    // fail at the IPC seam in Phase 3 instead of here.
    expect(WorkspaceListResponseSchema.parse(listed)).toEqual(listed);

    expect(
      new Map(listed.workspaces.map((workspace) => [String(workspace.id), workspace.state])),
    ).toEqual(
      new Map([
        [String(attached.alpha.defaultWorkspaceId), "ready"],
        [String(attached.beta.defaultWorkspaceId), "ready"],
        [String(attached.plain.defaultWorkspaceId), "ready"],
        [String(subdirectoryWorkspace.workspaceId), "ready"],
        [String(writableWorkspace.workspaceId), "provisioning"],
      ]),
    );

    // The listing spans ALL THREE mounts — the "multiple repo mounts" half of
    // the criterion, which a per-mount listing would satisfy vacuously.
    expect(new Set(listed.workspaces.map((workspace) => String(workspace.repoMountId)))).toEqual(
      new Set([
        String(attached.alpha.repoMountId),
        String(attached.beta.repoMountId),
        String(attached.plain.repoMountId),
      ]),
    );

    // …and it is still SCOPED: one mount's slice, and a session that attached
    // nothing sees nothing.
    const alphaOnly = await harness.stack.workspaces.list({
      sessionId: SESSION_ID,
      repoMountId: attached.alpha.repoMountId,
    });
    expect(new Set(alphaOnly.workspaces.map((workspace) => String(workspace.id)))).toEqual(
      new Set([
        String(attached.alpha.defaultWorkspaceId),
        String(subdirectoryWorkspace.workspaceId),
      ]),
    );

    const otherSession = await harness.stack.workspaces.list({ sessionId: OTHER_SESSION_ID });
    expect(otherSession.workspaces).toEqual([]);
    expect(readLifecycleEventTypes(OTHER_SESSION_ID)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// AC3 — `Spec-009 §Acceptance Criteria`: a non-git directory stays usable
// without pretending to support git-only features (I-009-8)
// ----------------------------------------------------------------------------

describe("AC3 — the plain-directory mount is usable, with git-only modes refused by reason", () => {
  it("projects a reduced capability surface from the PERSISTED vcs_type", async () => {
    const attached = await attachAcceptanceMounts();

    // Through the read surface, so the capability answer is derived from what
    // the daemon stored at attach time rather than from a literal this test
    // chose (I-009-4 is the input to I-009-8).
    const plainMount = await harness.stack.mounts.read(attached.plain.repoMountId);
    const gitMount = await harness.stack.mounts.read(attached.alpha.repoMountId);
    expect(plainMount.vcsType).toBe("none");
    expect(gitMount.vcsType).toBe("git");

    const plainCapabilities = computeExecutionModeCapabilities({ vcsType: plainMount.vcsType });
    const gitCapabilities = computeExecutionModeCapabilities({ vcsType: gitMount.vcsType });

    // The criterion's two halves, as literals — "usable" and "not pretending".
    expect(plainCapabilities.availableModes).toEqual(["read-only"]);
    expect(plainCapabilities.defaultMode).toBe("read-only");
    expect(restrictedModesOf(plainCapabilities)).toEqual(["branch", "worktree", "ephemeral clone"]);
    for (const mode of restrictedModesOf(plainCapabilities)) {
      // T2.5's suite pins each reason non-blank, distinct, and within the
      // ratified length cap; what this file requires is that a reason exists
      // for every refusal — the difference between an explicit gap and a
      // silent omission.
      expect((plainCapabilities.restrictions?.[mode] ?? "").length).toBeGreaterThan(0);
    }

    expect(gitCapabilities.availableModes).toEqual([...ALL_EXECUTION_MODES]);
    expect(gitCapabilities.defaultMode).toBe("worktree");
    expect(gitCapabilities.restrictions).toBeUndefined();

    // I-009-8 as a PARTITION over the whole taxonomy: every mode is available
    // or restricted-with-a-reason, never neither (a silent omission) and never
    // both (an incoherent answer).
    for (const capabilities of [plainCapabilities, gitCapabilities]) {
      for (const mode of ALL_EXECUTION_MODES) {
        const isAvailable = capabilities.availableModes.includes(mode);
        const isRestricted = capabilities.restrictions?.[mode] !== undefined;
        expect(isAvailable).not.toBe(isRestricted);
      }
    }

    // USABLE, not merely describable: the plain mount got the same default
    // workspace a repository did (D-009-4's single funnel), ready to read.
    const defaultWorkspace = requireWorkspaceRow(attached.plain.defaultWorkspaceId);
    expect(defaultWorkspace.execution_mode).toBe("read-only");
    expect(defaultWorkspace.state).toBe("ready");
    expect(defaultWorkspace.fs_root).toBe(fixtures.plainDirectory);
  });

  it("refuses a git-only bind BY NAME, writes nothing, and still binds read-only", async () => {
    const attached = await attachAcceptanceMounts();
    const workspacesBeforeRefusal = countRows("workspaces");
    const eventsBeforeRefusal = readLifecycleEventTypes();

    const error = await captureRejection(() =>
      harness.stack.workspaces.bind({
        repoMountId: attached.plain.repoMountId,
        executionMode: "worktree",
      }),
    );

    expect(error).toBeInstanceOf(WorkspaceModeUnsupportedError);
    const refusal = error as WorkspaceModeUnsupportedError;
    expect(refusal.code).toBe("workspace.mode_unsupported");
    expect(refusal.executionMode).toBe("worktree");
    // The refusal AGREES with the capability read — the same matrix answers
    // both, so a caller cannot be told two different stories about one mount.
    const capabilities = computeExecutionModeCapabilities({ vcsType: "none" });
    expect(refusal.availableModes).toEqual(capabilities.availableModes);
    expect(refusal.detail?.["reason"]).toBe(capabilities.restrictions?.worktree);

    // NO SILENT SUBSTITUTION: no workspace was created in some other mode, and
    // nothing was announced. A `read-only` row written here would still satisfy
    // every state assertion in the sibling suites.
    expect(countRows("workspaces")).toBe(workspacesBeforeRefusal);
    expect(readLifecycleEventTypes()).toEqual(eventsBeforeRefusal);

    // …and the mount stays usable in the mode it DOES offer.
    const bound = await harness.stack.workspaces.bind({
      repoMountId: attached.plain.repoMountId,
      executionMode: "read-only",
    });
    expect(bound.executionMode).toBe("read-only");
    expect(bound.state).toBe("ready");
    expect(bound.fsRoot).toBe(fixtures.plainDirectory);
    expect(countRows("workspaces")).toBe(workspacesBeforeRefusal + 1);
  });
});

// ----------------------------------------------------------------------------
// I-009-9 — one durable event per real transition, across the FULL lifecycle
// (`Spec-009 §Detach Semantics (V1 Definition)`)
// ----------------------------------------------------------------------------

describe("I-009-9 — the full-lifecycle event sequence", () => {
  it("emits exactly one event per transition, mount event first on detach", async () => {
    const alpha = await harness.stack.mounts.attach({
      sessionId: SESSION_ID,
      localPath: fixtures.nestedDirectory,
      nodeId: NODE_ID,
      actor: PARTICIPANT_ACTOR,
    });
    // A SECOND mount, untouched by everything below: the detach cascade is
    // scoped to one mount, and a cascade that archived the session's whole
    // roster would pass a single-mount arm.
    const beta = await harness.stack.mounts.attach({
      sessionId: SESSION_ID,
      localPath: fixtures.secondRepositoryRoot,
      nodeId: NODE_ID,
    });
    const subdirectoryWorkspace = await harness.stack.workspaces.bind({
      repoMountId: alpha.repoMountId,
      executionMode: "read-only",
      directory: BOUND_SUBDIRECTORY,
    });

    // The reprovision cycle (CP-009-2 / `Spec-009 §Execution Mode Transitions`)
    // on alpha's default workspace: ready -> provisioning -> ready.
    await harness.stack.workspaces.beginReprovision(alpha.defaultWorkspaceId, "worktree");
    expect(requireWorkspaceRow(alpha.defaultWorkspaceId).state).toBe("provisioning");
    await harness.stack.workspaces.completeReprovision(
      alpha.defaultWorkspaceId,
      harness.provisionedWorktreeRoot,
    );
    expect(requireWorkspaceRow(alpha.defaultWorkspaceId).fs_root).toBe(
      harness.provisionedWorktreeRoot,
    );

    // The provisioned root vanishes — a real deletion, not a mocked verdict —
    // and the next read derives AND persists the stale transition.
    rmSync(harness.provisionedWorktreeRoot, { recursive: true, force: true });
    const afterLoss = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(
      new Map(afterLoss.workspaces.map((workspace) => [String(workspace.id), workspace.state])),
    ).toEqual(
      new Map([
        [String(alpha.defaultWorkspaceId), "stale"],
        [String(beta.defaultWorkspaceId), "ready"],
        [String(subdirectoryWorkspace.workspaceId), "ready"],
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
      [String(alpha.defaultWorkspaceId), String(subdirectoryWorkspace.workspaceId)].sort(),
    );

    // `Spec-009 §Detach Semantics (V1 Definition)` keeps the durable RECORD;
    // the column-level rule is D-009-7's (`updated_at` is the
    // lifecycle-mutation timestamp): the flip moves `updated_at` forward and
    // leaves `attached_at` alone, because the two answer different questions
    // ("when did this mount come into being" versus "when did it last move").
    // This is the pair the shared stepping clock exists for — at wall-clock
    // millisecond resolution the two stamps would tie on a fast machine and
    // the arm would fail for a reason that has nothing to do with the code.
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

    const eventTypes = readLifecycleEventTypes();
    expect(eventTypes).toEqual([
      "repo.attached",
      "workspace.ready",
      "repo.attached",
      "workspace.ready",
      "workspace.ready",
      "workspace.provisioning",
      "workspace.ready",
      "workspace.stale",
      "repo.detached",
      "workspace.archived",
      "workspace.archived",
    ]);

    // The ORDERING the 2026-08-05 `Plan-009 §Notes` repair settled, asserted
    // as a relation and not only as a position in the literal above:
    // `repo.detached` carries the prelude that wrote every cascade row, so an
    // archive announcement may only follow the commit that made it true.
    expect(eventTypes.indexOf("repo.detached")).toBeLessThan(
      eventTypes.indexOf("workspace.archived"),
    );

    // The attach's actor rides BOTH envelopes of alpha's attach transaction —
    // the mount event and its default workspace's — and beta's actor-less
    // attach stamps null on both. Threading across every event type is the
    // sibling suite's beat; what only the acceptance log shows is the two
    // postures side by side over the real append path.
    expect(
      readLifecycleEnvelopes()
        .slice(0, 4)
        .map((envelope) => envelope.actor),
    ).toEqual([PARTICIPANT_ACTOR, PARTICIPANT_ACTOR, null, null]);

    // Each cascaded archival names its workspace AND its mount, once.
    const archivedPayloads = readPayloadsOfType("workspace.archived");
    expect(new Set(archivedPayloads.map((payload) => payload.workspaceId))).toEqual(
      new Set([String(alpha.defaultWorkspaceId), String(subdirectoryWorkspace.workspaceId)]),
    );
    for (const payload of archivedPayloads) {
      expect(payload.repoMountId).toBe(String(alpha.repoMountId));
      expect(payload.state).toBe("archived");
    }

    const stalePayloads = readPayloadsOfType("workspace.stale");
    expect(stalePayloads).toHaveLength(1);
    expect(stalePayloads[0]?.workspaceId).toBe(String(alpha.defaultWorkspaceId));

    // The cascade stopped at the mount boundary.
    expect(requireMountRow(beta.repoMountId).state).toBe("attached");
    expect(requireWorkspaceRow(beta.defaultWorkspaceId).state).toBe("ready");
    expect(requireWorkspaceRow(alpha.defaultWorkspaceId).state).toBe("archived");
    expect(requireWorkspaceRow(subdirectoryWorkspace.workspaceId).state).toBe("archived");
  });
});

// ----------------------------------------------------------------------------
// I-009-6 — the workspace id is stable across mode switches
// (`Spec-009 §Execution Mode Transitions`)
// ----------------------------------------------------------------------------

describe("I-009-6 — a mode switch reprovisions IN PLACE", () => {
  it("keeps the id and the row through two full cycles, updating mode and root", async () => {
    const alpha = await harness.stack.mounts.attach({
      sessionId: SESSION_ID,
      localPath: fixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    const workspaceId = String(alpha.defaultWorkspaceId);
    const beforeCycles = requireWorkspaceRow(workspaceId);
    expect(beforeCycles.execution_mode).toBe("read-only");
    expect(beforeCycles.fs_root).toBe(fixtures.repositoryRoot);
    expect(countRows("workspaces")).toBe(1);

    await harness.stack.workspaces.beginReprovision(workspaceId, "worktree");
    const midCycle = requireWorkspaceRow(workspaceId);
    expect(midCycle.state).toBe("provisioning");
    expect(midCycle.execution_mode).toBe("worktree");
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
    await harness.stack.workspaces.beginReprovision(workspaceId, "branch");
    await harness.stack.workspaces.completeReprovision(workspaceId, harness.provisionedBranchRoot);

    const afterCycles = requireWorkspaceRow(workspaceId);
    expect(afterCycles.id).toBe(workspaceId);
    expect(afterCycles.repo_mount_id).toBe(String(alpha.repoMountId));
    expect(afterCycles.state).toBe("ready");
    expect(afterCycles.execution_mode).toBe("branch");
    expect(afterCycles.fs_root).toBe(harness.provisionedBranchRoot);
    // NO row was created or destroyed on the way — the id would also look
    // "stable" if the service had inserted a second row and left the first.
    expect(countRows("workspaces")).toBe(1);

    const listed = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(listed.workspaces).toHaveLength(1);
    expect(String(listed.workspaces[0]?.id)).toBe(workspaceId);
    expect(listed.workspaces[0]?.executionMode).toBe("branch");
    expect(listed.workspaces[0]?.fsRoot).toBe(harness.provisionedBranchRoot);

    // One event per transition, both cycles (I-009-9).
    expect(readLifecycleEventTypes()).toEqual([
      "repo.attached",
      "workspace.ready",
      "workspace.provisioning",
      "workspace.ready",
      "workspace.provisioning",
      "workspace.ready",
    ]);
  });
});

// ----------------------------------------------------------------------------
// I-009-7 — an unavailable root is `stale` on every read surface, and the write
// gate refuses it (`Spec-009 §Fallback Behavior`)
// ----------------------------------------------------------------------------

describe("I-009-7 — a root that vanishes makes its workspace stale", () => {
  it("persists the transition, refuses writes, and never auto-heals", async () => {
    // The healthy SIBLING: a mount on a fixture root that stays put. Without
    // it, "the write gate refuses" could not be told from "the write gate
    // refuses everything".
    const sibling = await harness.stack.mounts.attach({
      sessionId: SESSION_ID,
      localPath: fixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    // The VICTIM: a mount rooted at a directory this arm owns and deletes. Its
    // default workspace is the only one rooted there, so the stale count below
    // is unambiguous.
    const victim = await harness.stack.mounts.attach({
      sessionId: SESSION_ID,
      localPath: harness.disposableMountRoot,
      nodeId: NODE_ID,
    });

    rmSync(harness.disposableMountRoot, { recursive: true, force: true });

    const listedAfterLoss = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(
      new Map(
        listedAfterLoss.workspaces.map((workspace) => [String(workspace.id), workspace.state]),
      ),
    ).toEqual(
      new Map([
        [String(sibling.defaultWorkspaceId), "ready"],
        [String(victim.defaultWorkspaceId), "stale"],
      ]),
    );
    // PERSISTED, not merely reported: I-009-7's claim is about the row, so the
    // next reader sees it without re-probing.
    expect(requireWorkspaceRow(victim.defaultWorkspaceId).state).toBe("stale");

    // The mount read reports the same loss, and does NOT confuse it with a
    // lifecycle change — the row is still `attached` (D-009-2).
    const victimMount = await harness.stack.mounts.read(victim.repoMountId);
    expect(victimMount.health.status).toBe("unreachable");
    expect(victimMount.state).toBe("attached");
    expect(requireMountRow(victim.repoMountId).state).toBe("attached");

    // The write gate (CP-009-3).
    const refusal = await captureRejection(() =>
      harness.stack.workspaces.assertWritable(victim.defaultWorkspaceId),
    );
    expect(refusal).toBeInstanceOf(WorkspaceStaleError);
    expect((refusal as WorkspaceStaleError).code).toBe("workspace.stale");
    expect((refusal as WorkspaceStaleError).workspaceId).toBe(String(victim.defaultWorkspaceId));
    await expect(
      harness.stack.workspaces.assertWritable(sibling.defaultWorkspaceId),
    ).resolves.toBeUndefined();

    // The directory comes BACK. Mount health recovers, because it is derived
    // per read; the workspace does NOT, because repair is a decision, not an
    // observation — a run resumed against a re-created empty directory is the
    // silent-data-loss case this rule exists to prevent.
    mkdirSync(harness.disposableMountRoot, { recursive: true });
    const listedAfterRepair = await harness.stack.workspaces.list({ sessionId: SESSION_ID });
    expect(
      listedAfterRepair.workspaces.find(
        (workspace) => String(workspace.id) === String(victim.defaultWorkspaceId),
      )?.state,
    ).toBe("stale");
    expect((await harness.stack.mounts.read(victim.repoMountId)).health.status).toBe("healthy");

    // ONE `workspace.stale`, across three read surfaces and two probes.
    expect(readLifecycleEventTypes()).toEqual([
      "repo.attached",
      "workspace.ready",
      "repo.attached",
      "workspace.ready",
      "workspace.stale",
    ]);

    // The run hold is a state change with NO registered event type (CP-009-7),
    // so the closed six-type registry stays closed: `ready -> busy -> ready`
    // moves the row and appends nothing.
    const eventsBeforeHold = readLifecycleEventTypes();
    await harness.stack.workspaces.markBusy(sibling.defaultWorkspaceId, RUN_ID);
    expect(requireWorkspaceRow(sibling.defaultWorkspaceId).state).toBe("busy");
    expect(harness.stack.workspaces.releaseBusy(sibling.defaultWorkspaceId)).toBe(true);
    expect(requireWorkspaceRow(sibling.defaultWorkspaceId).state).toBe("ready");
    expect(readLifecycleEventTypes()).toEqual(eventsBeforeHold);
  });
});
