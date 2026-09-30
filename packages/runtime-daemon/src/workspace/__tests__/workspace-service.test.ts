// WorkspaceService behavior, driven against a real temp-file SQLite database, the real
// `EventLogService` append path and real directories, so a vanished execution root is an
// actual `rmSync`.
//
// Test-only mechanisms reach states production code refuses to write or cannot be raced into:
//   * `PRAGMA ignore_check_constraints` plants an out-of-vocabulary `workspaces.state`.
//   * An injected `probePath` returns a probe the service did not build, to reach the
//     projector's subject-binding guard (the production probe stamps `probedPath` itself).
//   * Interference probes mutate the row or its mount before a seam resolves, so a
//     compare-and-swap race lands in one exact await window. Each arm names its window.
//
// Negative controls accompany guards that could otherwise pass vacuously: the redaction
// order, the reachability-before-containment order in `bind`, and stale-transition
// persistence.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WorkspaceListResponseSchema,
  WORKSPACE_LAST_ERROR_MAX_LEN,
  type ExecutionMode,
  type RepoMountId,
  type SessionId,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { DaemonDomainError } from "../../ipc/domain-error.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { openDatabase } from "../../session/migration-runner.js";
import { RepoMountNotFoundError, TrustEnvelopeViolationError } from "../repo-errors.js";
import { TrustEnvelopeValidator } from "../trust-envelope.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import type { FilesystemPathProbe } from "../workspace-projector.js";
import {
  normalizeWorkspaceLastError,
  scrubCredentials,
  truncateWorkspaceLastError,
  WorkspaceBusyError,
  WorkspaceModeUnsupportedError,
  WorkspaceNotFoundError,
  WorkspaceService,
  WorkspaceServiceInvariantError,
  WorkspaceStaleError,
  WORKSPACE_LAST_ERROR_TRUNCATION_MARKER,
  WORKSPACE_SERVICE_ERROR_CODES,
  type FilesystemPathProbeFn,
  type SessionExistenceReader,
  type WorkspaceServiceDeps,
} from "../workspace-service.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Real UUIDs, because every id crosses a branded UUID schema on some path; branded here so
// request shapes need no cast at each call site.
const SESSION_ID: SessionId = "0190f8b0-0000-7000-8000-000000000001" as SessionId;
const OTHER_SESSION_ID: SessionId = "0190f8b0-0000-7000-8000-000000000002" as SessionId;
const GIT_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000001" as RepoMountId;
const SECOND_GIT_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000002" as RepoMountId;
const DETACHED_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000004" as RepoMountId;
const FILE_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000005" as RepoMountId;
const UNKNOWN_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-00000000ffff" as RepoMountId;
const UNKNOWN_WORKSPACE_ID: string = "0190f8b2-0000-7000-8000-00000000ffff";
const RUN_ID: string = "0190f8b3-0000-7000-8000-000000000001";
const OTHER_RUN_ID: string = "0190f8b3-0000-7000-8000-000000000002";

// Real UUIDs for the injected id source; a counter would fail `WorkspaceIdSchema.parse`.
const WORKSPACE_ID_POOL: readonly string[] = [
  "0190f8b2-0000-7000-8000-000000000001",
  "0190f8b2-0000-7000-8000-000000000002",
  "0190f8b2-0000-7000-8000-000000000003",
  "0190f8b2-0000-7000-8000-000000000004",
  "0190f8b2-0000-7000-8000-000000000005",
  "0190f8b2-0000-7000-8000-000000000006",
];

/** Knows the one session this suite binds under; every other id names no session. */
const KNOWN_SESSIONS: SessionExistenceReader = {
  replay: (sessionId) => (sessionId === SESSION_ID ? { sessionId } : null),
};

/** What a bind the provisioner then completes appends, in order. */
const READY_BIND_EVENTS: readonly string[] = ["workspace.preparing", "workspace.ready"];

interface StoredWorkspaceRow {
  readonly id: string;
  readonly session_id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly state: string;
  readonly metadata: string;
}

interface TestHarness {
  readonly db: DatabaseType;
  readonly emitter: WorkspaceEventEmitter;
  readonly service: WorkspaceService;
  readonly tmpDir: string;
  readonly gitMountRoot: string;
  readonly secondGitMountRoot: string;
  readonly siblingRoot: string;
}

let harness: TestHarness;

/** Builds a service over the harness database, optionally overriding one seam. */
function createService(overrides: Partial<WorkspaceServiceDeps> = {}): WorkspaceService {
  return new WorkspaceService({
    database: harness.db,
    events: harness.emitter,
    sessions: KNOWN_SESSIONS,
    newWorkspaceId: makeWorkspaceIdSource(),
    ...overrides,
  });
}

function makeWorkspaceIdSource(): () => string {
  let index: number = 0;
  return () => {
    const workspaceId = WORKSPACE_ID_POOL[index];
    if (workspaceId === undefined) {
      throw new Error("workspace id pool exhausted; add more UUIDs to WORKSPACE_ID_POOL");
    }
    index += 1;
    return workspaceId;
  };
}

interface MountFixture {
  readonly id: string;
  readonly canonicalRoot: string;
  readonly state?: string;
}

function insertMount(fixture: MountFixture): void {
  const now = new Date().toISOString();
  harness.db
    .prepare(
      `INSERT INTO repo_mounts (
         id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at, metadata
       ) VALUES (@id, @node_id, @local_path, @canonical_root, 'git', @state, @now, @now, '{}')`,
    )
    .run({
      id: fixture.id,
      node_id: "node-local",
      local_path: fixture.canonicalRoot,
      canonical_root: fixture.canonicalRoot,
      state: fixture.state ?? "attached",
      now,
    });
}

/** Binds a bound-root workspace and completes it onto the mount's own root, leaving `ready`. */
async function bindReady(repoMountId: RepoMountId, mountRoot: string): Promise<string> {
  const bound = await harness.service.bind({
    sessionId: SESSION_ID,
    repoMountId,
    executionMode: "bound-root",
  });
  await harness.service.completeRootPreparation(bound.workspaceId, mountRoot);
  return bound.workspaceId;
}

