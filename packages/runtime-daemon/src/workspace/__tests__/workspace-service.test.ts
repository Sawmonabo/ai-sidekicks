// WorkspaceService — Plan-009 Phase 2 T2.4.
//
// Drives the real service against a real temp-file SQLite database (canonical
// `openDatabase` factory → per-test tmp dir → `afterEach` close + unlink), a
// real `EventLogService` append path, and REAL directories on disk, so that
// "the execution root vanished" is an actual `rmSync` rather than a mocked
// verdict.
//
// Spec coverage: `Spec-009 §Default Behavior` (the default workspace is
// read-only and rooted at the mount's canonical root; a writable mode must be
// requested explicitly); `Spec-009 §Required Behavior` (binding is explicit and
// resolves ONE concrete execution root); `Spec-009 §Local Trust Envelope (V1
// Definition)` (traversal and out-of-envelope binding are refused);
// `Spec-009 §Execution Mode Transitions` (the
// reprovision cycle, its recorded failure detail, and its retry);
// `Spec-009 §Repo Mount Health (V1 Definition)` (the on-read probe floor and
// the stale transition it derives).
//
// Verifies invariant: I-009-3 (containment), I-009-6 (workspace-id stability
// across a mode switch), I-009-7 (stale is observable AND refuses writes),
// I-009-8 (no silent mode substitution), I-009-9 (one event per real
// transition, committed with its row).
//
// Cross-plan obligations exercised: CP-009-2, CP-009-3, CP-009-7, CP-009-8.
//
// Three deliberate test-only mechanisms, used ONLY to reach states the
// production code refuses to write or cannot be raced into on a single thread:
//   * `PRAGMA ignore_check_constraints` plants an out-of-vocabulary
//     `workspaces.state`. The column's CHECK makes that shape otherwise
//     unreachable, and the projector's positive-membership refusal exists
//     precisely for a row that reached the daemon past that constraint.
//   * An injected `probePath` returns a probe this service did not build. It is
//     the only way to reach the projector's subject-binding guard, because the
//     production probe stamps `probedPath` from its own argument.
//   * INTERFERENCE PROBES — a seam (`probePath`, `trustEnvelope`, the emitter)
//     that mutates the row or its mount BEFORE resolving, so the interleaving
//     lands in one exact await window. Every compare-and-swap in this service
//     exists for a race between two readers, and a race left to real
//     concurrency is either flaky or never reached; driving the interleaving
//     from a seam makes it deterministic. Each such arm names the window it
//     opens, because the window is the thing under test.
//
// Negative controls accompany the guards that could otherwise pass vacuously —
// the redaction ORDER, both bind orderings, and the stale-transition
// persistence each have an arm proving the wrong behaviour would be observable.

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
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
// A VALUE import, not a type-only one: the export census below tests
// `prototype instanceof DaemonDomainError` at runtime.
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { openDatabase } from "../../session/migration-runner.js";
import { RepoMountNotFoundError, TrustEnvelopeViolationError } from "../repo-errors.js";
import { TrustEnvelopeValidator } from "../trust-envelope.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import {
  computeExecutionModeCapabilities,
  type FilesystemPathProbe,
} from "../workspace-projector.js";
import type { WorkspaceServiceErrorCode } from "../workspace-service.js";
// Namespace import for the export census: it observes every export the module
// actually has, which a named list by construction cannot.
import * as workspaceServiceModule from "../workspace-service.js";
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
  type WorkspaceServiceDeps,
} from "../workspace-service.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Every id crosses a branded UUID schema on some path, so the fixtures are real
// UUIDs rather than opaque scalars — and they are branded here so the request
// shapes are satisfied without a cast at each call site.
const SESSION_ID: SessionId = "0190f8b0-0000-7000-8000-000000000001" as SessionId;
const OTHER_SESSION_ID: SessionId = "0190f8b0-0000-7000-8000-000000000002" as SessionId;
const GIT_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000001" as RepoMountId;
const SECOND_GIT_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000002" as RepoMountId;
const PLAIN_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000003" as RepoMountId;
const DETACHED_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000004" as RepoMountId;
const FILE_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000005" as RepoMountId;
const UNKNOWN_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-00000000ffff" as RepoMountId;
const UNKNOWN_WORKSPACE_ID: string = "0190f8b2-0000-7000-8000-00000000ffff";
const RUN_ID: string = "0190f8b3-0000-7000-8000-000000000001";
const OTHER_RUN_ID: string = "0190f8b3-0000-7000-8000-000000000002";

// Envelope linkage fixtures. Free-form on the wire (`wireFreeFormString`), so
// the shape is convention rather than schema — real ids, to match production.
const PARTICIPANT_ACTOR: string = "0190f8b4-0000-7000-8000-000000000001";
const ATTACH_CORRELATION_ID: string = "0190f8b5-0000-7000-8000-000000000001";

// A pool of real UUIDs for the injected id source. A counter would fail
// `WorkspaceIdSchema.parse`, which is exactly why that parse is there.
const WORKSPACE_ID_POOL: readonly string[] = [
  "0190f8b2-0000-7000-8000-000000000001",
  "0190f8b2-0000-7000-8000-000000000002",
  "0190f8b2-0000-7000-8000-000000000003",
  "0190f8b2-0000-7000-8000-000000000004",
  "0190f8b2-0000-7000-8000-000000000005",
  "0190f8b2-0000-7000-8000-000000000006",
];

const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(9) as Ed25519PrivateKey;

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
  readonly plainMountRoot: string;
  readonly siblingRoot: string;
}

let harness: TestHarness;

/**
 * Build a service over the harness database, optionally overriding one seam.
 *
 * The default construction injects no probe and no validator, so the default
 * arms measure real directories through the production primitives.
 */
