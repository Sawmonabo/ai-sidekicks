// Proves RepoMountService keeps one active mount per canonical root and detaches atomically:
// every dependent is archived and announced, a running agent blocks the detach, and a race rolls
// back.
// Real git, SQLite and services; a clock that writes on its first read opens the race windows.

import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { NodeId } from "@ai-sidekicks/contracts/node-id";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/repo";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";

import { EventLogService } from "../../../events/event-log-service.js";
import { openDatabase } from "../../../session/migration-runner.js";
import { SessionService } from "../../../session/session-service.js";
import {
  RepoAlreadyAttachedError,
  RepoDetachConflictError,
  RepoMountNotFoundError,
  RepoRootResolutionError,
} from "../errors.js";
import {
  RepoMountService,
  RepoMountServiceInvariantError,
  type RepoMountServiceDeps,
} from "../repo-mount-service.js";
import { WorkspaceEventEmitter } from "../../workspace-event-emitter.js";
import { WorkspaceService } from "../../workspace-service.js";

import {
  bindReadyWorkspace,
  buildFixtureEnvironment,
  readLifecycleEnvelopes,
  readLifecycleEventTypes,
  requireMountRow,
  requireWorkspaceRow,
  runFixtureGit,
  seedSession,
  steppingClock,
} from "../../__tests__/workspace.test-support.js";
import { captureRejection, captureThrow } from "../../../__fixtures__/capture-failure.js";

const SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000001" as SessionId;
const OTHER_SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000002" as SessionId;
const NODE_ID: NodeId = "node-local" as NodeId;
const UNKNOWN_MOUNT_ID: RepoMountId = "0190f9a1-0000-7000-8000-00000000ffff" as RepoMountId;

const USER_ACTOR: string = "0190f9a4-0000-7000-8000-000000000001";
const DETACH_CORRELATION_ID: string = "0190f9a5-0000-7000-8000-000000000002";
const RUN_ID: string = "0190f9a6-0000-7000-8000-000000000001";
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

interface GitFixtures {
  readonly fixtureRoot: string;
  /** A real git repository root — what `rev-parse --show-toplevel` reports. */
  readonly repositoryRoot: string;
  /** A directory BELOW `repositoryRoot`, which resolves to the same canonical root. */
  readonly nestedDirectory: string;
  /** An absolute path that does not exist. */
  readonly absentPath: string;
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

function countMountRows(): number {
  return (
    harness.db.prepare("SELECT COUNT(*) AS total FROM repo_mounts").get() as {
      readonly total: number;
    }
  ).total;
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
  const sessions = new SessionService(db);
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

  seedSession(db, SESSION_ID);
  seedSession(db, OTHER_SESSION_ID);
});

