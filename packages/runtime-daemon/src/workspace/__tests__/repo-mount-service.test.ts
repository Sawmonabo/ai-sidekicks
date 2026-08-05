// RepoMountService — Plan-009 Phase 2 T2.3.
//
// Drives the real service against a real temp-file SQLite database (canonical
// `openDatabase` factory → per-test tmp dir → `afterEach` close + unlink), a
// real `EventLogService` append path, a real `WorkspaceService`, a real
// `SessionService`, and REAL git repositories on disk built with `execFile` —
// the same fixture approach `repo-root-resolver.test.ts` uses, because "attach
// through a subdirectory resolves to the repository root" is only a real claim
// if git actually answered it.
//
// Spec coverage: `Spec-009 §Required Behavior` (attach resolves and persists
// the canonical root); `Spec-009 §Default Behavior` (attach unconditionally
// creates a read-only default workspace rooted at that canonical root);
// `Spec-009 §Fallback Behavior` (unresolvable paths fail explicitly);
// `Spec-009 §Local Trust Envelope (V1 Definition)` (attach IS envelope
// admission — no containment check fires here);
// `Spec-009 §Detach Semantics (V1 Definition)` (busy refusal, archive cascade,
// terminal `detached`, re-attach as a NEW row);
// `Spec-009 §Repo Mount Health (V1 Definition)` (the on-read probe floor).
//
// Verifies invariant: I-009-1 (the persisted root is the resolver's output, not
// the entered path), I-009-2 (a failed resolution persists nothing at all),
// I-009-4 (a non-git directory is `vcs_type 'none'`, which is not an error),
// I-009-5 (rows carry resolved identity AND provenance), I-009-9 (one lifecycle
// event per real transition, and none for a non-transition).
//
// Five deliberate test-only mechanisms:
//   * REAL git fixtures, built once in `beforeAll` under a hermetic environment.
//     A mocked resolver would let every canonical-root assertion in this file
//     pass against a value the test itself invented.
//   * INTERFERENCE SEAMS — a signing-key source that mutates the database once,
//     before resolving. `EventLogService.append` awaits the signing key BEFORE
//     it opens the write transaction, so whatever the seam writes lands in the
//     exact window between this service's pre-transaction read and its prelude.
//     Both compare-and-swap paths and the in-transaction dependent read exist
//     for that window, and a race left to real concurrency is either flaky or
//     never reached.
//   * An injected `newRepoMountId` / `newWorkspaceId` that mints a COLLIDING id,
//     to reach constraint failures the production id source cannot produce.
//   * A FAILING EMITTER subclass whose first `workspace.archived` append
//     rejects, for the post-commit announcement path. That failure is
//     environmental (a signing outage, a full disk) and has no other trigger.
//   * An INJECTED `platform`, so the win32 git-pinning guard is exercised on
//     every CI leg rather than only on a Windows runner — the argument
//     `repo-root-resolver.ts` already makes for its injected `path` module.
//
// Negative controls accompany the guards that could otherwise pass vacuously:
// the refusal-ordering arm proves the resolver DID run for a known session, the
// uniqueness arm proves a non-uniqueness constraint failure is NOT translated,
// the in-transaction-read arm would still archive one workspace if the read had
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
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService, UnsignedPlaceholderAppendToken } from "../../session/session-service.js";
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
const UNKNOWN_SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-0000000000ff" as SessionId;
const NODE_ID: NodeId = "node-local" as NodeId;
const OTHER_NODE_ID: NodeId = "node-remote" as NodeId;
const UNKNOWN_MOUNT_ID: RepoMountId = "0190f9a1-0000-7000-8000-00000000ffff" as RepoMountId;

const PARTICIPANT_ACTOR: string = "0190f9a4-0000-7000-8000-000000000001";
const ATTACH_CORRELATION_ID: string = "0190f9a5-0000-7000-8000-000000000001";
const DETACH_CORRELATION_ID: string = "0190f9a5-0000-7000-8000-000000000002";
const RUN_ID: string = "0190f9a6-0000-7000-8000-000000000001";
const OTHER_RUN_ID: string = "0190f9a6-0000-7000-8000-000000000002";
// Stands in for a signing-key outage or a disk error at append time — the class
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