function createService(overrides: Partial<WorkspaceServiceDeps> = {}): WorkspaceService {
  return new WorkspaceService({
    database: harness.db,
    events: harness.emitter,
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
  readonly sessionId?: string;
  readonly canonicalRoot: string;
  readonly vcsType?: string;
  readonly state?: string;
}

function insertMount(fixture: MountFixture): void {
  const now = new Date().toISOString();
  harness.db
    .prepare(
      `INSERT INTO repo_mounts (
         id, session_id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at, metadata
       ) VALUES (@id, @session_id, @node_id, @local_path, @canonical_root, @vcs_type, @state, @now, @now, '{}')`,
    )
    .run({
      id: fixture.id,
      session_id: fixture.sessionId ?? SESSION_ID,
      node_id: "node-local",
      local_path: fixture.canonicalRoot,
      canonical_root: fixture.canonicalRoot,
      vcs_type: fixture.vcsType ?? "git",
      state: fixture.state ?? "attached",
      now,
    });
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

function captureThrow(body: () => unknown): unknown {
  try {
    body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to throw, but it returned");
}

/**
 * Plant a row shape the schema's CHECK constraints refuse.
 *
 * Test-only, and scoped to a single statement: the corruption these arms
 * describe is exactly "a row that reached the daemon past its constraints", and
 * the projector's fail-closed guards have no other way to be reached.
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
 * A probe seam that runs `interfere()` ONCE before answering truthfully.
 *
 * The interleaving driver: `#observeState` awaits this probe, so whatever
 * `interfere` writes lands after the service read the row and before it acts on
 * that read. Later calls answer normally, so an arm that reads again afterwards
 * measures reality rather than the fixture.
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

interface StoredEventEnvelopeRow {
  readonly type: string;
  readonly actor: string | null;
  readonly correlation_id: string | null;
}

function readEventEnvelopes(): ReadonlyArray<StoredEventEnvelopeRow> {
  return harness.db
    .prepare(
      "SELECT type, actor, correlation_id FROM session_events WHERE session_id = ? ORDER BY sequence ASC",
    )
    .all(SESSION_ID) as ReadonlyArray<StoredEventEnvelopeRow>;
}

/** One instance of each carrier, in `error-contracts.md §Workspace` row order. */
function everyCarrier(): readonly DaemonDomainError[] {
  return [
    new WorkspaceNotFoundError(UNKNOWN_WORKSPACE_ID),
    new WorkspaceModeUnsupportedError("worktree", ["read-only"], "no git"),
    new WorkspaceStaleError(UNKNOWN_WORKSPACE_ID),
    new WorkspaceBusyError(UNKNOWN_WORKSPACE_ID, RUN_ID),
  ];
}

// ----------------------------------------------------------------------------
// Per-test lifecycle
// ----------------------------------------------------------------------------

beforeEach(async () => {
  // Canonicalized, and with the SAME primitive the validator's default seam
  // uses (`node:fs/promises.realpath`) — the precedent `trust-envelope.test.ts`
  // set for the same hazard. On macOS `os.tmpdir()` is `/var/folders/…`, and
  // `/var` is a symlink to `private/var`; an uncanonicalized fixture root would
  // make the validator's step-4 realpath disagree with the step-5 anchor and
  // turn EVERY bind here into a spurious `repo.outside_trust_envelope` — a
  // failure that would not reproduce on Linux CI, where `/tmp` is a real
  // directory.
  const tmpDir: string = await realpath(
    await mkdtemp(join(tmpdir(), "ai-sidekicks-workspace-service-test-")),
  );
  const db: DatabaseType = openDatabase(join(tmpDir, "test.db"));
  const emitter = new WorkspaceEventEmitter({
    sessionEvents: new EventLogService({
      db,
      signingKeySource: new FixedDaemonSigningKeySource(),
    }),
  });

  // Real directories. `gitMountRoot` carries a real subdirectory so the
  // `directory` argument has something legitimate to resolve to, and
  // `siblingRoot` EXISTS so the traversal arm fails on containment rather than
  // on absence — a rejection that only happened because the escape target was
  // missing would prove nothing about the boundary.
  const gitMountRoot: string = join(tmpDir, "repos", "git-mount");
  const secondGitMountRoot: string = join(tmpDir, "repos", "second-git-mount");
  const plainMountRoot: string = join(tmpDir, "repos", "plain-mount");
  const siblingRoot: string = join(tmpDir, "repos", "sibling");
  for (const directory of [gitMountRoot, secondGitMountRoot, plainMountRoot, siblingRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  mkdirSync(join(gitMountRoot, "packages"), { recursive: true });

  harness = {
    db,
    emitter,
    service: new WorkspaceService({
      database: db,
      events: emitter,
      newWorkspaceId: makeWorkspaceIdSource(),
    }),
    tmpDir,
    gitMountRoot,
    secondGitMountRoot,
    plainMountRoot,
    siblingRoot,
  };
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
// createDefaultWorkspace — `Spec-009 §Default Behavior`
// ----------------------------------------------------------------------------

describe("createDefaultWorkspace", () => {
  it("writes a read-only, ready workspace rooted at the mount's canonical root", async () => {
    const creation = harness.service.createDefaultWorkspace({
      repoMountId: GIT_MOUNT_ID,
      sessionId: SESSION_ID,
      canonicalRoot: harness.gitMountRoot,
    });

    // The composition T2.3's attach uses: the mount row and the workspace row
    // land in ONE transaction, driven by the `repo.attached` append.
    await harness.emitter.emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: GIT_MOUNT_ID,
      transactionalPrelude: () => {
        insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
        creation.insertRow();
      },
    });
    await creation.emitReady();

    const row = readWorkspaceRow(creation.workspaceId);
    expect(row).toBeDefined();
    // `Spec-009 §Default Behavior` — read-only, and immediately usable. A
    // writable mode is never the fresh-workspace posture.
    expect(row?.execution_mode).toBe("read-only" satisfies ExecutionMode);
    expect(row?.state).toBe("ready" satisfies WorkspaceState);
    // CP-009-8 — the persisted root is the canonical one, verbatim.
    expect(row?.fs_root).toBe(harness.gitMountRoot);
    expect(row?.session_id).toBe(SESSION_ID);
    expect(row?.repo_mount_id).toBe(GIT_MOUNT_ID);
    expect(readEventTypes()).toEqual(["repo.attached", "workspace.ready"]);
  });

  it("aborts the workspace row with the mount row when the shared transaction fails", async () => {
    const creation = harness.service.createDefaultWorkspace({
      repoMountId: GIT_MOUNT_ID,
      sessionId: SESSION_ID,
      canonicalRoot: harness.gitMountRoot,
    });

    await expect(
      harness.emitter.emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: GIT_MOUNT_ID,
        transactionalPrelude: () => {
          insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
          creation.insertRow();
          throw new Error("attach failed after both rows were written");
        },
      }),
    ).rejects.toThrow("attach failed after both rows were written");

    // Neither row, and no event: the atomicity the two-closure shape exists to
    // provide (I-009-9). A mount with no default workspace would be a mount
    // D-009-7's REQUIRED `defaultWorkspaceId` could not render.
    expect(countRows("workspaces")).toBe(0);
    expect(countRows("repo_mounts")).toBe(0);
    expect(readEventTypes()).toEqual([]);
  });

  it("refuses a second insert and refuses readiness before the insert", async () => {
    const creation = harness.service.createDefaultWorkspace({
      repoMountId: GIT_MOUNT_ID,
      sessionId: SESSION_ID,
      canonicalRoot: harness.gitMountRoot,
    });

    await expect(creation.emitReady()).rejects.toBeInstanceOf(WorkspaceServiceInvariantError);
    expect(readEventTypes()).toEqual([]);

    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    creation.insertRow();
    expect(captureThrow(() => creation.insertRow())).toBeInstanceOf(WorkspaceServiceInvariantError);
    expect(countRows("workspaces")).toBe(1);
  });

  it("refuses a SECOND readiness announcement, so one transition emits one event", async () => {
    const creation = harness.service.createDefaultWorkspace({
      repoMountId: GIT_MOUNT_ID,
      sessionId: SESSION_ID,
      canonicalRoot: harness.gitMountRoot,
    });
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    creation.insertRow();
    await creation.emitReady();

    // Unlike `insertRow`, this half has no compare-and-swap to make a repeat
    // harmless — a second call would simply append a second `workspace.ready`
    // for one transition (I-009-9).
    await expect(creation.emitReady()).rejects.toBeInstanceOf(WorkspaceServiceInvariantError);
    expect(readEventTypes()).toEqual(["workspace.ready"]);
  });

  it("carries the caller's actor and correlationId onto the event envelope", async () => {
    const creation = harness.service.createDefaultWorkspace({
      repoMountId: GIT_MOUNT_ID,
      sessionId: SESSION_ID,
      canonicalRoot: harness.gitMountRoot,
      actor: PARTICIPANT_ACTOR,
      correlationId: ATTACH_CORRELATION_ID,
    });
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    creation.insertRow();
    await creation.emitReady();

    // Every other arm here takes the defaults, so a dropped linkage field would
    // be invisible. `correlationId` is what ties this `workspace.ready` back to
    // the `repo.attached` that caused it on a rebuilt timeline.
    const envelopes = readEventEnvelopes();
    expect(envelopes).toEqual([
      { type: "workspace.ready", actor: PARTICIPANT_ACTOR, correlation_id: ATTACH_CORRELATION_ID },
    ]);
    // The payload's own actor is reconciled from the same value, not defaulted.
    expect(readEventPayloads("workspace.ready")[0]?.["actor"]).toBe(PARTICIPANT_ACTOR);
  });

  it("refuses a canonical root that does not name one complete location (CP-009-8)", () => {
    // Three shapes, each missing a different piece only the daemon's own
    // context could supply: a working directory, a home directory, a drive.
    for (const incompleteRoot of ["repos/git-mount", "~/repos/git-mount", "\\repos\\git-mount"]) {
      const refusal = captureThrow(() =>
        harness.service.createDefaultWorkspace({
          repoMountId: GIT_MOUNT_ID,
          sessionId: SESSION_ID,
          canonicalRoot: incompleteRoot,
        }),
      );
      expect(refusal).toBeInstanceOf(WorkspaceServiceInvariantError);
      expect((refusal as WorkspaceServiceInvariantError).kind).toBe("non_absolute_execution_root");
    }
  });

  it("accepts the three COMPLETE root spellings, including the Windows forms", () => {
    // The negative control for the arm above: a guard that refused everything
    // would pass that one and fail this. No fixture on disk is needed — the
    // check runs before any database or filesystem work, which is also why a
    // Windows-shaped root is testable on a POSIX host.
    const completeRoots = ["/repos/app", "C:\\repos\\app", "C:/repos/app", "\\\\server\\share"];
    for (const completeRoot of completeRoots) {
      expect(() =>
        harness.service.createDefaultWorkspace({
          repoMountId: GIT_MOUNT_ID,
          sessionId: SESSION_ID,
          canonicalRoot: completeRoot,
        }),
      ).not.toThrow();
    }
  });
});

// ----------------------------------------------------------------------------
// bind — `Spec-009 §Required Behavior`,
// `Spec-009 §Local Trust Envelope (V1 Definition)`, I-009-3, I-009-8
// ----------------------------------------------------------------------------

describe("bind", () => {
  beforeEach(() => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    insertMount({ id: PLAIN_MOUNT_ID, canonicalRoot: harness.plainMountRoot, vcsType: "none" });
    insertMount({
      id: DETACHED_MOUNT_ID,
      canonicalRoot: harness.secondGitMountRoot,
      state: "detached",
    });
  });

  it("has a canonical fixture root, so a containment refusal is about the boundary", async () => {
    // Without this, every refusal below could just as well be the temp root
    // disagreeing with its own realpath — and every containment arm in this
    // block would pass for a reason that has nothing to do with the boundary.
    expect(await realpath(harness.gitMountRoot)).toBe(harness.gitMountRoot);
    expect(await realpath(harness.siblingRoot)).toBe(harness.siblingRoot);
  });

  it("binds read-only at the mount root and derives the session from the mount", async () => {
    const response = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });

    expect(response.state).toBe("ready" satisfies WorkspaceState);
    expect(response.executionMode).toBe("read-only" satisfies ExecutionMode);
    expect(response.fsRoot).toBe(harness.gitMountRoot);

    const row = readWorkspaceRow(response.workspaceId);
    // The session is the MOUNT's. The bind request carries no session field at
    // all, which is the structural half of the same rule: a caller cannot name
    // someone else's session by naming a mount it does not own.
    expect(row?.session_id).toBe(SESSION_ID);
    expect(row?.fs_root).toBe(harness.gitMountRoot);
    expect(readEventTypes()).toEqual(["workspace.ready"]);
  });

  it("resolves a subdirectory inside the mount", async () => {
    const response = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
      directory: "packages",
    });

    expect(response.fsRoot).toBe(join(harness.gitMountRoot, "packages"));
    expect(readWorkspaceRow(response.workspaceId)?.fs_root).toBe(
      join(harness.gitMountRoot, "packages"),
    );
  });

  it("rejects a traversal escape on the `directory` argument (I-009-3)", async () => {
    // The escape target EXISTS on disk, so the refusal is containment, not
    // absence.
    await expect(
      harness.service.bind({
        repoMountId: GIT_MOUNT_ID,
        executionMode: "read-only",
        directory: "../sibling",
      }),
    ).rejects.toBeInstanceOf(TrustEnvelopeViolationError);

    // The absolute-redirection spelling of the same escape.
    await expect(
      harness.service.bind({
        repoMountId: GIT_MOUNT_ID,
        executionMode: "read-only",
        directory: harness.siblingRoot,
      }),
    ).rejects.toBeInstanceOf(TrustEnvelopeViolationError);

    // Refused BEFORE any row or event exists.
    expect(countRows("workspaces")).toBe(0);
    expect(readEventTypes()).toEqual([]);
  });

  it("carries the ratified `repo.outside_trust_envelope` code on the refusal", async () => {
    const refusal = await captureRejection(() =>
      harness.service.bind({
        repoMountId: GIT_MOUNT_ID,
        executionMode: "read-only",
        directory: "../sibling",
      }),
    );

    expect(refusal).toBeInstanceOf(TrustEnvelopeViolationError);
    expect((refusal as TrustEnvelopeViolationError).code).toBe("repo.outside_trust_envelope");
    expect((refusal as TrustEnvelopeViolationError).httpStatus).toBe(403);
  });

  it("rejects an absolute directory pointing at a DETACHED mount's root", async () => {
    // A detached mount's root is out of the session's envelope, and it is also
    // outside the anchor — both halves refuse, and neither may admit it.
    await expect(
      harness.service.bind({
        repoMountId: GIT_MOUNT_ID,
        executionMode: "read-only",
        directory: harness.secondGitMountRoot,
      }),
    ).rejects.toBeInstanceOf(TrustEnvelopeViolationError);
  });

  it("lands a writable bind in `provisioning` with no execution root", async () => {
    const response = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "worktree",
    });

    expect(response.state).toBe("provisioning" satisfies WorkspaceState);
    expect(response.fsRoot).toBeUndefined();

    const row = readWorkspaceRow(response.workspaceId);
    expect(row?.state).toBe("provisioning" satisfies WorkspaceState);
    // CP-009-8 — the validated root is DISCARDED rather than persisted: a
    // worktree does not execute in the requested directory, and storing it
    // would hand Plan-012 an approval scope the workspace never uses.
    expect(row?.fs_root).toBeNull();
    expect(row?.execution_mode).toBe("worktree" satisfies ExecutionMode);
    expect(readEventTypes()).toEqual(["workspace.provisioning"]);
  });

  it("still validates containment on a writable bind, before any provisioner runs", async () => {
    // The validated root is thrown away, so the validation could look like dead
    // work — it is not. Refusing an out-of-envelope request before a provisioner
    // is spawned is the whole point.
    await expect(
      harness.service.bind({
        repoMountId: GIT_MOUNT_ID,
        executionMode: "worktree",
        directory: "../sibling",
      }),
    ).rejects.toBeInstanceOf(TrustEnvelopeViolationError);
    expect(countRows("workspaces")).toBe(0);
  });

  it("refuses a mode the mount cannot offer, naming the reason (I-009-8)", async () => {
    const refusal = await captureRejection(() =>
      harness.service.bind({ repoMountId: PLAIN_MOUNT_ID, executionMode: "worktree" }),
    );

    expect(refusal).toBeInstanceOf(WorkspaceModeUnsupportedError);
    const modeRefusal = refusal as WorkspaceModeUnsupportedError;
    expect(modeRefusal.code).toBe("workspace.mode_unsupported");
    expect(modeRefusal.httpStatus).toBe(400);

    // Compared against T2.5's matrix rather than a copy of it: a suite that
    // restates the reason string pins the copy, not the matrix.
    const capabilities = computeExecutionModeCapabilities({ vcsType: "none" });
    expect(modeRefusal.availableModes).toEqual(capabilities.availableModes);
    expect(modeRefusal.detail?.["reason"]).toBe(capabilities.restrictions?.worktree);

    // No substitution happened: nothing was written at all.
    expect(countRows("workspaces")).toBe(0);
  });

  it("still binds `read-only` on a plain-directory mount", async () => {
    const response = await harness.service.bind({
      repoMountId: PLAIN_MOUNT_ID,
      executionMode: "read-only",
    });
    expect(response.state).toBe("ready" satisfies WorkspaceState);
    expect(response.fsRoot).toBe(harness.plainMountRoot);
  });

  // -- Ordering obligation (ii): mount identity before envelope construction --

  it("refuses an unknown mount id with `repo.not_found`", async () => {
    const refusal = await captureRejection(() =>
      harness.service.bind({ repoMountId: UNKNOWN_MOUNT_ID, executionMode: "read-only" }),
    );

    expect(refusal).toBeInstanceOf(RepoMountNotFoundError);
    expect((refusal as RepoMountNotFoundError).code).toBe("repo.not_found");
  });

  it("refuses a DETACHED mount id with `repo.not_found`, not an envelope violation", async () => {
    const refusal = await captureRejection(() =>
      harness.service.bind({ repoMountId: DETACHED_MOUNT_ID, executionMode: "read-only" }),
    );

    // The discriminating assertion. With the envelope query unscoped, this bind
    // would SUCCEED against a detached mount; with the query scoped but the
    // not-found check absent, the anchor would fail admission and the caller
    // would get `repo.outside_trust_envelope` (403) — an escape accusation for
    // using a stale bookmark.
    expect(refusal).toBeInstanceOf(RepoMountNotFoundError);
    expect(refusal).not.toBeInstanceOf(TrustEnvelopeViolationError);
    expect((refusal as RepoMountNotFoundError).code).toBe("repo.not_found");
    expect((refusal as RepoMountNotFoundError).httpStatus).toBe(404);
  });

  // -- The mid-flight detach window --

  it("refuses a bind whose mount is detached DURING the containment await", async () => {
    // The window: `bind` reads the mount, then awaits a filesystem probe and
    // the containment validator. A `repo.detach` cascade landing in there has
    // already passed over this workspace, and the foreign key is no help — a
    // detach moves the mount's `state`, it does not delete the row. Without the
    // insert's attachment predicate this commits a `ready` workspace on a
    // detached mount: a live execution root outside the session's trust
    // envelope (I-009-3) that `assertWritable` then passes.
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
        repoMountId: GIT_MOUNT_ID,
        executionMode: "read-only",
      }),
    ).rejects.toBeInstanceOf(WorkspaceServiceInvariantError);

    // The whole write rolled back — no orphan row, and no `workspace.ready`
    // announcing a workspace that does not exist (I-009-9).
    expect(countRows("workspaces")).toBe(0);
    expect(readEventTypes()).toEqual([]);
  });

  it("positive control: the same seam without the detach binds normally", async () => {
    // Proves the refusal above is caused by the DETACH and not by the injected
    // validator, the spy, or the extra service instance.
    const validator = new TrustEnvelopeValidator();
    const validateExecutionRootOriginal = validator.validateExecutionRoot.bind(validator);
    vi.spyOn(validator, "validateExecutionRoot").mockImplementationOnce((candidate) =>
      validateExecutionRootOriginal(candidate),
    );

    const response = await createService({ trustEnvelope: validator }).bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });

    expect(response.state).toBe("ready" satisfies WorkspaceState);
    expect(countRows("workspaces")).toBe(1);
    expect(readEventTypes()).toEqual(["workspace.ready"]);
  });

  // -- Ordering obligation (i): reachability before containment --

  it("reports a vanished mount root as `workspace.stale`, not a 403", async () => {
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    const refusal = await captureRejection(() =>
      harness.service.bind({ repoMountId: GIT_MOUNT_ID, executionMode: "read-only" }),
    );

    expect(refusal).toBeInstanceOf(WorkspaceStaleError);
    expect((refusal as WorkspaceStaleError).code).toBe("workspace.stale");
    expect((refusal as WorkspaceStaleError).httpStatus).toBe(409);
    expect(refusal).not.toBeInstanceOf(TrustEnvelopeViolationError);
  });

  it("negative control: the validator alone calls the same vanished root a 403", async () => {
    // The paired observation that makes the arm above meaningful. Run the OTHER
    // order — containment first — over the identical fixture and watch it
    // produce `repo.outside_trust_envelope`: `realpath` cannot resolve a missing
    // path, so the validator refuses it as unprovable. That is the wrong answer
    // for an unmounted volume, and it is exactly what `bind` would return if its
    // probe ran second.
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    const refusal = await captureRejection(() =>
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: harness.gitMountRoot,
        sessionEnvelopeRoots: [harness.gitMountRoot],
      }),
    );

    expect(refusal).toBeInstanceOf(TrustEnvelopeViolationError);
    expect((refusal as TrustEnvelopeViolationError).httpStatus).toBe(403);
  });

  it("refuses a bind whose mount root is a file rather than a directory", async () => {
    const filePath = join(harness.tmpDir, "repos", "not-a-directory");
    writeFileSync(filePath, "");
    insertMount({ id: FILE_MOUNT_ID, canonicalRoot: filePath });

    // The probe opens the path for enumeration, so a regular file is
    // unreachable by the same measure a missing directory is.
    await expect(
      harness.service.bind({ repoMountId: FILE_MOUNT_ID, executionMode: "read-only" }),
    ).rejects.toBeInstanceOf(WorkspaceStaleError);
  });
});