function readWorkspaceRow(workspaceId: string): StoredWorkspaceRow | undefined {
  return harness.db
    .prepare(
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata
         FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as StoredWorkspaceRow | undefined;
}

function countRows(table: "workspaces" | "repo_mounts"): number {
  const statement = harness.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`);
  return (statement.get() as { readonly total: number }).total;
}

function readEventTypes(sessionId: string = SESSION_ID): readonly string[] {
  return (
    harness.db
      .prepare("SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence ASC")
      .all(sessionId) as ReadonlyArray<{ readonly type: string }>
  ).map((row) => row.type);
}

function readWorkspaceMetadata(workspaceId: string): Record<string, unknown> {
  const row = readWorkspaceRow(workspaceId);
  if (row === undefined) {
    throw new Error(`workspace ${workspaceId} is absent; the caller expected a row`);
  }
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

/** Run `body` and return whatever it threw, so an arm can assert on the carrier. */
async function captureRejection(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to reject, but it resolved");
}

/**
 * Plants a row shape the schema's CHECK constraints refuse, for one statement. The projector's
 * fail-closed guards are unreachable any other way.
 */
function withCheckConstraintsDisabled(mutate: () => void): void {
  harness.db.pragma("ignore_check_constraints = ON");
  try {
    mutate();
  } finally {
    harness.db.pragma("ignore_check_constraints = OFF");
  }
}

/** A probe seam that reports having measured a path other than the one asked for. */
function mispairedProbe(probedPathOverride: string): FilesystemPathProbeFn {
  return (_path: string) =>
    Promise.resolve({
      probedPath: probedPathOverride,
      reachable: true,
      checkedAt: "2026-08-04T00:00:00.000Z",
    } satisfies FilesystemPathProbe);
}

/**
 * A probe seam that runs `interfere()` once before answering truthfully. `#observeState`
 * awaits this probe, so the write lands after the service read the row and before it acts on
 * that read. Later calls answer normally.
 */
function interferingProbe(interfere: () => void, reachable: boolean): FilesystemPathProbeFn {
  let fired = false;
  return (path: string) => {
    if (!fired) {
      fired = true;
      interfere();
    }
    return Promise.resolve({
      probedPath: path,
      reachable,
      checkedAt: "2026-08-04T00:00:00.000Z",
    } satisfies FilesystemPathProbe);
  };
}

/** Plant a state directly, with no event — a stand-in for another connection's write. */
function forceWorkspaceState(workspaceId: string, state: WorkspaceState): void {
  harness.db.prepare("UPDATE workspaces SET state = ? WHERE id = ?").run(state, workspaceId);
}

function readEventPayloads(type: string): ReadonlyArray<Record<string, unknown>> {
  const rows = harness.db
    .prepare(
      "SELECT payload FROM session_events WHERE session_id = ? AND type = ? ORDER BY sequence ASC",
    )
    .all(SESSION_ID, type) as ReadonlyArray<{ readonly payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

/** One instance of each error carrier the service raises. */
function everyCarrier(): readonly DaemonDomainError[] {
  return [
    new WorkspaceNotFoundError(UNKNOWN_WORKSPACE_ID),
    new WorkspaceModeUnsupportedError("provisioned-worktree", ["bound-root"], "no worktree"),
    new WorkspaceStaleError(UNKNOWN_WORKSPACE_ID),
    new WorkspaceBusyError(UNKNOWN_WORKSPACE_ID, RUN_ID),
  ];
}

// ----------------------------------------------------------------------------
// Per-test lifecycle
// ----------------------------------------------------------------------------

beforeEach(async () => {
  // Canonicalized with the validator's own `realpath`: on macOS `os.tmpdir()` sits under the
  // `/var` symlink, and an uncanonicalized root would turn every bind into a spurious
  // `repo.outside_trust_envelope`.
  const tmpDir: string = await realpath(
    await mkdtemp(join(tmpdir(), "ai-sidekicks-workspace-service-test-")),
  );
  const db: DatabaseType = openDatabase(join(tmpDir, "test.db"));
  const emitter = new WorkspaceEventEmitter({
    sessionEvents: new EventLogService({
      db,
    }),
  });

  // `gitMountRoot` has a real subdirectory for `directory` to resolve to. `siblingRoot`
  // exists so the traversal arm fails on containment rather than on absence.
  const gitMountRoot: string = join(tmpDir, "repos", "git-mount");
  const secondGitMountRoot: string = join(tmpDir, "repos", "second-git-mount");
  const siblingRoot: string = join(tmpDir, "repos", "sibling");
  for (const directory of [gitMountRoot, secondGitMountRoot, siblingRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  mkdirSync(join(gitMountRoot, "packages"), { recursive: true });

  harness = {
    db,
    emitter,
    service: new WorkspaceService({
      database: db,
      events: emitter,
      sessions: KNOWN_SESSIONS,
      newWorkspaceId: makeWorkspaceIdSource(),
    }),
    tmpDir,
    gitMountRoot,
    secondGitMountRoot,
    siblingRoot,
  };
});

afterEach(() => {
  // The per-session append lock is a module singleton; a leftover queue entry would stall the
  // next case on the same session id.
  __resetSessionAppendLocksForTest();
  harness.db.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// bind
// ----------------------------------------------------------------------------

describe("bind", () => {
  beforeEach(() => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    insertMount({
      id: DETACHED_MOUNT_ID,
      canonicalRoot: harness.secondGitMountRoot,
      state: "detached",
    });
  });

  it("has a canonical fixture root, so a containment refusal is about the boundary", async () => {
    // Without this, a containment refusal could just be the temp root disagreeing with its
    // own realpath.
    expect(await realpath(harness.gitMountRoot)).toBe(harness.gitMountRoot);
    expect(await realpath(harness.siblingRoot)).toBe(harness.siblingRoot);
  });

  it("refuses a session that does not exist, before any probe or write", async () => {
    // A valid, attached mount, so "nothing was written" discriminates.
    const probePath = vi.fn<FilesystemPathProbeFn>();

    const refusal = await captureRejection(() =>
      createService({ probePath }).bind({
        sessionId: OTHER_SESSION_ID,
        repoMountId: GIT_MOUNT_ID,
        executionMode: "bound-root",
      }),
    );

    expect(refusal).toBeInstanceOf(SessionNotFoundError);
    expect((refusal as SessionNotFoundError).code).toBe("session.not_found");
    expect((refusal as SessionNotFoundError).fields).toEqual({ sessionId: OTHER_SESSION_ID });
    expect(probePath).not.toHaveBeenCalled();
    expect(countRows("workspaces")).toBe(0);
    expect(readEventTypes(OTHER_SESSION_ID)).toEqual([]);
  });

  it("rejects a traversal escape on the `directory` argument", async () => {
    // The escape target exists on disk, so the refusal is containment, not absence.
    await expect(
      harness.service.bind({
        sessionId: SESSION_ID,
        repoMountId: GIT_MOUNT_ID,
        executionMode: "bound-root",
        directory: "../sibling",
      }),
    ).rejects.toBeInstanceOf(TrustEnvelopeViolationError);

    // The absolute-redirection spelling of the same escape.
    await expect(
      harness.service.bind({
        sessionId: SESSION_ID,
        repoMountId: GIT_MOUNT_ID,
        executionMode: "bound-root",
        directory: harness.siblingRoot,
      }),
    ).rejects.toBeInstanceOf(TrustEnvelopeViolationError);

    expect(countRows("workspaces")).toBe(0);
    expect(readEventTypes()).toEqual([]);
  });

  it("carries the ratified `repo.outside_trust_envelope` code on the refusal", async () => {
    const refusal = await captureRejection(() =>
      harness.service.bind({
        sessionId: SESSION_ID,
        repoMountId: GIT_MOUNT_ID,
        executionMode: "bound-root",
        directory: "../sibling",
      }),
    );

    expect(refusal).toBeInstanceOf(TrustEnvelopeViolationError);
    expect((refusal as TrustEnvelopeViolationError).code).toBe("repo.outside_trust_envelope");
    expect((refusal as TrustEnvelopeViolationError).httpStatus).toBe(403);
  });

  it("rejects an absolute directory pointing at a DETACHED mount's root", async () => {
    // A detached mount's root is outside both the attached set and the anchor; neither may
    // admit it.
    await expect(
      harness.service.bind({
        sessionId: SESSION_ID,
        repoMountId: GIT_MOUNT_ID,
        executionMode: "bound-root",
        directory: harness.secondGitMountRoot,
      }),
    ).rejects.toBeInstanceOf(TrustEnvelopeViolationError);
  });

  it("lands every bind in `preparing` with no root, a valid directory included", async () => {
    const response = await harness.service.bind({
      sessionId: SESSION_ID,
      repoMountId: GIT_MOUNT_ID,
      executionMode: "provisioned-worktree",
      directory: "packages",
    });

    expect(response.state).toBe("preparing" satisfies WorkspaceState);

    const row = readWorkspaceRow(response.workspaceId);
    expect(row?.state).toBe("preparing" satisfies WorkspaceState);
    // The validated root is discarded: neither mode executes in the requested directory, and
    // storing it would hand an approval scope the workspace never uses.
    expect(row?.fs_root).toBeNull();
    expect(row?.execution_mode).toBe("provisioned-worktree" satisfies ExecutionMode);
    expect(row?.session_id).toBe(SESSION_ID);
    expect(readEventTypes()).toEqual(["workspace.preparing"]);
  });

  // -- Mount identity before envelope construction --

  it("refuses an unknown mount id with `repo.not_found`", async () => {
    const refusal = await captureRejection(() =>
      harness.service.bind({
        sessionId: SESSION_ID,
        repoMountId: UNKNOWN_MOUNT_ID,
        executionMode: "bound-root",
      }),
    );

    expect(refusal).toBeInstanceOf(RepoMountNotFoundError);
    expect((refusal as RepoMountNotFoundError).code).toBe("repo.not_found");
  });

  it("refuses a DETACHED mount id with `repo.not_found`, not an envelope violation", async () => {
    const refusal = await captureRejection(() =>
      harness.service.bind({
        sessionId: SESSION_ID,
        repoMountId: DETACHED_MOUNT_ID,
        executionMode: "bound-root",
      }),
    );

    // Discriminating: with the envelope query unscoped this bind would succeed; with the
    // not-found check absent the caller would get a 403 `repo.outside_trust_envelope` for
    // using a stale bookmark.
    expect(refusal).toBeInstanceOf(RepoMountNotFoundError);
    expect(refusal).not.toBeInstanceOf(TrustEnvelopeViolationError);
    expect((refusal as RepoMountNotFoundError).code).toBe("repo.not_found");
    expect((refusal as RepoMountNotFoundError).httpStatus).toBe(404);
  });

  // -- The mid-flight detach window --

  it("refuses a bind whose mount is detached DURING the containment await", async () => {
    // Window: `bind` reads the mount, then awaits a filesystem probe and the containment
    // validator. A detach landing there moves the mount's `state` without deleting the row, so
    // the foreign key does not help. Without the insert's attachment predicate this commits a
    // workspace on a detached mount that the detach cascade never archives.
    const validator = new TrustEnvelopeValidator();
    const validateExecutionRootOriginal = validator.validateExecutionRoot.bind(validator);
    vi.spyOn(validator, "validateExecutionRoot").mockImplementationOnce(async (candidate) => {
      const resolved = await validateExecutionRootOriginal(candidate);
      harness.db
        .prepare("UPDATE repo_mounts SET state = 'detached' WHERE id = ?")
        .run(GIT_MOUNT_ID);
      return resolved;
    });

    await expect(
      createService({ trustEnvelope: validator }).bind({
        sessionId: SESSION_ID,
        repoMountId: GIT_MOUNT_ID,
        executionMode: "bound-root",
      }),
    ).rejects.toBeInstanceOf(WorkspaceServiceInvariantError);

    // The whole write rolled back: no orphan row and no `workspace.preparing` event.
    expect(countRows("workspaces")).toBe(0);
    expect(readEventTypes()).toEqual([]);
  });

  it("positive control: the same seam without the detach binds normally", async () => {
    // Proves the refusal above comes from the detach, not from the injected validator or spy.
    const validator = new TrustEnvelopeValidator();
    const validateExecutionRootOriginal = validator.validateExecutionRoot.bind(validator);
    vi.spyOn(validator, "validateExecutionRoot").mockImplementationOnce((candidate) =>
      validateExecutionRootOriginal(candidate),
    );

    const response = await createService({ trustEnvelope: validator }).bind({
      sessionId: SESSION_ID,
      repoMountId: GIT_MOUNT_ID,
      executionMode: "bound-root",
    });

    expect(response.state).toBe("preparing" satisfies WorkspaceState);
    expect(countRows("workspaces")).toBe(1);
    expect(readEventTypes()).toEqual(["workspace.preparing"]);
  });

  // -- Reachability before containment --

  it("reports a vanished mount root as `workspace.stale`, not a 403", async () => {
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    const refusal = await captureRejection(() =>
      harness.service.bind({
        sessionId: SESSION_ID,
        repoMountId: GIT_MOUNT_ID,
        executionMode: "bound-root",
      }),
    );

    expect(refusal).toBeInstanceOf(WorkspaceStaleError);
    expect((refusal as WorkspaceStaleError).code).toBe("workspace.stale");
    expect((refusal as WorkspaceStaleError).httpStatus).toBe(409);
    expect(refusal).not.toBeInstanceOf(TrustEnvelopeViolationError);
  });

  it("negative control: the validator alone calls the same vanished root a 403", async () => {
    // The paired observation: with containment first, `realpath` cannot resolve a missing
    // path, so the validator refuses it as unprovable. That is the wrong answer for an
    // unmounted volume, and is what `bind` would return if its probe ran second.
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    const refusal = await captureRejection(() =>
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: harness.gitMountRoot,
        attachedMountRoots: [harness.gitMountRoot],
      }),
    );

    expect(refusal).toBeInstanceOf(TrustEnvelopeViolationError);
    expect((refusal as TrustEnvelopeViolationError).httpStatus).toBe(403);
  });

  it("refuses a bind whose mount root is a file rather than a directory", async () => {
    const filePath = join(harness.tmpDir, "repos", "not-a-directory");
    writeFileSync(filePath, "");
    insertMount({ id: FILE_MOUNT_ID, canonicalRoot: filePath });

    // The probe opens the path for enumeration, so a regular file is unreachable like a
    // missing directory.
    await expect(
      harness.service.bind({
        sessionId: SESSION_ID,
        repoMountId: FILE_MOUNT_ID,
        executionMode: "bound-root",
      }),
    ).rejects.toBeInstanceOf(WorkspaceStaleError);
  });
});

// ----------------------------------------------------------------------------
// list — the on-read floor, and the four per-row throw sources
// ----------------------------------------------------------------------------

describe("list", () => {
  beforeEach(() => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    insertMount({ id: SECOND_GIT_MOUNT_ID, canonicalRoot: harness.secondGitMountRoot });
  });

  it("returns every workspace across two mounts with its state", async () => {
    const first = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
    const second = await harness.service.bind({
      sessionId: SESSION_ID,
      repoMountId: GIT_MOUNT_ID,
      executionMode: "provisioned-worktree",
    });
    const third = await bindReady(SECOND_GIT_MOUNT_ID, harness.secondGitMountRoot);

    const response = await harness.service.list({ sessionId: SESSION_ID });
    expect(response.workspaces).toHaveLength(3);
    expect(new Map(response.workspaces.map((entry) => [String(entry.id), entry.state]))).toEqual(
      new Map([
        [first, "ready"],
        [String(second.workspaceId), "preparing"],
        [third, "ready"],
      ]),
    );
    expect(new Set(response.workspaces.map((entry) => String(entry.repoMountId)))).toEqual(
      new Set([String(GIT_MOUNT_ID), String(SECOND_GIT_MOUNT_ID)]),
    );

    // Validates the outbound payload, so a projection that only satisfies TypeScript is not
    // enough.
    expect(() => WorkspaceListResponseSchema.parse(response)).not.toThrow();
  });

  it("scopes to one mount when asked, and to one session always", async () => {
    await harness.service.bind({
      sessionId: SESSION_ID,
      repoMountId: GIT_MOUNT_ID,
      executionMode: "bound-root",
    });
    const scoped = await harness.service.bind({
      sessionId: SESSION_ID,
      repoMountId: SECOND_GIT_MOUNT_ID,
      executionMode: "bound-root",
    });

    const byMount = await harness.service.list({
      sessionId: SESSION_ID,
      repoMountId: SECOND_GIT_MOUNT_ID,
    });
    expect(byMount.workspaces.map((entry) => String(entry.id))).toEqual([
      String(scoped.workspaceId),
    ]);

    const otherSession = await harness.service.list({ sessionId: OTHER_SESSION_ID });
    expect(otherSession.workspaces).toEqual([]);
  });

  it("reports and PERSISTS a stale transition when the root vanished", async () => {
    const workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    const first = await harness.service.list({ sessionId: SESSION_ID });
    expect(first.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    // Persistence half: a response-only verdict would leave the next reader, and
    // `assertWritable`, believing the row is still `ready`.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale");
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);

    // One event per real transition: a second read must not re-announce it.
    const second = await harness.service.list({ sessionId: SESSION_ID });
    expect(second.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);
  });

  it("never auto-heals a stale row when its root comes back", async () => {
    const workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
    rmSync(harness.gitMountRoot, { recursive: true, force: true });
    await harness.service.list({ sessionId: SESSION_ID });

    mkdirSync(harness.gitMountRoot, { recursive: true });
    const afterRepair = await harness.service.list({ sessionId: SESSION_ID });

    // Repair is an explicit reprovision, not a side effect of a read, matching
    // `computeWorkspaceHealth`.
    expect(afterRepair.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale");
  });

  // -- The four per-row throw sources. None may be silently dropped. --

  it("source 1: propagates an out-of-vocabulary state, attributed to its row", async () => {
    const workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
    withCheckConstraintsDisabled(() => {
      harness.db.prepare("UPDATE workspaces SET state = 'liquefied' WHERE id = ?").run(workspaceId);
    });

    const failure = await captureRejection(() => harness.service.list({ sessionId: SESSION_ID }));

    expect(failure).toBeInstanceOf(WorkspaceServiceInvariantError);
    const invariantFailure = failure as WorkspaceServiceInvariantError;
    expect(invariantFailure.kind).toBe("workspace_row_unprojectable");
    expect(invariantFailure.workspaceId).toBe(workspaceId);
    expect((invariantFailure.cause as Error).message).toContain("no probe policy is registered");
  });

  it("source 2: propagates a NULL execution root under a probe-bearing state", async () => {
    const workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
    harness.db.prepare("UPDATE workspaces SET fs_root = NULL WHERE id = ?").run(workspaceId);

    const failure = await captureRejection(() => harness.service.list({ sessionId: SESSION_ID }));

    expect(failure).toBeInstanceOf(WorkspaceServiceInvariantError);
    const invariantFailure = failure as WorkspaceServiceInvariantError;
    expect(invariantFailure.kind).toBe("workspace_row_unprojectable");
    expect(invariantFailure.workspaceId).toBe(workspaceId);
    expect((invariantFailure.cause as Error).message).toContain("must carry a resolved fs_root");
  });

  it("source 3: propagates a probe that measured a different path", async () => {
    const workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);

    // A lying probe seam is the only way to reach the subject-binding guard: the production
    // probe stamps `probedPath` from its own argument, and the service re-resolves nothing
    // between the row and the probe. A service that did re-resolve would fail this arm on
    // every row.
    const failure = await captureRejection(() =>
      createService({ probePath: mispairedProbe(harness.secondGitMountRoot) }).list({
        sessionId: SESSION_ID,
      }),
    );

    expect(failure).toBeInstanceOf(WorkspaceServiceInvariantError);
    const invariantFailure = failure as WorkspaceServiceInvariantError;
    expect(invariantFailure.kind).toBe("workspace_row_unprojectable");
    expect(invariantFailure.workspaceId).toBe(workspaceId);
    expect((invariantFailure.cause as Error).message).toContain(
      "did not measure the workspace's execution root",
    );
  });

  it("source 4: propagates an unrepresentable identifier", async () => {
    // `workspaces.id` carries no format constraint, so a corrupt id needs no pragma; this is
    // the most reachable of the four in practice.
    harness.db
      .prepare(
        `INSERT INTO workspaces (
           id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata,
           created_at, updated_at
         ) VALUES (
           'not-a-uuid', @session_id, @repo_mount_id, 'bound-root', @fs_root, 'ready', '{}',
           @now, @now
         )`,
      )
      .run({
        session_id: SESSION_ID,
        repo_mount_id: GIT_MOUNT_ID,
        fs_root: harness.gitMountRoot,
        now: new Date().toISOString(),
      });

    const failure = await captureRejection(() => harness.service.list({ sessionId: SESSION_ID }));

    expect(failure).toBeInstanceOf(WorkspaceServiceInvariantError);
    expect((failure as WorkspaceServiceInvariantError).kind).toBe("workspace_row_unprojectable");
    expect((failure as WorkspaceServiceInvariantError).workspaceId).toBe("not-a-uuid");
  });

  it("fifth failure: a stale write that cannot be made durable gets its OWN kind", async () => {
    const workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
    rmSync(harness.gitMountRoot, { recursive: true, force: true });
    vi.spyOn(harness.emitter, "emitWorkspaceStale").mockImplementationOnce(() =>
      Promise.reject(new Error("database is locked")),
    );

    const failure = await captureRejection(() => harness.service.list({ sessionId: SESSION_ID }));

    expect(failure).toBeInstanceOf(WorkspaceServiceInvariantError);
    const invariantFailure = failure as WorkspaceServiceInvariantError;
    // Not `workspace_row_unprojectable`: the row projected fine and the write of that
    // projection failed. The wrong label would send an operator to inspect a healthy row for
    // a locked database.
    expect(invariantFailure.kind).toBe("stale_transition_durability_failure");
    expect(invariantFailure.workspaceId).toBe(workspaceId);
    expect((invariantFailure.cause as Error).message).toBe("database is locked");
    // Not swallowed: reporting `stale` for a row the database still calls `ready` is what
    // the persistence half forbids.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
  });

  it("names the row whose root vanished as the stale event's SUBJECT", async () => {
    const healthy = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
    const doomed = await bindReady(SECOND_GIT_MOUNT_ID, harness.secondGitMountRoot);
    rmSync(harness.secondGitMountRoot, { recursive: true, force: true });

    await harness.service.list({ sessionId: SESSION_ID });

    // Other arms read event types only; an emit naming the wrong workspace would pass them
    // all while telling a timeline reader that a healthy workspace went stale.
    const stalePayloads = readEventPayloads("workspace.stale");
    expect(stalePayloads).toHaveLength(1);
    expect(stalePayloads[0]?.["workspaceId"]).toBe(doomed);
    expect(stalePayloads[0]?.["workspaceId"]).not.toBe(healthy);
    expect(readWorkspaceRow(healthy)?.state).toBe("ready" satisfies WorkspaceState);
  });

  it("never silently drops a corrupt row from an otherwise-healthy roster", async () => {
    const healthy = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
    const corrupted = await bindReady(SECOND_GIT_MOUNT_ID, harness.secondGitMountRoot);
    harness.db.prepare("UPDATE workspaces SET fs_root = NULL WHERE id = ?").run(corrupted);

    // The caller gets a loud failure, never a two-row roster that quietly became one; a
    // shortened list could lead an operator to detach a mount because the workspace blocking
    // it is no longer shown.
    await expect(harness.service.list({ sessionId: SESSION_ID })).rejects.toBeInstanceOf(
      WorkspaceServiceInvariantError,
    );
    expect(readWorkspaceRow(healthy)).toBeDefined();
    expect(countRows("workspaces")).toBe(2);
  });
});

// ----------------------------------------------------------------------------
// reprovision cycle
// ----------------------------------------------------------------------------

describe("reprovision cycle", () => {
  let workspaceId: string;

  beforeEach(async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
  });

  it("keeps the id and the row count across a full cycle", async () => {
    const rowsBefore = countRows("workspaces");
    const worktreeRoot = join(harness.tmpDir, "worktrees", "feature");
    mkdirSync(worktreeRoot, { recursive: true });

    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    const midCycle = readWorkspaceRow(workspaceId);
    expect(midCycle?.state).toBe("preparing" satisfies WorkspaceState);
    // The released root must not linger, or approvals would keep matching a root the
    // workspace no longer owns.
    expect(midCycle?.fs_root).toBeNull();
    // The target mode is persisted at begin because `completeRootPreparation` takes no mode
    // argument.
    expect(midCycle?.execution_mode).toBe("provisioned-worktree" satisfies ExecutionMode);

    await harness.service.completeRootPreparation(workspaceId, worktreeRoot);
    const afterCycle = readWorkspaceRow(workspaceId);

    // Same id, same row count, and a state that cycled rather than a row that was replaced.
    expect(afterCycle?.id).toBe(workspaceId);
    expect(countRows("workspaces")).toBe(rowsBefore);
    expect(afterCycle?.state).toBe("ready" satisfies WorkspaceState);
    expect(afterCycle?.fs_root).toBe(worktreeRoot);
    expect(readEventTypes()).toEqual([
      ...READY_BIND_EVENTS,
      "workspace.preparing",
      "workspace.ready",
    ]);
  });

  it("adopts an execution root OUTSIDE the mount, without re-checking containment", async () => {
    // A worktree lives outside the mount's canonical root by construction, so re-running
    // containment here would reject the mode it exists to support. The root's legitimacy is
    // its provenance: the provisioner created it under daemon control.
    const outsideRoot = join(harness.tmpDir, "worktrees", "outside");
    mkdirSync(outsideRoot, { recursive: true });

    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    await harness.service.completeRootPreparation(workspaceId, outsideRoot);

    expect(readWorkspaceRow(workspaceId)?.fs_root).toBe(outsideRoot);
  });

  it("refuses an execution root that does not name one complete location", async () => {
    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");

    // Provenance does not make an incomplete path safe: approvals are scoped against this
    // value, and each shape below lacks a piece only the daemon's context could supply (a
    // working directory, a home directory, a drive).
    for (const incompleteRoot of ["worktrees/relative", "~/worktrees", "\\worktrees\\app"]) {
      const refusal = await captureRejection(() =>
        harness.service.completeRootPreparation(workspaceId, incompleteRoot),
      );
      expect(refusal).toBeInstanceOf(WorkspaceServiceInvariantError);
      expect((refusal as WorkspaceServiceInvariantError).kind).toBe("non_absolute_execution_root");
    }
    // Refused before the write, so the cycle stays open and retryable.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("preparing" satisfies WorkspaceState);
    expect(readWorkspaceRow(workspaceId)?.fs_root).toBeNull();

    // Negative control: a guard that refused everything would pass the loop above. The check
    // reads path shape only, so the Windows forms pass on a POSIX host too.
    const completeRoots = ["/repos/app", "C:\\repos\\app", "C:/repos/app", "\\\\server\\share"];
    for (const completeRoot of completeRoots) {
      await harness.service.completeRootPreparation(workspaceId, completeRoot);
      expect(readWorkspaceRow(workspaceId)?.fs_root).toBe(completeRoot);
      await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    }
  });

  it("records a scrubbed failure detail and lands the row `stale`", async () => {
    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    await harness.service.failRootPreparation(
      workspaceId,
      "fatal: could not read from https://octocat:ghp_abcdefghijklmnop@github.com/acme/repo.git",
    );

    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);

    const lastError = readWorkspaceMetadata(workspaceId)["lastError"];
    expect(typeof lastError).toBe("string");
    expect(lastError).not.toContain("ghp_abcdefghijklmnop");
    expect(lastError).not.toContain("octocat:");
    // The diagnostic survives redaction; a scrubber that ate the message would pass the
    // assertions above.
    expect(lastError).toContain("fatal: could not read from");
    expect(readEventTypes()).toEqual([
      ...READY_BIND_EVENTS,
      "workspace.preparing",
      "workspace.stale",
    ]);
  });

  it("surfaces the recorded failure on the list response", async () => {
    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    await harness.service.failRootPreparation(workspaceId, "fatal: worktree add failed (exit 128)");

    const response = await harness.service.list({ sessionId: SESSION_ID });
    expect(response.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(response.workspaces[0]?.lastError).toContain("worktree add failed");
    // Persisted and representable: the pairing the `lastError` cap exists for.
    expect(() => WorkspaceListResponseSchema.parse(response)).not.toThrow();
  });

  it("retries from `stale`, and clears the previous failure on success", async () => {
    const worktreeRoot = join(harness.tmpDir, "worktrees", "retry");
    mkdirSync(worktreeRoot, { recursive: true });

    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    await harness.service.failRootPreparation(workspaceId, "fatal: first attempt failed");
    expect(readWorkspaceMetadata(workspaceId)["lastError"]).toBeDefined();

    // A failed switch leaves the row `stale`, and the switch may be retried; a gate that
    // refused `stale` would make retry impossible.
    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");

    // Mid-retry, `lastError` must already be cleared: it is present only when the workspace
    // went `stale` from a recorded failure, and a `preparing` row is not that. Clearing only
    // at completion would advertise the previous attempt's failure for the whole retry, and a
    // `markStale` from here would land a `stale` row carrying a superseded detail.
    expect(readWorkspaceMetadata(workspaceId)["lastError"]).toBeUndefined();
    const midRetry = await harness.service.list({ sessionId: SESSION_ID });
    expect(midRetry.workspaces[0]?.state).toBe("preparing" satisfies WorkspaceState);
    expect(midRetry.workspaces[0]?.lastError).toBeUndefined();

    await harness.service.completeRootPreparation(workspaceId, worktreeRoot);

    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    // A `ready` workspace must not keep advertising a failure that was fixed.
    expect(readWorkspaceMetadata(workspaceId)["lastError"]).toBeUndefined();
  });

  it("refuses to reprovision a held workspace with `workspace.busy`", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);

    const refusal = await captureRejection(() =>
      harness.service.beginRootPreparation(workspaceId, "provisioned-worktree"),
    );

    expect(refusal).toBeInstanceOf(WorkspaceBusyError);
    expect((refusal as WorkspaceBusyError).holdingRunId).toBe(RUN_ID);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("busy" satisfies WorkspaceState);
  });

  it("refuses to reprovision an archived workspace", async () => {
    harness.db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);

    const refusal = await captureRejection(() =>
      harness.service.beginRootPreparation(workspaceId, "provisioned-worktree"),
    );

    expect(refusal).toBeInstanceOf(WorkspaceServiceInvariantError);
    expect((refusal as WorkspaceServiceInvariantError).kind).toBe("illegal_state_transition");
  });

  it("refuses to complete or fail a cycle that was never begun", async () => {
    await expect(
      harness.service.completeRootPreparation(workspaceId, harness.gitMountRoot),
    ).rejects.toBeInstanceOf(WorkspaceServiceInvariantError);
    await expect(harness.service.failRootPreparation(workspaceId, "boom")).rejects.toBeInstanceOf(
      WorkspaceServiceInvariantError,
    );
    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(READY_BIND_EVENTS);
  });

  it("refuses an unknown workspace with `workspace.not_found`", async () => {
    const refusal = await captureRejection(() =>
      harness.service.beginRootPreparation(UNKNOWN_WORKSPACE_ID, "provisioned-worktree"),
    );

    expect(refusal).toBeInstanceOf(WorkspaceNotFoundError);
    expect((refusal as WorkspaceNotFoundError).code).toBe("workspace.not_found");
    expect((refusal as WorkspaceNotFoundError).httpStatus).toBe(404);
  });
});