const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(
  11,
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

/**
 * A signing-key source that runs `interfere()` ONCE before answering.
 *
 * The interleaving driver for every race arm below. `EventLogService.append`
 * awaits the key BEFORE opening its write transaction, so the interference
 * commits in the window between the service's pre-transaction row read and the
 * prelude that acts on it — which is the only window those compare-and-swaps
 * and the in-transaction dependent read exist for.
 */
class InterferingSigningKeySource implements DaemonSigningKeySource {
  #fired: boolean = false;
  readonly #interfere: () => void;

  constructor(interfere: () => void) {
    this.#interfere = interfere;
  }

  read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    if (!this.#fired) {
      this.#fired = true;
      this.#interfere();
    }
    return Promise.resolve(FIXED_DAEMON_PRIVATE_KEY);
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    return Promise.reject(new Error("InterferingSigningKeySource.create is not used"));
  }
}

/**
 * An emitter whose FIRST `workspace.archived` append rejects; later ones append
 * for real.
 *
 * Drives the post-commit failure path. It has to fail the FIRST of two so the
 * arm can tell "the loop continued past a failure" from "the loop stopped" —
 * failing the last one would leave both behaviours indistinguishable.
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

/** Records every path handed to the resolver, then resolves it for real. */
class RecordingRepoRootResolver extends RepoRootResolver {
  readonly calls: string[] = [];

  override resolveCanonicalRoot(
    localPath: string,
  ): ReturnType<RepoRootResolver["resolveCanonicalRoot"]> {
    this.calls.push(localPath);
    return super.resolveCanonicalRoot(localPath);
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
  /** A real git repository root — what `rev-parse --show-toplevel` reports. */
  readonly repositoryRoot: string;
  /** A directory BELOW `repositoryRoot`; attaching it must persist the root. */
  readonly nestedDirectory: string;
  /** A second, unrelated repository — the envelope-admission control's target. */
  readonly unrelatedRepositoryRoot: string;
  /** A directory that is not a repository at all (I-009-4's honest `none`). */
  readonly plainDirectory: string;
  /** An absolute path that does not exist (I-009-2). */
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
    workspaces: harness.workspaces,
    sessions: harness.sessions,
    newRepoMountId: makeIdSource(MOUNT_ID_POOL, "repo mount"),
    ...overrides,
  });
}

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
 * Dropped rather than asserted in every arm: the anchor exists only because
 * `replay` refuses a chain that does not start with it, and repeating it in
 * thirty expectations would bury the sequence each arm is actually about.
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

