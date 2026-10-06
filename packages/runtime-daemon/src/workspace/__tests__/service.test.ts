// Proves WorkspaceService never persists a workspace outside its mount or for a missing session,
// scrubs credentials from a recorded failure, turns a vanished root into a persisted `stale`, and
// grants a run hold to exactly one run. Real SQLite, event log and directories.

import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WorkspaceListResponseSchema,
  WORKSPACE_LAST_ERROR_MAX_LEN,
} from "@ai-sidekicks/contracts/repo/workspace";
import type { RepoMountId, WorkspaceState } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { EventLogService } from "../../events/log-service.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { openDatabase } from "../../session/migration-runner.js";
import { TrustEnvelopeViolationError } from "../repo/errors.js";
import { TrustEnvelopeValidator } from "../trust-envelope.js";
import { WorkspaceEventEmitter } from "../event-emitter.js";
import type { FilesystemPathProbe } from "../projector.js";
import {
  normalizeWorkspaceLastError,
  scrubCredentials,
  WORKSPACE_LAST_ERROR_TRUNCATION_MARKER,
} from "../last-error.js";
import {
  WorkspaceBusyError,
  WorkspaceServiceInvariantError,
  WorkspaceStaleError,
} from "../errors.js";
import {
  WorkspaceService,
  type SessionExistenceReader,
  type WorkspaceServiceDeps,
} from "../service.js";
import { type FilesystemPathProbeFn } from "../row-guards.js";

import { bindReadyWorkspace } from "../__fixtures__/bound-root.js";
import { readWorkspaceRow, requireWorkspaceRow } from "../__fixtures__/rows.js";
import { captureRejection } from "../../__fixtures__/capture-failure.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Real UUIDs, because every id crosses a branded UUID schema on some path; branded here so
// request shapes need no cast at each call site.
const SESSION_ID: SessionId = "0190f8b0-0000-7000-8000-000000000001" as SessionId;
const OTHER_SESSION_ID: SessionId = "0190f8b0-0000-7000-8000-000000000002" as SessionId;
const GIT_MOUNT_ID: RepoMountId = "0190f8b1-0000-7000-8000-000000000001" as RepoMountId;
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
  rebuildSession: (sessionId) => (sessionId === SESSION_ID ? { sessionId } : null),
};

/** What a bind that its preparation then completes appends, in order. */
const READY_BIND_EVENTS: readonly string[] = ["workspace.preparing", "workspace.ready"];

interface TestHarness {
  readonly db: DatabaseType;
  readonly emitter: WorkspaceEventEmitter;
  readonly service: WorkspaceService;
  readonly tmpDir: string;
  readonly gitMountRoot: string;
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
}