// ----------------------------------------------------------------------------
// list — AC2, the on-read floor, and the four per-row throw sources
// ----------------------------------------------------------------------------

describe("list", () => {
  beforeEach(() => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    insertMount({ id: SECOND_GIT_MOUNT_ID, canonicalRoot: harness.secondGitMountRoot });
  });

  it("returns every workspace across two mounts with its state (Spec-009 AC2)", async () => {
    const first = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    const second = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "worktree",
    });
    const third = await harness.service.bind({
      repoMountId: SECOND_GIT_MOUNT_ID,
      executionMode: "read-only",
    });

    const response = await harness.service.list({ sessionId: SESSION_ID });
    expect(response.workspaces).toHaveLength(3);
    expect(new Map(response.workspaces.map((entry) => [String(entry.id), entry.state]))).toEqual(
      new Map([
        [String(first.workspaceId), "ready"],
        [String(second.workspaceId), "provisioning"],
        [String(third.workspaceId), "ready"],
      ]),
    );
    expect(new Set(response.workspaces.map((entry) => String(entry.repoMountId)))).toEqual(
      new Set([String(GIT_MOUNT_ID), String(SECOND_GIT_MOUNT_ID)]),
    );

    // The response is representable — I-009-10 validates outbound payloads, so
    // a projection that only satisfies TypeScript is not enough.
    expect(() => WorkspaceListResponseSchema.parse(response)).not.toThrow();
  });

  it("scopes to one mount when asked, and to one session always", async () => {
    await harness.service.bind({ repoMountId: GIT_MOUNT_ID, executionMode: "read-only" });
    const scoped = await harness.service.bind({
      repoMountId: SECOND_GIT_MOUNT_ID,
      executionMode: "read-only",
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

  it("reports and PERSISTS a stale transition when the root vanished (I-009-7)", async () => {
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    const first = await harness.service.list({ sessionId: SESSION_ID });
    expect(first.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    // The persistence half. A response-only verdict would leave the next
    // reader — and `assertWritable` — believing the row is still `ready`.
    expect(readWorkspaceRow(bound.workspaceId)?.state).toBe("stale");
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.stale"]);

    // Exactly one event per real transition (I-009-9): a second read observes
    // the same fact and must not re-announce it.
    const second = await harness.service.list({ sessionId: SESSION_ID });
    expect(second.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.stale"]);
  });

  it("never auto-heals a stale row when its root comes back", async () => {
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    rmSync(harness.gitMountRoot, { recursive: true, force: true });
    await harness.service.list({ sessionId: SESSION_ID });

    mkdirSync(harness.gitMountRoot, { recursive: true });
    const afterRepair = await harness.service.list({ sessionId: SESSION_ID });

    // Repair is an explicit reprovision, not an accident of a read — the same
    // posture `computeWorkspaceHealth` holds.
    expect(afterRepair.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceRow(bound.workspaceId)?.state).toBe("stale");
  });

  // -- The four per-row throw sources. None may be silently dropped. --

  it("source 1: propagates an out-of-vocabulary state, attributed to its row", async () => {
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    withCheckConstraintsDisabled(() => {
      harness.db
        .prepare("UPDATE workspaces SET state = 'liquefied' WHERE id = ?")
        .run(bound.workspaceId);
    });

    const failure = await captureRejection(() => harness.service.list({ sessionId: SESSION_ID }));

    expect(failure).toBeInstanceOf(WorkspaceServiceInvariantError);
    const invariantFailure = failure as WorkspaceServiceInvariantError;
    expect(invariantFailure.kind).toBe("workspace_row_unprojectable");
    expect(invariantFailure.workspaceId).toBe(bound.workspaceId);
    expect((invariantFailure.cause as Error).message).toContain("no probe policy is registered");
  });

  it("source 2: propagates a NULL execution root under a probe-bearing state", async () => {
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    harness.db.prepare("UPDATE workspaces SET fs_root = NULL WHERE id = ?").run(bound.workspaceId);

    const failure = await captureRejection(() => harness.service.list({ sessionId: SESSION_ID }));

    expect(failure).toBeInstanceOf(WorkspaceServiceInvariantError);
    const invariantFailure = failure as WorkspaceServiceInvariantError;
    expect(invariantFailure.kind).toBe("workspace_row_unprojectable");
    expect(invariantFailure.workspaceId).toBe(bound.workspaceId);
    expect((invariantFailure.cause as Error).message).toContain("must carry a resolved fs_root");
  });

  it("source 3: propagates a probe that measured a different path", async () => {
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });

    // A LYING probe seam — the only way to reach the subject-binding guard,
    // because the production probe stamps `probedPath` from its own argument
    // and this service re-resolves nothing between the row and the probe (the
    // verbatim-probe-subject obligation). A service that DID re-resolve would
    // fail this arm on every row rather than only on the planted one.
    const failure = await captureRejection(() =>
      createService({ probePath: mispairedProbe(harness.secondGitMountRoot) }).list({
        sessionId: SESSION_ID,
      }),
    );

    expect(failure).toBeInstanceOf(WorkspaceServiceInvariantError);
    const invariantFailure = failure as WorkspaceServiceInvariantError;
    expect(invariantFailure.kind).toBe("workspace_row_unprojectable");
    expect(invariantFailure.workspaceId).toBe(bound.workspaceId);
    expect((invariantFailure.cause as Error).message).toContain(
      "did not measure the workspace's execution root",
    );
  });

  it("source 4: propagates an unrepresentable identifier", async () => {
    // `workspaces.id` carries no format constraint, so a corrupt id needs no
    // pragma — it is the most reachable of the four in practice.
    harness.db
      .prepare(
        `INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata, created_at, updated_at)
         VALUES ('not-a-uuid', @session_id, @repo_mount_id, 'read-only', @fs_root, 'ready', '{}', @now, @now)`,
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
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    rmSync(harness.gitMountRoot, { recursive: true, force: true });
    vi.spyOn(harness.emitter, "emitWorkspaceStale").mockImplementationOnce(() =>
      Promise.reject(new Error("database is locked")),
    );

    const failure = await captureRejection(() => harness.service.list({ sessionId: SESSION_ID }));

    expect(failure).toBeInstanceOf(WorkspaceServiceInvariantError);
    const invariantFailure = failure as WorkspaceServiceInvariantError;
    // NOT `workspace_row_unprojectable`. The row projected perfectly; the WRITE
    // of that projection failed. Labelling it the other way sends an operator
    // to inspect a healthy row for what is a locked database.
    expect(invariantFailure.kind).toBe("stale_transition_durability_failure");
    expect(invariantFailure.workspaceId).toBe(bound.workspaceId);
    expect((invariantFailure.cause as Error).message).toBe("database is locked");
    // Not swallowed: reporting `stale` for a row the database still calls
    // `ready` is precisely what I-009-7's persistence half forbids.
    expect(readWorkspaceRow(bound.workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
  });

  it("names the row whose root vanished as the stale event's SUBJECT", async () => {
    const healthy = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    const doomed = await harness.service.bind({
      repoMountId: SECOND_GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    rmSync(harness.secondGitMountRoot, { recursive: true, force: true });

    await harness.service.list({ sessionId: SESSION_ID });

    // Every other arm reads event TYPES only, so an emit naming the wrong
    // workspace would pass the entire suite while telling a timeline reader
    // that a healthy workspace went stale.
    const stalePayloads = readEventPayloads("workspace.stale");
    expect(stalePayloads).toHaveLength(1);
    expect(stalePayloads[0]?.["workspaceId"]).toBe(doomed.workspaceId);
    expect(stalePayloads[0]?.["workspaceId"]).not.toBe(healthy.workspaceId);
    expect(readWorkspaceRow(healthy.workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
  });

  it("never silently drops a corrupt row from an otherwise-healthy roster", async () => {
    const healthy = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    const corrupted = await harness.service.bind({
      repoMountId: SECOND_GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    harness.db
      .prepare("UPDATE workspaces SET fs_root = NULL WHERE id = ?")
      .run(corrupted.workspaceId);

    // The whole point of the containment decision: the caller gets a LOUD
    // failure, never a two-row roster that quietly became one. A shortened list
    // is the outcome an operator would act on wrongly — deciding a mount is safe
    // to detach because the workspace blocking it is no longer shown.
    await expect(harness.service.list({ sessionId: SESSION_ID })).rejects.toBeInstanceOf(
      WorkspaceServiceInvariantError,
    );
    expect(readWorkspaceRow(healthy.workspaceId)).toBeDefined();
    expect(countRows("workspaces")).toBe(2);
  });
});

// ----------------------------------------------------------------------------
// Reprovision cycle — CP-009-2, I-009-6
// ----------------------------------------------------------------------------

describe("reprovision cycle", () => {
  let workspaceId: string;

  beforeEach(async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    workspaceId = bound.workspaceId;
  });

  it("keeps the id and the row count across a full cycle (I-009-6)", async () => {
    const rowsBefore = countRows("workspaces");
    const worktreeRoot = join(harness.tmpDir, "worktrees", "feature");
    mkdirSync(worktreeRoot, { recursive: true });

    await harness.service.beginReprovision(workspaceId, "worktree");
    const midCycle = readWorkspaceRow(workspaceId);
    expect(midCycle?.state).toBe("provisioning" satisfies WorkspaceState);
    // The released root does not linger: CP-009-8 would otherwise keep matching
    // Plan-012 approvals against a root the workspace no longer owns.
    expect(midCycle?.fs_root).toBeNull();
    // The target mode is persisted at BEGIN because `completeReprovision` takes
    // no mode argument — nothing downstream could persist it.
    expect(midCycle?.execution_mode).toBe("worktree" satisfies ExecutionMode);

    await harness.service.completeReprovision(workspaceId, worktreeRoot);
    const afterCycle = readWorkspaceRow(workspaceId);

    // The invariant, stated three ways: same id, same row count, and a state
    // that cycled rather than a row that was replaced.
    expect(afterCycle?.id).toBe(workspaceId);
    expect(countRows("workspaces")).toBe(rowsBefore);
    expect(afterCycle?.state).toBe("ready" satisfies WorkspaceState);
    expect(afterCycle?.fs_root).toBe(worktreeRoot);
    expect(readEventTypes()).toEqual([
      "workspace.ready",
      "workspace.provisioning",
      "workspace.ready",
    ]);
  });

  it("adopts an execution root OUTSIDE the mount, without re-checking containment", async () => {
    // A worktree lives outside the mount's canonical root by construction, so
    // re-running the containment validator here would reject every writable mode
    // it exists to support. The root's legitimacy is its provenance: Plan-010's
    // provisioner created it under daemon control.
    const outsideRoot = join(harness.tmpDir, "worktrees", "outside");
    mkdirSync(outsideRoot, { recursive: true });

    await harness.service.beginReprovision(workspaceId, "worktree");
    await harness.service.completeReprovision(workspaceId, outsideRoot);

    expect(readWorkspaceRow(workspaceId)?.fs_root).toBe(outsideRoot);
  });

  it("refuses a non-absolute execution root at completion (CP-009-8)", async () => {
    await harness.service.beginReprovision(workspaceId, "worktree");

    // Provenance does not make a relative path safe: Plan-012 scopes approvals
    // against this value, and a relative one would be completed against whatever
    // working directory the tool process happens to have.
    await expect(
      harness.service.completeReprovision(workspaceId, "worktrees/relative"),
    ).rejects.toBeInstanceOf(WorkspaceServiceInvariantError);
    // Refused BEFORE the write, so the cycle is still open and retryable.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("provisioning" satisfies WorkspaceState);
    expect(readWorkspaceRow(workspaceId)?.fs_root).toBeNull();
  });

  it("records a scrubbed failure detail and lands the row `stale`", async () => {
    await harness.service.beginReprovision(workspaceId, "worktree");
    await harness.service.failReprovision(
      workspaceId,
      "fatal: could not read from https://octocat:ghp_abcdefghijklmnop@github.com/acme/repo.git",
    );

    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);

    const lastError = readWorkspaceMetadata(workspaceId)["lastError"];
    expect(typeof lastError).toBe("string");
    expect(lastError).not.toContain("ghp_abcdefghijklmnop");
    expect(lastError).not.toContain("octocat:");
    // The diagnostic survives the redaction — a scrubber that ate the message
    // would pass the two assertions above and be useless.
    expect(lastError).toContain("fatal: could not read from");
    expect(readEventTypes()).toEqual([
      "workspace.ready",
      "workspace.provisioning",
      "workspace.stale",
    ]);
  });

  it("surfaces the recorded failure on the list response", async () => {
    await harness.service.beginReprovision(workspaceId, "worktree");
    await harness.service.failReprovision(workspaceId, "fatal: worktree add failed (exit 128)");

    const response = await harness.service.list({ sessionId: SESSION_ID });
    expect(response.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(response.workspaces[0]?.lastError).toContain("worktree add failed");
    // Persisted AND representable: the pairing the `lastError` cap exists for.
    expect(() => WorkspaceListResponseSchema.parse(response)).not.toThrow();
  });

  it("retries from `stale`, and clears the previous failure on success", async () => {
    const worktreeRoot = join(harness.tmpDir, "worktrees", "retry");
    mkdirSync(worktreeRoot, { recursive: true });

    await harness.service.beginReprovision(workspaceId, "worktree");
    await harness.service.failReprovision(workspaceId, "fatal: first attempt failed");
    expect(readWorkspaceMetadata(workspaceId)["lastError"]).toBeDefined();

    // `Spec-009 §Execution Mode Transitions` — the switch may be retried, and a
    // failed switch left the row `stale`. A gate that refused `stale` would make
    // the documented retry impossible.
    await harness.service.beginReprovision(workspaceId, "worktree");

    // MID-RETRY, before the outcome is known. `packages/contracts/src/repo.ts`
    // makes `lastError` "present iff the workspace went `stale` from a recorded
    // failure" an emitter obligation on this module, and a `provisioning` row is
    // not that. Clearing only at completion would leave the whole in-flight
    // window advertising the PREVIOUS attempt's failure — and a `markStale` from
    // here would land a `stale` row carrying a superseded detail.
    expect(readWorkspaceMetadata(workspaceId)["lastError"]).toBeUndefined();
    const midRetry = await harness.service.list({ sessionId: SESSION_ID });
    expect(midRetry.workspaces[0]?.state).toBe("provisioning" satisfies WorkspaceState);
    expect(midRetry.workspaces[0]?.lastError).toBeUndefined();

    await harness.service.completeReprovision(workspaceId, worktreeRoot);

    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    // A `ready` workspace still advertising a fixed failure reports something
    // that is no longer true.
    expect(readWorkspaceMetadata(workspaceId)["lastError"]).toBeUndefined();
  });

  it("refuses a target mode the mount cannot offer", async () => {
    insertMount({ id: PLAIN_MOUNT_ID, canonicalRoot: harness.plainMountRoot, vcsType: "none" });
    const plainBound = await harness.service.bind({
      repoMountId: PLAIN_MOUNT_ID,
      executionMode: "read-only",
    });

    await expect(
      harness.service.beginReprovision(plainBound.workspaceId, "branch"),
    ).rejects.toBeInstanceOf(WorkspaceModeUnsupportedError);
    // I-009-8 — refused by name, never substituted, and the row is untouched.
    expect(readWorkspaceRow(plainBound.workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    expect(readWorkspaceRow(plainBound.workspaceId)?.execution_mode).toBe(
      "read-only" satisfies ExecutionMode,
    );
  });

  it("refuses to reprovision a held workspace with `workspace.busy`", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);

    const refusal = await captureRejection(() =>
      harness.service.beginReprovision(workspaceId, "worktree"),
    );

    expect(refusal).toBeInstanceOf(WorkspaceBusyError);
    expect((refusal as WorkspaceBusyError).holdingRunId).toBe(RUN_ID);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("busy" satisfies WorkspaceState);
  });

  it("refuses to reprovision an archived workspace", async () => {
    harness.db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);

    const refusal = await captureRejection(() =>
      harness.service.beginReprovision(workspaceId, "worktree"),
    );

    expect(refusal).toBeInstanceOf(WorkspaceServiceInvariantError);
    expect((refusal as WorkspaceServiceInvariantError).kind).toBe("illegal_state_transition");
  });

  it("refuses to complete or fail a cycle that was never begun", async () => {
    await expect(
      harness.service.completeReprovision(workspaceId, harness.gitMountRoot),
    ).rejects.toBeInstanceOf(WorkspaceServiceInvariantError);
    await expect(harness.service.failReprovision(workspaceId, "boom")).rejects.toBeInstanceOf(
      WorkspaceServiceInvariantError,
    );
    // Nothing was written and nothing was announced.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(["workspace.ready"]);
  });

  it("refuses an unknown workspace with `workspace.not_found`", async () => {
    const refusal = await captureRejection(() =>
      harness.service.beginReprovision(UNKNOWN_WORKSPACE_ID, "worktree"),
    );

    expect(refusal).toBeInstanceOf(WorkspaceNotFoundError);
    expect((refusal as WorkspaceNotFoundError).code).toBe("workspace.not_found");
    expect((refusal as WorkspaceNotFoundError).httpStatus).toBe(404);
  });
});

// ----------------------------------------------------------------------------
// `metadata.lastError` — SCRUB before TRUNCATE
// ----------------------------------------------------------------------------

// Built rather than spelled: a literal NUL in source is invisible in review and
// hostile to every tool that reads this file.
const NUL_CHARACTER: string = String.fromCharCode(0);

describe("lastError normalisation", () => {
  // An OPAQUE password inside a URL: no vendor prefix, no keyword nearby, so the
  // userinfo pattern is the ONLY thing that can catch it. That is what makes the
  // ordering observable — a truncation that lands mid-userinfo destroys the `@`
  // anchor and the pattern stops matching.
  const OPAQUE_SECRET: string = "Xq7bT2mR9wLpZ4nC8vKd";
  const CREDENTIAL_URL: string = `https://deploy:${OPAQUE_SECRET}@git.internal/acme/repo.git`;

  /**
   * A detail whose credential straddles the truncation boundary.
   *
   * The filler is sized so the cut lands INSIDE the secret with eleven of its
   * characters retained and the trailing `@` removed — the precise shape that
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
    // Not the whole secret, and not ANY leading fragment of it either — a
    // truncated secret is still a secret's prefix.
    expect(normalized).not.toContain(OPAQUE_SECRET);
    for (let prefixLength = 6; prefixLength <= OPAQUE_SECRET.length; prefixLength += 1) {
      expect(normalized).not.toContain(OPAQUE_SECRET.slice(0, prefixLength));
    }
  });

  it("negative control: cutting BEFORE scrubbing leaks a fragment of the same secret", () => {
    const raw = detailWithCredentialAtBoundary();

    // Composed from the SAME exported functions the production path uses, in the
    // wrong order. A control that reimplemented the scrubber would prove regexes
    // work, not that this module orders its two steps correctly.
    const wrongOrder = scrubCredentials(truncateWorkspaceLastError(raw));

    // The truncation removed the `@` that anchors the userinfo pattern, so the
    // scrubber no longer recognises what is left — and what is left is a live
    // prefix of the secret.
    expect(wrongOrder).toContain(OPAQUE_SECRET.slice(0, 6));
    // Paired with the production order over the identical input, which does not.
    expect(normalizeWorkspaceLastError(raw)).not.toContain(OPAQUE_SECRET.slice(0, 6));
  });

  it("scrubs the credential shapes a provisioning failure realistically carries", () => {
    // The vendor-prefixed suffixes are deliberately LOW-ENTROPY, visibly-fake
    // stand-ins sitting at or above the scrubber pattern's own `{8,}` bound.
    // The pattern keys on the prefix, not the suffix, so these exercise exactly
    // what a real-length token would — while a real-format high-entropy fixture
    // would fire every secret scanner that ever reads this line (the gitleaks
    // pre-commit gate did, and GitHub push protection scans history the same
    // way), burying real findings under permanent fixture noise.
    expect(scrubCredentials("remote: https://user:hunter2@example.com/x.git")).not.toContain(
      "hunter2",
    );
    expect(scrubCredentials("Authorization: Bearer abcdef0123456789")).not.toContain(
      "abcdef0123456789",
    );
    expect(scrubCredentials("x-access-token:ghs_aaaabbbbccccdddd")).not.toContain("ghs_");
    expect(scrubCredentials("token=glpat-aaaabbbbcccc")).not.toContain("glpat-");
    expect(scrubCredentials("leaked ghp_aaaabbbbccccdddd here")).not.toContain("ghp_");
    // Negative control for the scrubber itself: ordinary output survives, so a
    // scrubber that simply redacted everything would fail here.
    expect(scrubCredentials("fatal: not a git repository")).toBe("fatal: not a git repository");
  });

  it("records NO lastError when nothing publishable survives", async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    await harness.service.beginReprovision(bound.workspaceId, "worktree");
    await harness.service.failReprovision(bound.workspaceId, "  \n\t   ");

    // `wireFreeFormString` demands `.min(1)`, at least one non-whitespace
    // character, and no NUL. Persisting an illegal value would make the very
    // list response that reports this failure unrepresentable.
    expect(readWorkspaceRow(bound.workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(bound.workspaceId)["lastError"]).toBeUndefined();

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
    // The fixture has to be one whose ANCHOR the NUL breaks. A NUL inside a URL
    // userinfo does not qualify: NUL is not `\s`, so `[^\s/@]+` matches straight
    // across it and both orderings redact identically — an arm that cannot fail.
    // A prefixed vendor token does qualify: `gh\0p_` is not `ghp_`, so the
    // prefix pattern misses it entirely.
    const splitToken = `fatal: remote rejected gh${NUL_CHARACTER}p_0123456789abcdefgh`;

    // Production order (strip, then scrub): the halves rejoin into a token the
    // scrubber recognises, and it is redacted.
    const normalized = normalizeWorkspaceLastError(splitToken);
    expect(normalized).not.toContain("ghp_");
    expect(normalized).not.toContain("0123456789abcdefgh");
    expect(normalized).toContain("fatal: remote rejected");

    // Negative control, from the SAME exported functions in the wrong order:
    // scrubbing first sees a token that matches nothing, and the later strip
    // then reassembles a live, recognisable credential.
    const wrongOrder = scrubCredentials(splitToken).replace(new RegExp(NUL_CHARACTER, "g"), "");
    expect(wrongOrder).toContain("ghp_0123456789abcdefgh");
  });

  it("records nothing when only whitespace survives the scrub, even over the cap", () => {
    // The emptiness test runs on the SCRUBBED value, not the truncated one. Run
    // it after truncation and an over-cap whitespace-only detail passes, because
    // the truncation marker it just appended supplies the only `\S` in the
    // string — persisting thousands of spaces plus `...[truncated]` as the
    // failure an operator is meant to read.
    const overCapWhitespace = " ".repeat(WORKSPACE_LAST_ERROR_MAX_LEN + 100);
    expect(normalizeWorkspaceLastError(overCapWhitespace)).toBeNull();
    // The under-cap leg of the same rule, which held before and still holds.
    expect(normalizeWorkspaceLastError("  \n\t   ")).toBeNull();
  });

  it("leaves a detail inside the cap untouched", () => {
    const short = "fatal: worktree add failed (exit 128)";
    expect(truncateWorkspaceLastError(short)).toBe(short);
    expect(normalizeWorkspaceLastError(short)).toBe(short);
  });

  it("never splits a surrogate pair at the cut", () => {
    // An emoji is two UTF-16 units; a naive cut at the cap boundary can land
    // between them and leave a lone high surrogate, which is not valid text and
    // which `wireFreeFormString` would carry onto the wire.
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
// assertWritable — CP-009-3, I-009-7
// ----------------------------------------------------------------------------

describe("assertWritable", () => {
  let workspaceId: string;

  beforeEach(async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    workspaceId = bound.workspaceId;
  });

  it("passes a ready workspace", async () => {
    await expect(harness.service.assertWritable(workspaceId)).resolves.toBeUndefined();
    // The gate observed the row; it did not change it.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(["workspace.ready"]);
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
    // The refusal is not a private verdict: the next reader sees it too, which
    // is what makes I-009-7's "observably stale" true.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.stale"]);
  });

  it("passes a busy workspace, leaving the precise refusal to the hold primitive", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    // Duplicating `workspace.busy` here would refuse a caller that never
    // contends for the hold, for a reason that does not apply to it.
    await expect(harness.service.assertWritable(workspaceId)).resolves.toBeUndefined();
  });

  it("refuses provisioning and archived workspaces as internal invariant failures", async () => {
    harness.db
      .prepare("UPDATE workspaces SET state = 'provisioning' WHERE id = ?")
      .run(workspaceId);
    const provisioningRefusal = await captureRejection(() =>
      harness.service.assertWritable(workspaceId),
    );
    // No registered `workspace.*` code names either state, and minting one is
    // banned — so these reach the wire as anonymous internal errors by design.
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
// markBusy / releaseBusy / markStale — CP-009-7 and the busy -> stale decision
// ----------------------------------------------------------------------------

describe("run holds", () => {
  let workspaceId: string;

  beforeEach(async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    const bound = await harness.service.bind({
      repoMountId: GIT_MOUNT_ID,
      executionMode: "read-only",
    });
    workspaceId = bound.workspaceId;
  });

  it("takes the hold WITHOUT emitting an event (closed event registry)", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);

    expect(readWorkspaceRow(workspaceId)?.state).toBe("busy" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBe(RUN_ID);
    // CP-009-7 carves `busy` out of the six-type registry deliberately; the
    // run's own `run.*` events carry the hold's timeline visibility.
    expect(readEventTypes()).toEqual(["workspace.ready"]);
  });

  it("refuses a second holder with `workspace.busy`, naming the incumbent", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);

    const refusal = await captureRejection(() =>
      harness.service.markBusy(workspaceId, OTHER_RUN_ID),
    );

    expect(refusal).toBeInstanceOf(WorkspaceBusyError);
    expect((refusal as WorkspaceBusyError).code).toBe("workspace.busy");
    expect((refusal as WorkspaceBusyError).httpStatus).toBe(409);
    // The only repair affordance the loser has: `repo.detach_conflict` names the
    // blocking workspaces, and nothing else names who holds them.
    expect((refusal as WorkspaceBusyError).holdingRunId).toBe(RUN_ID);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBe(RUN_ID);
  });

  it("refuses to take a hold on a vanished root, and persists the stale transition", async () => {
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    await expect(harness.service.markBusy(workspaceId, RUN_ID)).rejects.toBeInstanceOf(
      WorkspaceStaleError,
    );
    // Taking the hold and discovering the truth mid-run is strictly worse.
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBeUndefined();
    // The one place the two rules meet: the hold itself emits nothing (closed
    // registry), while the on-read floor it drove emits a REAL `workspace.stale`.
    // Asserting the list proves "no event for the hold" is not "no event at all".
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.stale"]);
  });

  it("releases the hold and clears the attribution, still with no event", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    expect(harness.service.releaseBusy(workspaceId)).toBe(true);

    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBeUndefined();
    expect(readEventTypes()).toEqual(["workspace.ready"]);
  });

  it("treats a double release as a benign no-op", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    expect(harness.service.releaseBusy(workspaceId)).toBe(true);
    // The call site is a `finally`; throwing there would replace the run's real
    // failure with a bookkeeping complaint.
    expect(harness.service.releaseBusy(workspaceId)).toBe(false);
    expect(harness.service.releaseBusy(UNKNOWN_WORKSPACE_ID)).toBe(false);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
  });

  // -- Decide-and-document #6: `busy -> stale` is legal and IS persisted --

  it("stales a HELD workspace whose root vanished mid-run (I-009-7)", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    const response = await harness.service.list({ sessionId: SESSION_ID });

    // Refusing this transition would make I-009-7 false for exactly the rows
    // doing damage: a live run writing into a root that no longer exists.
    expect(response.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.stale"]);
    // The hold attribution goes with it: a `stale` workspace is held by nobody,
    // and a lingering id would let a later refusal name a run that is long gone.
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBeUndefined();
  });

  it("does not let a release auto-heal a workspace that went stale mid-run", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    rmSync(harness.gitMountRoot, { recursive: true, force: true });
    await harness.service.list({ sessionId: SESSION_ID });

    // The corollary of the decision above: releasing is not a health verdict.
    expect(harness.service.releaseBusy(workspaceId)).toBe(false);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
  });

  it("markStale is idempotent and terminal-safe", async () => {
    expect(await harness.service.markStale(workspaceId)).toBe(true);
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.stale"]);

    // Already stale — no second transition, so no second event (I-009-9).
    expect(await harness.service.markStale(workspaceId)).toBe(false);
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.stale"]);

    // Archived is terminal; nothing resurrects it into `stale`.
    harness.db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
    expect(await harness.service.markStale(workspaceId)).toBe(false);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("archived");

    // An absent workspace is a no-op, not a throw: every read path drives this.
    expect(await harness.service.markStale(UNKNOWN_WORKSPACE_ID)).toBe(false);
  });

  // -- Two readers racing ONE stale transition (I-009-9) --

  it("appends exactly ONE workspace.stale when a second reader wins the race", async () => {
    // The window this opens: `markStale` reads the row, sees a live state, and
    // only THEN opens the append. A reader that stales the row inside that
    // window leaves this call's compare-and-swap matching nothing — and the
    // append path INSERTs its event row unconditionally once the prelude
    // returns, so declining has to be a THROW. A prelude that merely recorded
    // "no row matched" in a flag and returned would commit a second
    // `workspace.stale` behind the winner's, for one real transition.
    const concurrentReader = createService();
    const concurrentOutcomes: boolean[] = [];
    const emitStaleOriginal = harness.emitter.emitWorkspaceStale.bind(harness.emitter);
    vi.spyOn(harness.emitter, "emitWorkspaceStale").mockImplementationOnce(async (input) => {
      concurrentOutcomes.push(await concurrentReader.markStale(workspaceId));
      return emitStaleOriginal(input);
    });

    const lostTheRace = await harness.service.markStale(workspaceId);

    // The winner wrote its transition and announced it; the loser wrote nothing
    // and announced nothing, and says so in its return value.
    expect(concurrentOutcomes).toEqual([true]);
    expect(lostTheRace).toBe(false);
    expect(readWorkspaceRow(workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.stale"]);
  });

  it("declines before the append when the row was already staled by another reader", async () => {
    // The other half of the same rule, one step earlier: interference landing
    // BEFORE `markStale`'s read is caught by the already-stale guard, so no
    // append is opened at all. Both legs are needed — the guard alone leaves
    // the sentinel's window open, and the sentinel alone would make every
    // already-stale read pay for a transaction it then rolls back.
    const service = createService({
      probePath: interferingProbe(() => {
        forceWorkspaceState(workspaceId, "stale");
      }, false),
    });

    const response = await service.list({ sessionId: SESSION_ID });

    expect(response.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(["workspace.ready"]);
  });

  // -- markBusy losing its compare-and-swap, one arm per re-read verdict --

  it("answers a lost hold race with the REASON, not the mechanism", async () => {
    // The window: `markBusy` observes `ready` through the probe, then runs its
    // compare-and-swap. Interference inside the probe lands between the two, so
    // the CAS matches nothing and the re-read decides what to report. Every
    // branch below is unreachable from a single-threaded suite without it.
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
    // The re-read is what makes this answer actionable: "the CAS changed zero
    // rows" names nothing a caller can chase.
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
        forceWorkspaceState(workspaceId, "provisioning");
      }, true),
    });

    const refusal = await captureRejection(() =>
      reprovisionedUnderfoot.markBusy(workspaceId, RUN_ID),
    );

    // No registered `workspace.*` code names "it went back to provisioning",
    // and minting one is banned — so this reaches the wire anonymously.
    expect(refusal).toBeInstanceOf(WorkspaceServiceInvariantError);
    expect((refusal as WorkspaceServiceInvariantError).kind).toBe("illegal_state_transition");
    expect(readWorkspaceRow(workspaceId)?.state).toBe("provisioning" satisfies WorkspaceState);
  });
});

// ----------------------------------------------------------------------------
// Error-carrier census — `error-contracts.md §Workspace`
// ----------------------------------------------------------------------------

describe("error carriers", () => {
  it("emit the same set as WORKSPACE_SERVICE_ERROR_CODES — no orphan row, no invented code", () => {
    // Drift detector, scoped to what this helper enumerates: a §Workspace row
    // with no carrier fails here, as does one of THESE four minting a code the
    // roster does not list. A fifth carrier added to the module but not to the
    // helper is invisible to this assertion — the export census below closes
    // that gap.
    const emittedCodes = everyCarrier().map((carrier) => carrier.code);
    expect([...emittedCodes].sort()).toEqual([...WORKSPACE_SERVICE_ERROR_CODES].sort());
  });

  it("exports exactly four error constructors — a fifth carrier fails the census", () => {
    // Observes the module's real export surface rather than a hand-kept list,
    // so a carrier added without a roster row and a test cannot slip through
    // the scoping caveat above. `WorkspaceServiceInvariantError` is correctly
    // NOT counted: it extends `Error`, not `DaemonDomainError`, which is the
    // structural expression of "it carries no registered wire code".
    const exportedErrorConstructors = Object.entries(workspaceServiceModule).filter(
      ([, exported]) =>
        typeof exported === "function" && exported.prototype instanceof DaemonDomainError,
    );
    expect(exportedErrorConstructors).toHaveLength(WORKSPACE_SERVICE_ERROR_CODES.length);
  });

  it("WORKSPACE_SERVICE_ERROR_CODES enumerates exactly the WorkspaceServiceErrorCode union", () => {
    // Total `Record` over the union: a member missing below, or a key that is
    // not a member, is a compile error. The runtime comparison then pins the
    // exported tuple to that same set.
    const everyRegistryCode: Record<WorkspaceServiceErrorCode, true> = {
      "workspace.not_found": true,
      "workspace.mode_unsupported": true,
      "workspace.stale": true,
      "workspace.busy": true,
    };
    expect([...WORKSPACE_SERVICE_ERROR_CODES].sort()).toEqual(
      Object.keys(everyRegistryCode).sort(),
    );
  });

  it("quote the registered codes and statuses", () => {
    expect(new WorkspaceNotFoundError(UNKNOWN_WORKSPACE_ID)).toMatchObject({
      code: "workspace.not_found",
      httpStatus: 404,
      // The one carrier with a ratified numeric, matching `repo.not_found`.
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
    expect(new WorkspaceModeUnsupportedError("worktree", ["read-only"], "no git")).toMatchObject({
      code: "workspace.mode_unsupported",
      httpStatus: 400,
    });

    // The three unratified rows take the mapper's `-32603` default rather than a
    // numeric this module selected — the discipline `./repo-errors.js` sets.
    expect(new WorkspaceStaleError(null).jsonRpcCode).toBeUndefined();
    expect(new WorkspaceBusyError(UNKNOWN_WORKSPACE_ID, null).jsonRpcCode).toBeUndefined();
    expect(
      new WorkspaceModeUnsupportedError("branch", ["read-only"], "no git").jsonRpcCode,
    ).toBeUndefined();
  });

  it("copies availableModes, so a later mutation cannot rewrite a thrown error", () => {
    // `RepoDetachConflictError`'s discipline, applied to the one carrier here
    // that accepts an array: both the own field and the wire `detail` hold
    // copies. A caller that keeps mutating the array it passed — the capability
    // matrix's `availableModes` is a shared value — must not be able to change
    // what an already-thrown refusal says it offered.
    const availableModes: ExecutionMode[] = ["read-only", "branch"];
    const refusal = new WorkspaceModeUnsupportedError("worktree", availableModes, "no git");
    availableModes.push("ephemeral clone");

    expect(refusal.availableModes).toEqual(["read-only", "branch"]);
    expect(refusal.detail?.["availableModes"]).toEqual(["read-only", "branch"]);
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

    // Deliberately NOT a `DaemonDomainError`: minting an unregistered
    // `workspace.*` code is banned, and borrowing a registered one would tell a
    // caller to repair the wrong thing.
    expect(invariantFailure).toBeInstanceOf(Error);
    expect("code" in invariantFailure).toBe(false);
    expect(invariantFailure.name).toBe("WorkspaceServiceInvariantError");
    expect((invariantFailure.cause as Error).message).toBe("root cause");
  });
});