function readLifecycleEnvelopes(): readonly StoredEventEnvelopeRow[] {
  return (
    harness.db
      .prepare(
        `SELECT type, actor, correlation_id, payload FROM session_events
          WHERE session_id = ? ORDER BY sequence ASC`,
      )
      .all(SESSION_ID) as readonly StoredEventEnvelopeRow[]
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

/**
 * A service whose event appends run `interfere()` once, in the window between
 * the pre-transaction read and the prelude. It carries its OWN emitter so the
 * interference cannot fire during the arm's setup attach.
 */
function createInterferingService(interfere: () => void): RepoMountService {
  const emitter = new WorkspaceEventEmitter({
    sessionEvents: new EventLogService({
      db: harness.db,
      signingKeySource: new InterferingSigningKeySource(interfere),
    }),
  });
  return new RepoMountService({
    database: harness.db,
    events: emitter,
    workspaces: harness.workspaces,
    sessions: harness.sessions,
    newRepoMountId: makeIdSource(MOUNT_ID_POOL, "repo mount"),
  });
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
      signingKeySource: new FixedDaemonSigningKeySource(),
    }),
  });
  const workspaces = new WorkspaceService({
    database: db,
    events: emitter,
    newWorkspaceId: makeIdSource(WORKSPACE_ID_POOL, "workspace"),
  });
  const sessions = new SessionService(db, {
    allowUnsignedPlaceholderAppend: UnsignedPlaceholderAppendToken.forTestsOnly(),
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
      workspaces,
      sessions,
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
// attach — `Spec-009 §Required Behavior` / `§Default Behavior`
// ----------------------------------------------------------------------------

describe("RepoMountService.attach", () => {
  it("persists the resolved root of a SUBDIRECTORY attach, and it survives a reopen", async () => {
    const response = await harness.service.attach({
      sessionId: SESSION_ID,
      // The entered path is BELOW the repository root — the case
      // `Spec-009 §Implementation Notes` calls out, and the only shape in which
      // I-009-1 (resolved root, not entered path) is observable at all.
      localPath: gitFixtures.nestedDirectory,
      nodeId: NODE_ID,
    });

    expect(response.state).toBe("attached");
    expect(response.vcsType).toBe("git");
    expect(response.canonicalRoot).toBe(gitFixtures.repositoryRoot);
    expect(response.canonicalRoot).not.toBe(gitFixtures.nestedDirectory);
    expect(response.defaultWorkspaceId).toBe(WORKSPACE_ID_POOL[0]);

    // AC1's durability leg: close the handle, reopen the same FILE, and read.
    // An in-memory or uncommitted row would not survive this. The harness's
    // service and emitter hold statements against the closed handle and are not
    // used again in this arm.
    harness.db.close();
    harness.db = openDatabase(harness.dbPath);

    const mount = requireMountRow(response.repoMountId);
    expect(mount.canonical_root).toBe(gitFixtures.repositoryRoot);
    // PROVENANCE survives alongside resolved identity (I-009-5), and the two
    // differ — which is what makes keeping both meaningful.
    expect(mount.local_path).toBe(gitFixtures.nestedDirectory);
    expect(mount.local_path).not.toBe(mount.canonical_root);
    expect(mount.session_id).toBe(SESSION_ID);
    expect(mount.node_id).toBe(NODE_ID);
    expect(mount.vcs_type).toBe("git");
    expect(mount.state).toBe("attached");

    const workspace = requireWorkspaceRow(response.defaultWorkspaceId);
    expect(workspace.repo_mount_id).toBe(response.repoMountId);
    expect(workspace.session_id).toBe(SESSION_ID);
    expect(workspace.execution_mode).toBe("read-only");
    expect(workspace.state).toBe("ready");
    // Rooted at the mount's CANONICAL root, never the entered subdirectory.
    expect(workspace.fs_root).toBe(gitFixtures.repositoryRoot);

    expect(readLifecycleEventTypes()).toEqual(["repo.attached", "workspace.ready"]);
  });

  it("records a non-git directory as vcs_type 'none' — not an error (I-009-4, D-009-4)", async () => {
    const response = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.plainDirectory,
      nodeId: NODE_ID,
    });

    expect(response.vcsType).toBe("none");
    expect(response.canonicalRoot).toBe(gitFixtures.plainDirectory);
    expect(requireMountRow(response.repoMountId).vcs_type).toBe("none");

    // The SINGLE FUNNEL: a plain directory gets the same default workspace a
    // repository does, rather than a mount-less bind path.
    const workspace = requireWorkspaceRow(response.defaultWorkspaceId);
    expect(workspace.execution_mode).toBe("read-only");
    expect(workspace.state).toBe("ready");
    expect(readLifecycleEventTypes()).toEqual(["repo.attached", "workspace.ready"]);
  });

  it("threads actor and correlationId onto both attach events", async () => {
    await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
      actor: PARTICIPANT_ACTOR,
      correlationId: ATTACH_CORRELATION_ID,
    });

    for (const envelope of readLifecycleEnvelopes()) {
      expect(envelope.actor).toBe(PARTICIPANT_ACTOR);
      expect(envelope.correlation_id).toBe(ATTACH_CORRELATION_ID);
    }
  });

  it("persists NOTHING when the root cannot be resolved (I-009-2)", async () => {
    for (const unresolvable of [
      gitFixtures.absentPath,
      // Relative — the resolver refuses rather than completing it against the
      // daemon's working directory.
      "relative/not/absolute",
    ]) {
      const error = await captureRejection(() =>
        harness.service.attach({
          sessionId: SESSION_ID,
          localPath: unresolvable,
          nodeId: NODE_ID,
        }),
      );
      expect(error).toBeInstanceOf(RepoRootResolutionError);
      expect((error as RepoRootResolutionError).code).toBe("repo.root_resolution_failed");
    }

    expect(countRows("repo_mounts")).toBe(0);
    expect(countRows("workspaces")).toBe(0);
    expect(readLifecycleEventTypes()).toEqual([]);
  });

  it("refuses an unknown session BEFORE resolving or persisting anything", async () => {
    const resolver = new RecordingRepoRootResolver();
    const service = createService({ resolver });

    const error = await captureRejection(() =>
      service.attach({
        sessionId: UNKNOWN_SESSION_ID,
        // A path that WOULD resolve. If the ordering were reversed, the
        // recorder below would hold it.
        localPath: gitFixtures.nestedDirectory,
        nodeId: NODE_ID,
      }),
    );

    expect(error).toBeInstanceOf(SessionNotFoundError);
    expect((error as SessionNotFoundError).code).toBe("session.not_found");
    expect((error as SessionNotFoundError).fields).toEqual({ sessionId: UNKNOWN_SESSION_ID });
    expect(resolver.calls).toEqual([]);
    expect(countRows("repo_mounts")).toBe(0);
    expect(countRows("workspaces")).toBe(0);
    expect(readLifecycleEventTypes(UNKNOWN_SESSION_ID)).toEqual([]);

    // NEGATIVE CONTROL: the same service, the same path, a session that exists.
    // Without this the arm above would also pass if the recorder were broken or
    // the path unresolvable for an unrelated reason.
    await service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.nestedDirectory,
      nodeId: NODE_ID,
    });
    expect(resolver.calls).toEqual([gitFixtures.nestedDirectory]);
  });

  it("admits a path with NO containment check — attach IS envelope admission", async () => {
    // The session already has an envelope: one attached mount at
    // `repositoryRoot`. A containment check at attach would refuse anything
    // outside it, which is precisely what must NOT happen here.
    const first = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });

    const second = await harness.service.attach({
      sessionId: SESSION_ID,
      // An unrelated repository, a sibling of the first and under no part of it.
      localPath: gitFixtures.unrelatedRepositoryRoot,
      nodeId: NODE_ID,
    });

    expect(second.canonicalRoot).toBe(gitFixtures.unrelatedRepositoryRoot);
    expect(second.repoMountId).not.toBe(first.repoMountId);
    expect(countRows("repo_mounts")).toBe(2);
  });

  it("refuses the attach response — and writes nothing — when the identity is unrepresentable", async () => {
    // A minted id the branded schema refuses. The projection runs BEFORE the
    // writes precisely so this leaves no durable mount: a mount that exists and
    // cannot be reported is one the caller never learns the id of, and so cannot
    // detach either.
    const service = createService({ newRepoMountId: () => "not-a-uuid" });

    const error = await captureRejection(() =>
      service.attach({
        sessionId: SESSION_ID,
        localPath: gitFixtures.repositoryRoot,
        nodeId: NODE_ID,
      }),
    );

    expect(error).toBeInstanceOf(RepoMountServiceInvariantError);
    expect((error as RepoMountServiceInvariantError).kind).toBe("repo_mount_row_unprojectable");
    expect(countRows("repo_mounts")).toBe(0);
    expect(countRows("workspaces")).toBe(0);
    expect(readLifecycleEventTypes()).toEqual([]);
  });

  it("rolls the mount row back when the default-workspace INSERT throws", async () => {
    // Prelude-throw atomicity from the OTHER side: the mount INSERT succeeds and
    // the workspace INSERT fails on its primary key. Both rows and the
    // `repo.attached` event must vanish together.
    const collidingWorkspaces = new WorkspaceService({
      database: harness.db,
      events: harness.emitter,
      newWorkspaceId: () => INJECTED_WORKSPACE_ID,
    });
    const service = createService({ workspaces: collidingWorkspaces });

    await service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    expect(countRows("repo_mounts")).toBe(1);

    await captureRejection(() =>
      service.attach({
        sessionId: SESSION_ID,
        localPath: gitFixtures.unrelatedRepositoryRoot,
        nodeId: NODE_ID,
      }),
    );

    expect(countRows("repo_mounts")).toBe(1);
    expect(countRows("workspaces")).toBe(1);
    expect(readLifecycleEventTypes()).toEqual(["repo.attached", "workspace.ready"]);
  });
});