function insertMount(fixture: MountFixture): void {
  const now = new Date().toISOString();
  harness.db
    .prepare(
      `INSERT INTO repo_mounts (
         id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at, metadata
       ) VALUES (@id, @node_id, @local_path, @canonical_root, 'git', 'attached', @now, @now, '{}')`,
    )
    .run({
      id: fixture.id,
      node_id: "node-local",
      local_path: fixture.canonicalRoot,
      canonical_root: fixture.canonicalRoot,
      now,
    });
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
  return JSON.parse(requireWorkspaceRow(harness.db, workspaceId).metadata) as Record<
    string,
    unknown
  >;
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

  // `siblingRoot` exists so the traversal arm fails on containment rather than on absence.
  const gitMountRoot: string = join(tmpDir, "repos", "git-mount");
  const siblingRoot: string = join(tmpDir, "repos", "sibling");
  for (const directory of [gitMountRoot, siblingRoot]) {
    mkdirSync(directory, { recursive: true });
  }

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
    siblingRoot,
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// bind
// ----------------------------------------------------------------------------

describe("bind", () => {
  beforeEach(() => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
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
});

// ----------------------------------------------------------------------------
// root preparation cycle
// ----------------------------------------------------------------------------

describe("root preparation cycle", () => {
  let workspaceId: string;

  beforeEach(async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    workspaceId = await bindReadyWorkspace(
      harness.service,
      SESSION_ID,
      GIT_MOUNT_ID,
      harness.gitMountRoot,
    );
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
    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe(
      "preparing" satisfies WorkspaceState,
    );
    expect(readWorkspaceRow(harness.db, workspaceId)?.fs_root).toBeNull();

    // Negative control: a guard that refused everything would pass the loop above. The check
    // reads path shape only, so the Windows forms pass on a POSIX host too.
    const completeRoots = ["/repos/app", "C:\\repos\\app", "C:/repos/app", "\\\\server\\share"];
    for (const completeRoot of completeRoots) {
      await harness.service.completeRootPreparation(workspaceId, completeRoot);
      expect(readWorkspaceRow(harness.db, workspaceId)?.fs_root).toBe(completeRoot);
      await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    }
  });

  it("records a scrubbed failure detail and lands the row `stale`", async () => {
    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    await harness.service.failRootPreparation(
      workspaceId,
      "fatal: could not read from https://octocat:ghp_abcdefghijklmnop@github.com/acme/repo.git",
    );

    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe("stale" satisfies WorkspaceState);

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

    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    // A `ready` workspace must not keep advertising a failure that was fixed.
    expect(readWorkspaceMetadata(workspaceId)["lastError"]).toBeUndefined();
  });

  it("refuses to prepare a held workspace with `workspace.busy`", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);

    const refusal = await captureRejection(() =>
      harness.service.beginRootPreparation(workspaceId, "provisioned-worktree"),
    );

    expect(refusal).toBeInstanceOf(WorkspaceBusyError);
    expect((refusal as WorkspaceBusyError).holdingRunId).toBe(RUN_ID);
    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe("busy" satisfies WorkspaceState);
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

  it("scrubs the credential before cutting, so no recognizable fragment survives", () => {
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

  it("scrubs the credential shapes a preparation failure realistically carries", () => {
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
    const workspaceId = await bindReadyWorkspace(
      harness.service,
      SESSION_ID,
      GIT_MOUNT_ID,
      harness.gitMountRoot,
    );
    await harness.service.beginRootPreparation(workspaceId, "provisioned-worktree");
    await harness.service.failRootPreparation(workspaceId, "  \n\t   ");

    // `wireFreeFormString` requires `.min(1)`, one non-whitespace character and no NUL;
    // persisting an illegal value would make the list response that reports this failure
    // unrepresentable.
    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(workspaceId)["lastError"]).toBeUndefined();

    const response = await harness.service.list({ sessionId: SESSION_ID });
    expect(response.workspaces[0]?.lastError).toBeUndefined();
    expect(() => WorkspaceListResponseSchema.parse(response)).not.toThrow();
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
});

// ----------------------------------------------------------------------------
// assertWritable
// ----------------------------------------------------------------------------

describe("assertWritable", () => {
  let workspaceId: string;

  beforeEach(async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    workspaceId = await bindReadyWorkspace(
      harness.service,
      SESSION_ID,
      GIT_MOUNT_ID,
      harness.gitMountRoot,
    );
  });

  it("passes a ready workspace", async () => {
    await expect(harness.service.assertWritable(workspaceId)).resolves.toBeUndefined();
    // The gate observed the row; it did not change it.
    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe("ready" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual(READY_BIND_EVENTS);
  });

  it("throws the typed `workspace.stale` refusal for a stale workspace", async () => {
    harness.db.prepare("UPDATE workspaces SET state = 'stale' WHERE id = ?").run(workspaceId);

    const refusal = await captureRejection(() => harness.service.assertWritable(workspaceId));

    expect(refusal).toBeInstanceOf(WorkspaceStaleError);
    expect((refusal as WorkspaceStaleError).code).toBe("workspace.stale");
    expect((refusal as WorkspaceStaleError).workspaceId).toBe(workspaceId);
  });

  it("catches a root that vanished since the last read, and persists the transition", async () => {
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    await expect(harness.service.assertWritable(workspaceId)).rejects.toBeInstanceOf(
      WorkspaceStaleError,
    );
    // The refusal is not a private verdict: the next reader sees the row stale too.
    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);
  });
});

// ----------------------------------------------------------------------------
// markBusy / releaseBusy / markStale — and a held workspace that keeps its hold
// ----------------------------------------------------------------------------

describe("run holds", () => {
  let workspaceId: string;

  beforeEach(async () => {
    insertMount({ id: GIT_MOUNT_ID, canonicalRoot: harness.gitMountRoot });
    workspaceId = await bindReadyWorkspace(
      harness.service,
      SESSION_ID,
      GIT_MOUNT_ID,
      harness.gitMountRoot,
    );
  });

  it("refuses a second holder with `workspace.busy`, naming the incumbent", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);

    const refusal = await captureRejection(() =>
      harness.service.markBusy(workspaceId, OTHER_RUN_ID),
    );

    expect(refusal).toBeInstanceOf(WorkspaceBusyError);
    expect((refusal as WorkspaceBusyError).code).toBe("workspace.busy");
    // The loser's only repair affordance: `repo.detach_conflict` names the running session, not
    // its run, so only this refusal names the run that holds the workspace.
    expect((refusal as WorkspaceBusyError).holdingRunId).toBe(RUN_ID);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBe(RUN_ID);
  });

  it("keeps a run's hold while its root is gone; the row goes stale once released", async () => {
    await harness.service.markBusy(workspaceId, RUN_ID);
    rmSync(harness.gitMountRoot, { recursive: true, force: true });

    const whileHeld = await harness.service.list({ sessionId: SESSION_ID });

    // The read reports the vanished root, and the run keeps the workspace it holds: no other run
    // can take it, and the hold still names the run that has it.
    expect(whileHeld.workspaces[0]?.state).toBe("stale" satisfies WorkspaceState);
    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe("busy" satisfies WorkspaceState);
    expect(readWorkspaceMetadata(workspaceId)["holdingRunId"]).toBe(RUN_ID);
    expect(readEventTypes()).toEqual(READY_BIND_EVENTS);

    expect(harness.service.releaseBusy(workspaceId)).toBe(true);
    await harness.service.list({ sessionId: SESSION_ID });

    // The first read after the release stales it, so no new run starts on the missing root.
    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);
  });

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
    expect(readWorkspaceRow(harness.db, workspaceId)?.state).toBe("stale" satisfies WorkspaceState);
    expect(readEventTypes()).toEqual([...READY_BIND_EVENTS, "workspace.stale"]);
  });

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
});
