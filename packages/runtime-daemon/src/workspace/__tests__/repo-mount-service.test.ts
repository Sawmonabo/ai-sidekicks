// Proves RepoMountService keeps one active mount per canonical root and detaches atomically:
// every dependent is archived and announced, a busy one blocks the detach, and a race rolls back.
// Real git, SQLite and services; a clock that writes on its first read opens the race windows.

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
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import { WorkspaceService } from "../workspace-service.js";

import {
  buildFixtureEnvironment,
  captureRejection,
  runFixtureGit,
  seedSession,
  steppingClock,
} from "./workspace.test-support.js";

const SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000001" as SessionId;
const OTHER_SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000002" as SessionId;
const NODE_ID: NodeId = "node-local" as NodeId;
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

interface GitFixtures {
  readonly fixtureRoot: string;
  /** A real git repository root — what `rev-parse --show-toplevel` reports. */
  readonly repositoryRoot: string;
  /** A directory BELOW `repositoryRoot`, which resolves to the same canonical root. */
  readonly nestedDirectory: string;
  /** An absolute path that does not exist. */
  readonly absentPath: string;
  /** An absolute path to a `git` that is not there. */
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
  mkdirSync(nestedDirectory, { recursive: true });

  await runFixtureGit(["init", "-q", repositoryRoot], environment, fixtureRoot);

  gitFixtures = {
    fixtureRoot,
    repositoryRoot,
    nestedDirectory,
    absentPath: join(fixtureRoot, "does-not-exist"),
    missingGitExecutable: join(fixtureRoot, "definitely-not-a-git-binary"),
  };
}, 120_000);

afterAll(() => {
  if (gitFixtures !== undefined) {
    rmSync(gitFixtures.fixtureRoot, { recursive: true, force: true });
  }
});

interface TestHarness {
  readonly db: DatabaseType;
  readonly emitter: WorkspaceEventEmitter;
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService;
  readonly service: RepoMountService;
  readonly tmpDir: string;
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

/** Bind a workspace and complete its preparation at the repository root, so it is `ready`. */
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

function captureThrow(body: () => unknown): unknown {
  try {
    body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to throw, but it returned");
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

beforeEach(async () => {
  const tmpDir: string = await realpath(
    await mkdtemp(join(tmpdir(), "ai-sidekicks-repo-mount-service-db-")),
  );
  const db: DatabaseType = openDatabase(join(tmpDir, "test.db"));
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
  harness = {
    db,
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
  };

  seedSession(sessions, SESSION_ID);
  seedSession(sessions, OTHER_SESSION_ID);
});

afterEach(() => {
  // The per-session append lock is a module singleton; a leftover queue entry would stall the next
  // case on the same session id and look like an unrelated timeout.
  __resetSessionAppendLocksForTest();
  harness.db.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

describe("RepoMountService.attach — resolution failure", () => {
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
    // Fail-closed. Driven through the injected platform so it runs on every CI leg, not only on
    // Windows.
    const error = captureThrow(() => createService({ platform: "win32" }));

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toContain("win32");
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