// ----------------------------------------------------------------------------
// attach — active-root uniqueness (D-009-7)
// ----------------------------------------------------------------------------

describe("RepoMountService.attach — active-root uniqueness", () => {
  it("refuses a duplicate active root and takes the aborted event row with it", async () => {
    const first = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });

    const error = await captureRejection(() =>
      harness.service.attach({
        sessionId: SESSION_ID,
        // A DIFFERENT entered path resolving to the SAME canonical root — the
        // shape that proves the index keys `canonical_root`, not `local_path`.
        localPath: gitFixtures.nestedDirectory,
        nodeId: NODE_ID,
      }),
    );

    expect(error).toBeInstanceOf(RepoAlreadyAttachedError);
    expect((error as RepoAlreadyAttachedError).conflictingRepoMountId).toBe(first.repoMountId);
    expect((error as RepoAlreadyAttachedError).code).toBe("repo.already_attached");

    // The translation throws from the MOUNT INSERT, which is the FIRST statement
    // in the prelude — so on this path `creation.insertRow()` was never reached
    // and the abort had no workspace row to undo. `workspaces === 1` is
    // therefore the claim that the second workspace was never inserted, not that
    // an inserted one rolled back. (The rolled-back-prior-write direction is the
    // colliding-workspace-id arm's job, where the mount INSERT succeeds first.)
    // The event row is what this abort actually undoes: only the FIRST attach's
    // pair is in the log.
    expect(countRows("repo_mounts")).toBe(1);
    expect(countRows("workspaces")).toBe(1);
    expect(readLifecycleEventTypes()).toEqual(["repo.attached", "workspace.ready"]);
  });

  it("attaches the same root cleanly on a different node and in a different session", async () => {
    await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });

    // The same absolute path on two nodes names two node-local filesystems, and
    // both may attach (D-009-7's node-scoped key).
    const otherNode = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: OTHER_NODE_ID,
    });
    expect(otherNode.canonicalRoot).toBe(gitFixtures.repositoryRoot);

    // The index is session-scoped too.
    const otherSession = await harness.service.attach({
      sessionId: OTHER_SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    expect(otherSession.canonicalRoot).toBe(gitFixtures.repositoryRoot);
    expect(countRows("repo_mounts")).toBe(3);

    // I-009-9 is per-stream, not per-process: each attach emits its pair onto
    // the session it named and onto no other. Three attaches over two sessions
    // must therefore split 2/1, never 3/0 or 0/3. This is the only arm where a
    // sessionId threaded from the request into the wrong envelope would show.
    expect(readLifecycleEventTypes(SESSION_ID)).toEqual([
      "repo.attached",
      "workspace.ready",
      "repo.attached",
      "workspace.ready",
    ]);
    expect(readLifecycleEventTypes(OTHER_SESSION_ID)).toEqual(["repo.attached", "workspace.ready"]);
  });

  it("re-attaches a detached root as a NEW row", async () => {
    const first = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    await harness.service.detach({ repoMountId: first.repoMountId });

    const second = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });

    expect(second.repoMountId).not.toBe(first.repoMountId);
    // The durable record of the first mount is RETAINED, not replaced.
    expect(requireMountRow(first.repoMountId).state).toBe("detached");
    expect(requireMountRow(second.repoMountId).state).toBe("attached");
    expect(countRows("repo_mounts")).toBe(2);
  });

  it("does NOT translate a constraint failure that is not the uniqueness index", async () => {
    // NEGATIVE CONTROL for the translation's discrimination. Two different roots
    // under one minted id: the failure is the primary key, and no active mount
    // holds the second root — so `repo.already_attached` would be a lie, and the
    // original error must surface untranslated.
    const service = createService({ newRepoMountId: () => INJECTED_MOUNT_ID });

    await service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });

    const error = await captureRejection(() =>
      service.attach({
        sessionId: SESSION_ID,
        localPath: gitFixtures.unrelatedRepositoryRoot,
        nodeId: NODE_ID,
      }),
    );

    expect(error).not.toBeInstanceOf(RepoAlreadyAttachedError);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as { code?: unknown }).code)).toContain("SQLITE_CONSTRAINT");
    expect(countRows("repo_mounts")).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// read — `Spec-009 §Repo Mount Health (V1 Definition)`