// ----------------------------------------------------------------------------
// `metadata.lastError` — SCRUB before TRUNCATE
// ----------------------------------------------------------------------------

// Built rather than spelled: a literal NUL in source is invisible in review and breaks tools.
const NUL_CHARACTER: string = String.fromCharCode(0);

describe("lastError normalization", () => {
  // An opaque password inside a URL: no vendor prefix and no keyword, so only the userinfo
  // pattern can catch it. That makes the ordering observable: a truncation inside the userinfo
  // destroys the `@` anchor and the pattern stops matching.
  const OPAQUE_SECRET: string = "Xq7bT2mR9wLpZ4nC8vKd";
  const CREDENTIAL_URL: string = `https://deploy:${OPAQUE_SECRET}@git.internal/acme/repo.git`;

  /**
   * A detail whose credential straddles the truncation boundary: the cut lands inside the
   * secret with eleven of its characters kept and the trailing `@` removed, which
   * discriminates the two orderings.
   */
  function detailWithCredentialAtBoundary(): string {
    const filler = "x".repeat(WORKSPACE_LAST_ERROR_MAX_LEN - 40);
    return `${filler}${CREDENTIAL_URL} and then some trailing output`;
  }

  it("scrubs the credential before cutting, so no recognisable fragment survives", () => {
    const normalized = normalizeWorkspaceLastError(detailWithCredentialAtBoundary());

    expect(normalized).not.toBeNull();
    expect(normalized).toHaveLength(WORKSPACE_LAST_ERROR_MAX_LEN);
    expect(normalized).toContain(WORKSPACE_LAST_ERROR_TRUNCATION_MARKER);
    // Neither the whole secret nor any leading fragment: a truncated secret is still a
    // secret's prefix.
    expect(normalized).not.toContain(OPAQUE_SECRET);
    for (let prefixLength = 6; prefixLength <= OPAQUE_SECRET.length; prefixLength += 1) {
      expect(normalized).not.toContain(OPAQUE_SECRET.slice(0, prefixLength));
    }
  });

  it("negative control: cutting BEFORE scrubbing leaks a fragment of the same secret", () => {
    const raw = detailWithCredentialAtBoundary();

    // Composed from the same exported functions in the wrong order; reimplementing the
    // scrubber would prove the regexes work, not that this module orders its steps correctly.
    const wrongOrder = scrubCredentials(truncateWorkspaceLastError(raw));

    // The truncation removed the `@` that anchors the userinfo pattern, so what is left, a
    // live prefix of the secret, is no longer recognized.
    expect(wrongOrder).toContain(OPAQUE_SECRET.slice(0, 6));
    // The production order over the identical input does not leak it.
    expect(normalizeWorkspaceLastError(raw)).not.toContain(OPAQUE_SECRET.slice(0, 6));
  });

  it("scrubs the credential shapes a provisioning failure realistically carries", () => {
    // The vendor-prefixed suffixes are low-entropy, visibly fake stand-ins at or above the
    // pattern's `{8,}` bound. The pattern keys on the prefix, so they exercise what a real
    // token would, while real-format fixtures would trip every secret scanner that reads this
    // file (the pre-commit gitleaks gate and GitHub push protection).
    expect(scrubCredentials("remote: https://user:hunter2@example.com/x.git")).not.toContain(
      "hunter2",
    );
    expect(scrubCredentials("Authorization: Bearer abcdef0123456789")).not.toContain(
      "abcdef0123456789",
    );
    expect(scrubCredentials("x-access-token:ghs_aaaabbbbccccdddd")).not.toContain("ghs_");
    expect(scrubCredentials("token=glpat-aaaabbbbcccc")).not.toContain("glpat-");
    expect(scrubCredentials("leaked ghp_aaaabbbbccccdddd here")).not.toContain("ghp_");
    // Negative control: ordinary output survives, so a scrubber that redacted everything fails
    // here.
    expect(scrubCredentials("fatal: not a git repository")).toBe("fatal: not a git repository");
  });

  it("records NO lastError when nothing publishable survives", async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    const workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    await harness.service.failRootPreparation(workspaceId, "  \n\t   ");

    // `wireFreeFormString` requires `.min(1)`, one non-whitespace character and no NUL;
    // persisting an illegal value would make the list response that reports this failure
    // unrepresentable.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(workspaceId)["lastError"]).toBeUndefined();

    const response = await harness.service.list({ sessionId: SESSION_ID });
    expect(response.workspaces[0]?.lastError).toBeUndefined();
    expect(() => WorkspaceListResponseSchema.parse(response)).not.toThrow();
  });

  it("strips embedded NULs", () => {
    const normalized = normalizeWorkspaceLastError(`fatal:${NUL_CHARACTER} worktree add failed`);
    expect(normalized).toBe("fatal: worktree add failed");
    expect(normalized).not.toContain(NUL_CHARACTER);
  });

  it("strips the NUL BEFORE scrubbing, so a split token is not reassembled after", () => {
    // The fixture must be one whose anchor the NUL breaks. A NUL inside URL userinfo does not
    // qualify: NUL is not `\s`, so `[^\s/@]+` matches across it and both orderings redact
    // identically. `gh\0p_` is not `ghp_`, so the prefix pattern misses it.
    const splitToken = `fatal: remote rejected gh${NUL_CHARACTER}p_0123456789abcdefgh`;

    // Production order (strip, then scrub): the halves rejoin into a recognized token, which
    // is redacted.
    const normalized = normalizeWorkspaceLastError(splitToken);
    expect(normalized).not.toContain("ghp_");
    expect(normalized).not.toContain("0123456789abcdefgh");
    expect(normalized).toContain("fatal: remote rejected");

    // Negative control, the same functions in the wrong order: scrubbing first sees a token
    // that matches nothing, and the later strip reassembles a live credential.
    const wrongOrder = scrubCredentials(splitToken).replace(new RegExp(NUL_CHARACTER, "g"), "");
    expect(wrongOrder).toContain("ghp_0123456789abcdefgh");
  });

  it("records nothing when only whitespace survives the scrub, even over the cap", () => {
    // The emptiness test runs on the scrubbed value, not the truncated one: after truncation
    // an over-cap whitespace-only detail would pass, because the appended marker supplies the
    // only `\S`, and thousands of spaces plus `...[truncated]` would be persisted.
    const overCapWhitespace = " ".repeat(WORKSPACE_LAST_ERROR_MAX_LEN + 100);
    expect(normalizeWorkspaceLastError(overCapWhitespace)).toBeNull();
    // The under-cap leg of the same rule.
    expect(normalizeWorkspaceLastError("  \n\t   ")).toBeNull();
  });

  it("leaves a detail inside the cap untouched", () => {
    const short = "fatal: worktree add failed (exit 128)";
    expect(truncateWorkspaceLastError(short)).toBe(short);
    expect(normalizeWorkspaceLastError(short)).toBe(short);
  });

  it("never splits a surrogate pair at the cut", () => {
    // An emoji is two UTF-16 units; a naive cut at the cap can land between them and leave a
    // lone high surrogate, which `wireFreeFormString` would carry onto the wire.
    const emoji = "\u{1F680}";
    const fillerLength =
      WORKSPACE_LAST_ERROR_MAX_LEN - WORKSPACE_LAST_ERROR_TRUNCATION_MARKER.length - 1;
    const truncated = truncateWorkspaceLastError(`${"a".repeat(fillerLength)}${emoji.repeat(20)}`);

    expect(truncated.length).toBeLessThanOrEqual(WORKSPACE_LAST_ERROR_MAX_LEN);
    const body = truncated.slice(0, -WORKSPACE_LAST_ERROR_TRUNCATION_MARKER.length);
    const lastUnit = body.charCodeAt(body.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// assertWritable
// ----------------------------------------------------------------------------

describe("assertWritable", () => {
  let workspaceId: string;

  beforeEach(async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
  });

  it("passes a ready workspace", async () => {
    await expect(harness.service.assertWritable(workspaceId)).resolves.toBeUndefined();
    // The gate observed the row; it did not change it.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(READY_BIND_EVENTS);
  });

  it("throws the typed `workspace.stale` refusal for a stale workspace", async () => {
    harness.db.prepare("UPDATE workspaces SET state = 'stale' WHERE id = ?").run(workspaceId);

    const refusal = await captureRejection(() => harness.service.assertWritable(workspaceId));

    expect(refusal).toBeInstanceOf(WorkspaceStaleError);
    expect((refusal as WorkspaceStaleError).code).toBe("workspace.stale");
    expect((refusal as WorkspaceStaleError).httpStatus).toBe(409);
    expect((refusal as WorkspaceStaleError).workspaceId).toBe(workspaceId);
  });

  it("catches a root that vanished since the last read, and persists the transition", async () => {
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    await expect(harness.service.assertWritable(workspaceId)).rejects.toBeInstanceOf(
      WorkspaceStaleError,
    );
    // The refusal is not a private verdict: the next reader sees the row stale too.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);
  });

  it("passes a busy workspace, leaving the precise refusal to the hold primitive", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    // Duplicating `workspace.busy` here would refuse a caller that never contends for the
    // hold.
    await expect(harness.service.assertWritable(workspaceId)).resolves.toBeUndefined();
  });

  it("refuses provisioning and archived workspaces as internal invariant failures", async () => {
    harness.db.prepare("UPDATE workspaces SET state = 'preparing' WHERE id = ?").run(workspaceId);
    const provisioningRefusal = await captureRejection(() =>
      harness.service.assertWritable(workspaceId),
    );
    // No registered `workspace.*` code names either state, so these reach the wire as
    // anonymous internal errors.
    expect(provisioningRefusal).toBeInstanceOf(WorkspaceServiceInvariantError);
    expect((provisioningRefusal as WorkspaceServiceInvariantError).kind).toBe(
      "illegal_state_transition",
    );

    harness.db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
    await expect(harness.service.assertWritable(workspaceId)).rejects.toBeInstanceOf(
      WorkspaceServiceInvariantError,
    );
  });

  it("refuses an unknown workspace with `workspace.not_found`", async () => {
    await expect(harness.service.assertWritable(UNKNOWN_WORKSPACE_ID)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
  });
});

// ----------------------------------------------------------------------------
// markBusy / releaseBusy / markStale — and the busy -> stale decision
// ----------------------------------------------------------------------------

describe("run holds", () => {
  let workspaceId: string;

  beforeEach(async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    workspaceId = await bindReady(GIT_MOUNT_ID, harness.gitMountRoot);
  });

  it("takes the hold WITHOUT emitting an event (closed event registry)", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);

    expect(readWorkspaceRow(workspaceId)?.state).toBe("busy" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBe(RUN_ID);
    // `busy` is deliberately outside the six-type event registry; the run's own `run.*`
    // events carry the hold's timeline visibility.
    expect(readEventTypes()).toEqual(READY_BIND_EVENTS);
  });

  it("refuses a second holder with `workspace.busy`, naming the incumbent", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);

    const refusal = await captureRejection(() =>
      harness.service.markBusy(workspaceId, OTHER_RUN_ID),
    );

    expect(refusal).toBeInstanceOf(WorkspaceBusyError);
    expect((refusal as WorkspaceBusyError).code).toBe("workspace.busy");
    expect((refusal as WorkspaceBusyError).httpStatus).toBe(409);
    // The loser's only repair affordance: `repo.detach_conflict` names the blocking
    // workspaces, and nothing else names who holds them.
    expect((refusal as WorkspaceBusyError).holdingRunId).toBe(RUN_ID);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBe(RUN_ID);
  });

  it("refuses to take a hold on a vanished root, and persists the stale transition", async () => {
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    await expect(harness.service.markBusy(workspaceId, RUN_ID)).rejects.toBeInstanceOf(
      WorkspaceStaleError,
    );
    // Taking the hold first and finding out mid-run would be worse.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBeUndefined();
    // The hold itself emits nothing, but the on-read floor it drove emits a real
    // `workspace.stale`, so "no event for the hold" is not "no event at all".
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);
  });

  it("releases the hold and clears the attribution, still with no event", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    expect(harness.service.releaseBusy(workspaceId)).toBe(true);

    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBeUndefined();
    expect(readEventTypes()).toEqual(READY_BIND_EVENTS);
  });

  it("treats a double release as a benign no-op", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    expect(harness.service.releaseBusy(workspaceId)).toBe(true);
    // The call site is a `finally`; throwing there would replace the run's real failure with a
    // bookkeeping complaint.
    expect(harness.service.releaseBusy(workspaceId)).toBe(false);
    expect(harness.service.releaseBusy(UNKNOWN_WORKSPACE_ID)).toBe(false);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
  });

  // -- `busy -> stale` is legal and IS persisted --

  it("stales a HELD workspace whose root vanished mid-run", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    const response = await harness.service.list({ sessionId: SESSION_ID });

    // Refusing this transition would hide exactly the rows doing damage: a live run writing
    // into a root that no longer exists.
    expect(response.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);
    // A stale workspace is held by nobody; a lingering id would let a later refusal name a
    // run that is long gone.
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBeUndefined();
  });

  it("does not let a release auto-heal a workspace that went stale mid-run", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    rmSync(harness.gitMountRoot, { recursive: true, force: true });
    await harness.service.list({ sessionId: SESSION_ID });

    // Releasing is not a health verdict.
    expect(harness.service.releaseBusy(workspaceId)).toBe(false);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
  });

  it("markStale is idempotent and terminal-safe", async () => {
    expect(await harness.service.markStale(workspaceId)).toBe(true);
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);

    // Already stale: no second transition, so no second event.
    expect(await harness.service.markStale(workspaceId)).toBe(false);
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);

    // Archived is terminal; nothing resurrects it into `stale`.
    harness.db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
    expect(await harness.service.markStale(workspaceId)).toBe(false);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("archived");

    // An absent workspace is a no-op, not a throw: every read path drives this.
    expect(await harness.service.markStale(UNKNOWN_WORKSPACE_ID)).toBe(false);
  });

  // -- Two readers racing ONE stale transition --

  it("appends exactly ONE workspace.stale when a second reader wins the race", async () => {
    // Window: `markStale` reads the row, sees a live state, and only then opens the append. A
    // reader that stales the row in between makes this call's compare-and-swap match nothing.
    // The append path inserts its event row unconditionally once the prelude returns, so
    // declining has to be a throw; a prelude that only flagged "no row matched" would commit a
    // second `workspace.stale` for one real transition.
    const concurrentReader = createService();
    const concurrentOutcomes: boolean[] = [];
    const emitStaleOriginal = harness.emitter.emitWorkspaceStale.bind(harness.emitter);
    vi.spyOn(harness.emitter, "emitWorkspaceStale").mockImplementationOnce(async (input) => {
      concurrentOutcomes.push(await concurrentReader.markStale(workspaceId));
      return emitStaleOriginal(input);
    });

    const lostTheRace = await harness.service.markStale(workspaceId);

    // The winner wrote and announced its transition; the loser wrote and announced nothing and
    // returns false.
    expect(concurrentOutcomes).toEqual([true]);
    expect(lostTheRace).toBe(false);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);
  });

  it("declines before the append when the row was already staled by another reader", async () => {
    // The other half of the rule, one step earlier: interference before `markStale`'s read is
    // caught by the already-stale guard, so no append opens. Both legs are needed: the guard
    // alone leaves the window open, and the throw alone would make every already-stale read pay
    // for a transaction it rolls back.
    const service = createService({
      probePath: interferingProbe(() => {
        forceWorkspaceState(workspaceId, "stale");
      }, false),
    });

    const response = await service.list({ sessionId: SESSION_ID });

    expect(response.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(READY_BIND_EVENTS);
  });

  // -- markBusy losing its compare-and-swap, one arm per re-read verdict --

  it("answers a lost hold race with the REASON, not the mechanism", async () => {
    // Window: `markBusy` observes `ready` through the probe, then runs its compare-and-swap.
    // Interference inside the probe lands between the two, so the swap matches nothing and the
    // re-read decides what to report. These branches are unreachable from a single-threaded
    // suite otherwise.
    const takenByAnother = createService({
      probePath: interferingProbe(() => {
        harness.db
          .prepare(
            `UPDATE workspaces
                SET state = 'busy', metadata = json_set(metadata, '$.holdingRunId', ?)
              WHERE id = ?`,
          )
          .run(OTHER_RUN_ID, workspaceId);
      }, true),
    });

    const refusal = await captureRejection(() => takenByAnother.markBusy(workspaceId, RUN_ID));

    expect(refusal).toBeInstanceOf(WorkspaceBusyError);
    // The re-read makes the answer actionable; "the swap changed zero rows" names nothing a
    // caller can chase.
    expect((refusal as WorkspaceBusyError).holdingRunId).toBe(OTHER_RUN_ID);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBe(OTHER_RUN_ID);
  });

  it("answers a lost hold race against a vanished row with `workspace.not_found`", async () => {
    const deletedUnderfoot = createService({
      probePath: interferingProbe(() => {
        harness.db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
      }, true),
    });

    await expect(deletedUnderfoot.markBusy(workspaceId, RUN_ID)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
  });

  it("answers a lost hold race against a staled row with `workspace.stale`", async () => {
    const staledUnderfoot = createService({
      probePath: interferingProbe(() => {
        forceWorkspaceState(workspaceId, "stale");
      }, true),
    });

    await expect(staledUnderfoot.markBusy(workspaceId, RUN_ID)).rejects.toBeInstanceOf(
      WorkspaceStaleError,
    );
  });

  it("answers a lost hold race against any other state as an internal invariant", async () => {
    const reprovisionedUnderfoot = createService({
      probePath: interferingProbe(() => {
        forceWorkspaceState(workspaceId, "preparing");
      }, true),
    });

    const refusal = await captureRejection(() =>
      reprovisionedUnderfoot.markBusy(workspaceId, RUN_ID),
    );

    // No registered `workspace.*` code names "went back to provisioning", so this reaches the
    // wire anonymously.
    expect(refusal).toBeInstanceOf(WorkspaceServiceInvariantError);
    expect((refusal as WorkspaceServiceInvariantError).kind).toBe("illegal_state_transition");
    expect(readWorkspaceRow(workspaceId)?.state).toBe("preparing" satisfies WorkspaceState);
  });
});