afterEach(() => {
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
    expect(requireMountRow(harness.db, first.repoMountId).state).toBe("detached");
    expect(requireMountRow(harness.db, second.repoMountId).state).toBe("attached");
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
    const mountBeforeDetach = requireMountRow(harness.db, attached.repoMountId);

    const response = await service.detach({
      repoMountId: attached.repoMountId,
      actor: USER_ACTOR,
      correlationId: DETACH_CORRELATION_ID,
    });

    expect(response.state).toBe("detached");
    expect([...response.archivedWorkspaceIds].sort()).toEqual(
      [...workspaceIdBySession.values()].sort(),
    );

    const detachedMount = requireMountRow(harness.db, attached.repoMountId);
    expect(detachedMount.state).toBe("detached");
    // The flip stamps `updated_at` and leaves `attached_at` alone; a flip that wrote neither, or
    // the wrong one, would still pass every `state` assertion.
    expect(Date.parse(detachedMount.updated_at)).toBeGreaterThan(
      Date.parse(mountBeforeDetach.updated_at),
    );
    expect(detachedMount.attached_at).toBe(mountBeforeDetach.attached_at);

    for (const [sessionId, workspaceId] of workspaceIdBySession) {
      expect(requireWorkspaceRow(harness.db, workspaceId).state).toBe("archived");
      // The session's own bind then its own archival, and nothing about the other session or the
      // mount.
      expect(readLifecycleEventTypes(harness.db, sessionId)).toEqual([
        "workspace.preparing",
        "workspace.archived",
      ]);
      const archived = readLifecycleEnvelopes(harness.db, sessionId).filter(
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

  it(
    "refuses while a dependent is busy, naming the " +
      "session running there, and persists nothing",
    async () => {
      const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
      // The older dependent is idle and belongs to another session, so naming the first dependent's
      // session instead of the running one would name a session that holds nothing.
      const idleWorkspaceId = await bindReadyWorkspace(
        harness.workspaces,
        SESSION_ID,
        attached.repoMountId,
        gitFixtures.repositoryRoot,
      );
      const busyWorkspaceId = await bindReadyWorkspace(
        harness.workspaces,
        OTHER_SESSION_ID,
        attached.repoMountId,
        gitFixtures.repositoryRoot,
      );
      await harness.workspaces.markBusy(busyWorkspaceId, RUN_ID);
      const idleEventsBeforeRefusal = readLifecycleEventTypes(harness.db, SESSION_ID);
      const busyEventsBeforeRefusal = readLifecycleEventTypes(harness.db, OTHER_SESSION_ID);

      const error = await captureRejection(() =>
        harness.service.detach({ repoMountId: attached.repoMountId }),
      );

      expect(error).toBeInstanceOf(RepoDetachConflictError);
      expect((error as RepoDetachConflictError).code).toBe("repo.detach_conflict");
      expect((error as RepoDetachConflictError).runningSessionId).toBe(OTHER_SESSION_ID);
      expect((error as RepoDetachConflictError).detail).toEqual({
        runningSessionId: OTHER_SESSION_ID,
      });

      // Nothing moved and nothing was appended.
      expect(requireMountRow(harness.db, attached.repoMountId).state).toBe("attached");
      expect(requireWorkspaceRow(harness.db, idleWorkspaceId).state).toBe("ready");
      expect(requireWorkspaceRow(harness.db, busyWorkspaceId).state).toBe("busy");
      expect(readLifecycleEventTypes(harness.db, SESSION_ID)).toEqual(idleEventsBeforeRefusal);
      expect(readLifecycleEventTypes(harness.db, OTHER_SESSION_ID)).toEqual(
        busyEventsBeforeRefusal,
      );
    },
  );

  it("refuses while a run's execution root is unreleased after its workspace hold is", async () => {
    // A run releases its workspace hold and its execution root separately, so once the hold is
    // gone only the run's unreleased execution root says an agent is still running there.
    const attached = await harness.service.attach({ localPath: gitFixtures.repositoryRoot });
    const workspaceId = await bindReadyWorkspace(
      harness.workspaces,
      SESSION_ID,
      attached.repoMountId,
      gitFixtures.repositoryRoot,
    );
    await harness.workspaces.markBusy(workspaceId, RUN_ID);
    const branchContextId = "0190f9a7-0000-7000-8000-000000000001";
    harness.db
      .prepare(
        `INSERT INTO branch_contexts (
           id, workspace_id, base_branch, head_branch, created_at, updated_at
         ) VALUES (?, ?, 'main', 'main', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(branchContextId, workspaceId);
    harness.db
      .prepare(
        `INSERT INTO run_execution_contexts (
           run_id, session_id, workspace_id, execution_mode, execution_root, git_common_dir,
           branch_context_id, created_at
         ) VALUES (?, ?, ?, 'bound-root', ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(
        RUN_ID,
        SESSION_ID,
        workspaceId,
        gitFixtures.repositoryRoot,
        join(gitFixtures.repositoryRoot, ".git"),
        branchContextId,
      );
    expect(harness.workspaces.releaseBusy(workspaceId)).toBe(true);
    expect(requireWorkspaceRow(harness.db, workspaceId).state).toBe("ready");

    const error = await captureRejection(() =>
      harness.service.detach({ repoMountId: attached.repoMountId }),
    );

    expect(error).toBeInstanceOf(RepoDetachConflictError);
    expect((error as RepoDetachConflictError).runningSessionId).toBe(SESSION_ID);
    expect(requireMountRow(harness.db, attached.repoMountId).state).toBe("attached");
    expect(requireWorkspaceRow(harness.db, workspaceId).state).toBe("ready");
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
    expect(readLifecycleEventTypes(harness.db, SESSION_ID)).toEqual([
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

  it("announces the remaining dependents if one archived append fails, then rejects", async () => {
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
    expect(requireMountRow(harness.db, attached.repoMountId).state).toBe("detached");
    expect(requireWorkspaceRow(harness.db, firstWorkspaceId).state).toBe("archived");
    expect(requireWorkspaceRow(harness.db, secondWorkspaceId).state).toBe("archived");

    // Exactly one `workspace.archived` landed, for the second workspace, whose append ran after
    // the failure. That proves the loop continued.
    expect(readLifecycleEventTypes(harness.db, SESSION_ID)).toEqual([
      "workspace.preparing",
      "workspace.preparing",
      "workspace.archived",
    ]);
    const archivedEnvelopes = readLifecycleEnvelopes(harness.db, SESSION_ID).filter(
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
    expect(
      readLifecycleEventTypes(harness.db, SESSION_ID).filter(
        (type) => type === "workspace.archived",
      ),
    ).toHaveLength(1);
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
    expect(requireWorkspaceRow(harness.db, INJECTED_WORKSPACE_ID).state).toBe("archived");
    expect(readLifecycleEventTypes(harness.db, SESSION_ID)).toEqual(["workspace.archived"]);
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
    expect(readLifecycleEventTypes(harness.db, SESSION_ID)).toEqual(["workspace.preparing"]);
    // The compare-and-swap aborted the whole transaction, so the cascade's archive write rolled
    // back too.
    expect(requireWorkspaceRow(harness.db, workspaceId).state).toBe("preparing");
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
});