// ----------------------------------------------------------------------------

describe("RepoMountService.read", () => {
  it("projects the row and enriches it with a fresh health verdict", async () => {
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.nestedDirectory,
      nodeId: NODE_ID,
    });

    const response = await harness.service.read(attached.repoMountId);

    // BARE `id` on a read projection, per the contract's naming note.
    expect(response.id).toBe(attached.repoMountId);
    expect(response.sessionId).toBe(SESSION_ID);
    expect(response.nodeId).toBe(NODE_ID);
    expect(response.localPath).toBe(gitFixtures.nestedDirectory);
    expect(response.canonicalRoot).toBe(gitFixtures.repositoryRoot);
    expect(response.localPath).not.toBe(response.canonicalRoot);
    expect(response.vcsType).toBe("git");
    expect(response.state).toBe("attached");
    expect(response.health.status).toBe("healthy");
    // FRESH, per the D-009-5 on-read probe floor: `checkedAt` is when this read
    // measured the root, not when the mount was attached. Asserting it is not
    // BEFORE `attachedAt` is the strongest ordering claim available without
    // freezing the clock — and it fails if `checkedAt` were ever sourced from
    // the row rather than the probe.
    expect(Date.parse(response.health.checkedAt)).not.toBeNaN();
    expect(Date.parse(response.health.checkedAt)).toBeGreaterThanOrEqual(
      Date.parse(requireMountRow(attached.repoMountId).attached_at),
    );
    expect(response.attachedAt).toBe(requireMountRow(attached.repoMountId).attached_at);
  });

  it("probes the row's canonical_root VERBATIM", async () => {
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.nestedDirectory,
      nodeId: NODE_ID,
    });

    const probedPaths: string[] = [];
    const service = createService({ probePath: recordingProbe((path) => probedPaths.push(path)) });
    await service.read(attached.repoMountId);

    // The ROW's canonical root, byte for byte — not the entered path, and not a
    // re-normalized spelling of either.
    expect(probedPaths).toEqual([gitFixtures.repositoryRoot]);
  });

  it("reports a vanished root as unreachable, and changes nothing", async () => {
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: harness.disposableRoot,
      nodeId: NODE_ID,
    });
    // A REAL deletion, not a mocked verdict.
    rmSync(harness.disposableRoot, { recursive: true, force: true });

    const response = await harness.service.read(attached.repoMountId);

    expect(response.health.status).toBe("unreachable");
    // Health is a projection, never a persisted column and never a transition:
    // the mount is still `attached` and the read appended no event.
    expect(response.state).toBe("attached");
    expect(requireMountRow(attached.repoMountId).state).toBe("attached");
    expect(readLifecycleEventTypes()).toEqual(["repo.attached", "workspace.ready"]);
  });

  it("answers for a DETACHED mount, and its health stays orthogonal to lifecycle", async () => {
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    await harness.service.detach({ repoMountId: attached.repoMountId });

    const response = await harness.service.read(attached.repoMountId);

    // `Spec-009 §Detach Semantics (V1 Definition)` keeps the durable record, and
    // a record that could not be read would not be kept in any useful sense.
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
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
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
// detach — `Spec-009 §Detach Semantics (V1 Definition)`
// ----------------------------------------------------------------------------

describe("RepoMountService.detach", () => {
  it("archives every dependent and flips the mount, in one exact event sequence", async () => {
    // A STEPPING clock, not the wall clock. The `updated_at` assertions below
    // compare the attach stamp to the detach stamp, and `toISOString` is
    // millisecond-resolution — a real clock lets the two calls tie and the arm
    // fails intermittently for a reason that has nothing to do with the code.
    const service = createService({ now: steppingClock() });

    const attached = await service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    const bound = await harness.workspaces.bind({
      repoMountId: attached.repoMountId,
      executionMode: "read-only",
    });
    const mountBeforeDetach = requireMountRow(attached.repoMountId);

    const response = await service.detach({
      repoMountId: attached.repoMountId,
      actor: PARTICIPANT_ACTOR,
      correlationId: DETACH_CORRELATION_ID,
    });

    expect(response.state).toBe("detached");
    expect([...response.archivedWorkspaceIds].sort()).toEqual(
      [attached.defaultWorkspaceId, bound.workspaceId].sort(),
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
    expect(requireWorkspaceRow(attached.defaultWorkspaceId).state).toBe("archived");
    expect(requireWorkspaceRow(bound.workspaceId).state).toBe("archived");

    // `repo.detached` FIRST — it is the append whose prelude carried every row
    // write — then one `workspace.archived` per workspace actually transitioned.
    expect(readLifecycleEventTypes()).toEqual([
      "repo.attached",
      "workspace.ready",
      "workspace.ready",
      "repo.detached",
      "workspace.archived",
      "workspace.archived",
    ]);

    // Every event of the cascade carries the caller's linkage — the only thing
    // that collates them, since the follow-on events cannot name the
    // `repo.detached` event id without reading the append receipt.
    for (const envelope of readLifecycleEnvelopes().slice(3)) {
      expect(envelope.actor).toBe(PARTICIPANT_ACTOR);
      expect(envelope.correlation_id).toBe(DETACH_CORRELATION_ID);
    }
    // The dependent archivals name their mount, per T2.2's cascade contract.
    for (const envelope of readLifecycleEnvelopes().filter(
      (row) => row.type === "workspace.archived",
    )) {
      expect((JSON.parse(envelope.payload) as { repoMountId?: string }).repoMountId).toBe(
        attached.repoMountId,
      );
    }
  });

  it("refuses while dependents are busy, naming EVERY busy one, and persists nothing", async () => {
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    const bound = await harness.workspaces.bind({
      repoMountId: attached.repoMountId,
      executionMode: "read-only",
    });

    // TWO busy dependents, not one. With a single busy workspace the arm cannot
    // tell a refusal that COLLECTS every blocker from one that throws on the
    // first it meets — both produce a one-element array. The operator-facing
    // difference is real: a refusal naming one of two busy workspaces sends
    // someone to free that run and retry, only to be refused again.
    await harness.workspaces.markBusy(attached.defaultWorkspaceId, RUN_ID);
    await harness.workspaces.markBusy(bound.workspaceId, OTHER_RUN_ID);

    const error = await captureRejection(() =>
      harness.service.detach({ repoMountId: attached.repoMountId }),
    );

    expect(error).toBeInstanceOf(RepoDetachConflictError);
    // Order is the dependent statement's `created_at ASC, id ASC`: the default
    // workspace is created during attach and the bound one after it, and the id
    // tie-break agrees, so the two keys cannot disagree here.
    expect((error as RepoDetachConflictError).busyWorkspaceIds).toEqual([
      attached.defaultWorkspaceId,
      bound.workspaceId,
    ]);
    expect((error as RepoDetachConflictError).code).toBe("repo.detach_conflict");

    // Nothing moved and nothing was appended: the refusal threw from inside the
    // prelude, so the transaction took the `repo.detached` row with it.
    expect(requireMountRow(attached.repoMountId).state).toBe("attached");
    expect(requireWorkspaceRow(attached.defaultWorkspaceId).state).toBe("busy");
    expect(requireWorkspaceRow(bound.workspaceId).state).toBe("busy");
    expect(readLifecycleEventTypes()).toEqual([
      "repo.attached",
      "workspace.ready",
      "workspace.ready",
    ]);
  });

  it("emits no second workspace.archived for an already-archived dependent", async () => {
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    const bound = await harness.workspaces.bind({
      repoMountId: attached.repoMountId,
      executionMode: "read-only",
    });
    // Planted directly — a stand-in for a workspace archived on some earlier
    // path. An `archived` row is terminal, so re-archiving it is not a
    // transition, and I-009-9 forbids an event for a non-transition.
    harness.db
      .prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?")
      .run(bound.workspaceId);

    const response = await harness.service.detach({ repoMountId: attached.repoMountId });

    expect(response.archivedWorkspaceIds).toEqual([attached.defaultWorkspaceId]);
    expect(readLifecycleEventTypes()).toEqual([
      "repo.attached",
      "workspace.ready",
      "workspace.ready",
      "repo.detached",
      "workspace.archived",
    ]);
  });

  it("is a no-op success on an already-detached mount, with no event", async () => {
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
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
    expect(countRows("repo_mounts")).toBe(0);
  });

  it("announces the remaining dependents when one archived append fails, then rejects", async () => {
    const emitter = new FirstArchiveAppendFailingEmitter({
      sessionEvents: new EventLogService({
        db: harness.db,
        signingKeySource: new FixedDaemonSigningKeySource(),
      }),
    });
    const service = new RepoMountService({
      database: harness.db,
      events: emitter,
      workspaces: harness.workspaces,
      sessions: harness.sessions,
      newRepoMountId: makeIdSource(MOUNT_ID_POOL, "repo mount"),
    });

    const attached = await service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });
    const bound = await harness.workspaces.bind({
      repoMountId: attached.repoMountId,
      executionMode: "read-only",
    });

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
    expect(emitter.attemptedWorkspaceIds).toEqual([attached.defaultWorkspaceId, bound.workspaceId]);

    // The rows are the truth and they are all correct — the failure is confined
    // to the log.
    expect(requireMountRow(attached.repoMountId).state).toBe("detached");
    expect(requireWorkspaceRow(attached.defaultWorkspaceId).state).toBe("archived");
    expect(requireWorkspaceRow(bound.workspaceId).state).toBe("archived");

    // Exactly ONE `workspace.archived` landed, and it is the SECOND workspace —
    // the one whose append ran after the failure. That identity is what proves
    // the loop continued rather than the first append having quietly succeeded.
    expect(readLifecycleEventTypes()).toEqual([
      "repo.attached",
      "workspace.ready",
      "workspace.ready",
      "repo.detached",
      "workspace.archived",
    ]);
    const archivedEnvelopes = readLifecycleEnvelopes().filter(
      (row) => row.type === "workspace.archived",
    );
    expect(
      (JSON.parse(archivedEnvelopes[0]?.payload ?? "{}") as { workspaceId?: string }).workspaceId,
    ).toBe(bound.workspaceId);

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
    // The race the T2.4 bind-side predicate closes from its end. The
    // interference commits a `ready` workspace on this mount in the window
    // between `detach`'s row read and its prelude — exactly where a bind that
    // passed the mount's `state = 'attached'` guard would land.
    //
    // DISCRIMINATING: if the dependent set were read outside the write
    // transaction, this workspace would not be in it, one workspace would be
    // archived instead of two, and a live execution root would survive on a
    // detached mount.
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });

    const service = createInterferingService(() => {
      harness.db
        .prepare(
          `INSERT INTO workspaces (
             id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata, created_at, updated_at
           ) VALUES (@id, @session_id, @repo_mount_id, 'read-only', @fs_root, 'ready', '{}', @now, @now)`,
        )
        .run({
          id: INJECTED_WORKSPACE_ID,
          session_id: SESSION_ID,
          repo_mount_id: attached.repoMountId,
          fs_root: gitFixtures.repositoryRoot,
          now: "2026-08-05T00:00:01.000Z",
        });
    });

    const response = await service.detach({ repoMountId: attached.repoMountId });

    expect([...response.archivedWorkspaceIds].sort()).toEqual(
      [attached.defaultWorkspaceId, INJECTED_WORKSPACE_ID].sort(),
    );
    expect(requireWorkspaceRow(INJECTED_WORKSPACE_ID).state).toBe("archived");
    expect(readLifecycleEventTypes()).toEqual([
      "repo.attached",
      "workspace.ready",
      "repo.detached",
      "workspace.archived",
      "workspace.archived",
    ]);
  });

  it("appends no second repo.detached when a concurrent detach wins the flip", async () => {
    const attached = await harness.service.attach({
      sessionId: SESSION_ID,
      localPath: gitFixtures.repositoryRoot,
      nodeId: NODE_ID,
    });

    // The winner's write, landing after this call read the row as `attached`.
    const service = createInterferingService(() => {
      harness.db
        .prepare("UPDATE repo_mounts SET state = 'detached' WHERE id = ?")
        .run(attached.repoMountId);
    });

    const response = await service.detach({ repoMountId: attached.repoMountId });

    // The loser reports the WINNER's outcome rather than inventing one, and
    // claims to have archived nothing — because it did not.
    expect(response.state).toBe("detached");
    expect(response.archivedWorkspaceIds).toEqual([]);
    expect(readLifecycleEventTypes()).toEqual(["repo.attached", "workspace.ready"]);
    // The compare-and-swap aborted the whole transaction, so the cascade's
    // archive writes rolled back with it.
    expect(requireWorkspaceRow(attached.defaultWorkspaceId).state).toBe("ready");
  });
});

// ----------------------------------------------------------------------------
// Construction — the Windows `git` seam (`Plan-009 §Notes`, 2026-07-25)
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
      service.attach({
        sessionId: SESSION_ID,
        localPath: gitFixtures.repositoryRoot,
        nodeId: NODE_ID,
      }),
    );

    expect(error).toBeInstanceOf(RepoRootResolutionError);
    // `vcs_error`, never a `none` fallback: a repository whose git could not run
    // is not a plain directory (I-009-4).
    expect((error as RepoRootResolutionError).reason).toBe("vcs_error");
    expect(countRows("repo_mounts")).toBe(0);
  });
});