// ----------------------------------------------------------------------------
// error carriers
// ----------------------------------------------------------------------------

describe("error carriers", () => {
  it("emit exactly WORKSPACE_SERVICE_ERROR_CODES — no orphan row, no invented code", () => {
    // Every carrier the helper enumerates mints a code the roster lists, and the roster lists
    // no code without a carrier.
    const emittedCodes = everyCarrier().map((carrier) => carrier.code);
    expect([...emittedCodes].sort()).toEqual([...WORKSPACE_SERVICE_ERROR_CODES].sort());
  });

  it("quote the registered codes and statuses", () => {
    expect(new WorkspaceNotFoundError(UNKNOWN_WORKSPACE_ID)).toMatchObject({
      code: "workspace.not_found",
      httpStatus: 404,
      // The one carrier with its own numeric code, matching `repo.not_found`.
      jsonRpcCode: -32602,
    });
    expect(new WorkspaceStaleError(UNKNOWN_WORKSPACE_ID)).toMatchObject({
      code: "workspace.stale",
      httpStatus: 409,
    });
    expect(new WorkspaceBusyError(UNKNOWN_WORKSPACE_ID, RUN_ID)).toMatchObject({
      code: "workspace.busy",
      httpStatus: 409,
    });
    expect(
      new WorkspaceModeUnsupportedError("provisioned-worktree", ["bound-root"], "no worktree"),
    ).toMatchObject({
      code: "workspace.mode_unsupported",
      httpStatus: 400,
    });

    // The other three take the mapper's `-32603` default rather than a numeric this module
    // selected, as `repo-errors.ts` does.
    expect(new WorkspaceStaleError(null).jsonRpcCode).toBeUndefined();
    expect(new WorkspaceBusyError(UNKNOWN_WORKSPACE_ID, null).jsonRpcCode).toBeUndefined();
    expect(
      new WorkspaceModeUnsupportedError("bound-root", ["provisioned-worktree"], "no bound root")
        .jsonRpcCode,
    ).toBeUndefined();
  });

  it("copies availableModes, so a later mutation cannot rewrite a thrown error", () => {
    // Like `RepoDetachConflictError`: both the own field and the wire `detail` hold copies, so
    // a caller that keeps mutating the array it passed (the capability matrix's
    // `availableModes` is a shared value) cannot change what an already-thrown refusal says it
    // offered.
    const availableModes: ExecutionMode[] = ["bound-root"];
    const refusal = new WorkspaceModeUnsupportedError(
      "provisioned-worktree",
      availableModes,
      "no worktree",
    );
    availableModes.push("provisioned-worktree");

    expect(refusal.availableModes).toEqual(["bound-root"]);
    expect(refusal.detail?.["availableModes"]).toEqual(["bound-root"]);
  });

  it("keeps no path in a stale refusal raised before a workspace exists", () => {
    const preBindRefusal = new WorkspaceStaleError(null);
    expect(preBindRefusal.workspaceId).toBeNull();
    expect(preBindRefusal.message).not.toContain("/");
    expect(preBindRefusal.detail).toEqual({});
  });

  it("carries no registered wire code on an internal invariant failure", () => {
    const invariantFailure = new WorkspaceServiceInvariantError("boom", {
      kind: "illegal_state_transition",
      workspaceId: UNKNOWN_WORKSPACE_ID,
      cause: new Error("root cause"),
    });

    // Deliberately not a `DaemonDomainError`: minting an unregistered `workspace.*` code is
    // banned, and borrowing a registered one would tell a caller to repair the wrong thing.
    expect(invariantFailure).toBeInstanceOf(Error);
    expect("code" in invariantFailure).toBe(false);
    expect(invariantFailure.name).toBe("WorkspaceServiceInvariantError");
    expect((invariantFailure.cause as Error).message).toBe("root cause");
  });
});
