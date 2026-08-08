// EphemeralCloneService — Plan-010 Phase 2, T2.3.
//
// Drives the real service over a real test SQLite database (the same lifecycle
// as the T2.1 and T2.2 suites: `openDatabase` factory → per-test tmp file →
// `afterEach` close + remove), with a RECORDING fake git runner in place of the
// child process and the REAL Plan-009 `WorkspaceService` behind the injected
// reprovision primitive.
//
// Two harness choices carry most of the evidential weight:
//
//   * The fake git is what makes the invocation-shape invariants assertable.
//     argv is the whole invocation (the seam takes no `cwd`), so a recorded argv
//     is the complete claim about what git was asked to do. It MATERIALIZES the
//     clone target, because several arms depend on a root that really exists —
//     a retirement has to be observed NOT removing one, and a tick has to be
//     observed removing it.
//   * The disposition arms drive a real `WorkspaceService` + `WorkspaceEventEmitter`
//     rather than a stub. `Spec-010 §Fallback Behavior`'s claim is that the
//     workspace lands in `provisioning` and not in `stale`, and only the real
//     primitive can be wrong about that. Reaching `ready` and `busy` likewise
//     goes through `completeReprovision` and `markBusy` rather than through raw
//     UPDATEs, so the states the deferral guard reads are states Plan-009 itself
//     produced.
//
// Coverage map (the cites are the contract, not just the ACs):
//   * `Spec-010 §Required Behavior` — an `ephemeral clone`-mode prepare
//     provisions a disposable isolated clone: the row, the D-010-6 root, the
//     created head branch, and the reported policy / expiry / branch.
//   * `Spec-010 §Default Behavior` — every provisioning git invocation
//     neutralizes hook execution at the invocation layer.
//   * `Spec-010 §Fallback Behavior` — a failed preparation records the failure
//     and refuses rather than substituting anything; retirement is recorded with
//     the root left on disk, and a sweep tick — the same one or a later one —
//     removes that ROOT and stamps `cleaned_at`; no row is ever deleted, which
//     is what makes the retirement queryable (I-010-9); retiring the clone
//     backing a live clone-mode workspace's current root returns that workspace
//     to `provisioning`, never to `stale`.
//   * `Spec-010 §Resolved Questions and V1 Scope Decisions` — the TTL is daemon
//     configuration (a prepare accepts none, and the default is 24 hours), and
//     NO clone transition is separately evented (D-010-11).
//
// Verifies invariant: I-010-9 (a retirement leaves `cleaned_at` NULL and the
// root on disk; only a tick removes and stamps, and a second tick does not move
// the stamp), I-010-10 (EVERY recorded invocation carries
// `-c core.hooksPath=<empty dir>`, asserted over a full prepare / dispose / tick
// lifecycle rather than over one call, and the directory is empty — an empty
// directory is the mechanism).
//
// Also pinned here, each with its negative control: an UNEXPIRED clone survives
// a tick (without which "the expired one was retired" does not discriminate), a
// `manual` clone survives the run-terminal path, and a busy-held clone is
// neither retired nor removed.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { openDatabase } from "../../session/migration-runner.js";
import { RepoMountNotFoundError } from "../../workspace/repo-errors.js";
import { WorkspaceEventEmitter } from "../../workspace/workspace-event-emitter.js";
import {
  WorkspaceModeUnsupportedError,
  WorkspaceNotFoundError,
  WorkspaceService,
} from "../../workspace/workspace-service.js";
import { EphemeralCloneService } from "../ephemeral-clone-service.js";
import type {
  EphemeralCloneGitInvocationResult,
  EphemeralCloneGitRunner,
  EphemeralCloneServiceDeps,
} from "../ephemeral-clone-service.js";
import { CloneNotFoundError, ClonePrepareFailedError } from "../worktree-errors.js";
import type { ClonePrepareFailureReason } from "../worktree-errors.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Clone ids travel `EphemeralCloneIdSchema.parse` on `dispose`'s response, and
// session / workspace ids travel branded schemas at the emission boundary, so
// every fixture is a real UUID.
const SESSION_ID: string = "0190fa10-1c2d-7e3f-8a4b-5c6d7e8f9a01";
const REPO_MOUNT_ID: string = "0190fa11-2d3e-7f40-9b5c-6d7e8f9a0b12";
const WORKSPACE_ID: string = "0190fa12-3e4f-7051-8c6d-7e8f9a0b1c23";
const OTHER_WORKSPACE_ID: string = "0190fa13-4f50-7162-9d7e-8f9a0b1c2d34";
const RUN_ID: string = "0190fa14-5061-7273-8e8f-9a0b1c2d3e45";
const UNKNOWN_CLONE_ID: string = "0190fa15-6172-7384-9f90-0b1c2d3e4f56";
const UNKNOWN_WORKSPACE_ID: string = "0190fa16-7283-7495-8a01-1c2d3e4f5067";

const CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-clone-mount";
const BRANCH_NAME: string = "sidekicks/0190fa10/fix-login";
// The branch `git clone` leaves HEAD on in the fixture repository. A prepare
// asking for THIS name is the reachable collision the service's residual names.
const SOURCE_DEFAULT_BRANCH: string = "main";
const EPOCH: string = "2026-08-06T00:00:00.000Z";
const ONE_HOUR_MS: number = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS: number = 24 * ONE_HOUR_MS;

/** A fixed-key signing source — enough for a suite that only ever signs. */
const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(7) as Ed25519PrivateKey;

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

// ----------------------------------------------------------------------------
// The recording fake git
// ----------------------------------------------------------------------------

interface RecordedGitInvocation {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

function resolveGit(stdout: string): Promise<EphemeralCloneGitInvocationResult> {
  return Promise.resolve({ stdout, stderr: "" });
}

/**
 * The verb of a recorded invocation, found by SKIPPING the leading option pairs
 * rather than by a fixed index.
 *
 * `./worktree-service.test.ts` can read its verb at index 4 because every one of
 * that service's invocations carries `-C <dir>`. This service's do not: `clone`
 * addresses its source and target positionally and has no `-C`, so a fixed index
 * would read `clone`'s SOURCE PATH as the verb of one shape and the real verb of
 * the other — and a fixture that mis-identifies a verb answers the wrong stub.
 */
function gitVerb(argv: readonly string[]): string | undefined {
  let index = 0;
  while (index < argv.length) {
    const token: string | undefined = argv[index];
    if (token === "-c" || token === "-C") {
      index += 2;
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * Records every invocation and answers the two verbs the service issues.
 *
 * `clone` MATERIALIZES its target, so the arms that watch a root survive a
 * retirement and disappear in a tick have a real directory to watch.
 *
 * `checkout -b` refuses a name in {@link existingBranchNames}, which MODELS
 * git's own behavior — `fatal: a branch named '<name>' already exists` — and is
 * seeded with the source's default branch, because a clone's HEAD sits on it.
 * The model is what makes the collision arm below a recorded decision; the
 * real-git evidence for it belongs to T2.6's acceptance tier.
 *
 * An unrecognized verb REJECTS rather than resolving empty. A fixture that
 * shrugged at an unknown invocation would let a new git call into the service
 * without a single case noticing, and the universal-quantifier claim about hook
 * neutralization is exactly the one such a call would escape.
 */
class FakeCloneGit {
  readonly invocations: RecordedGitInvocation[] = [];
  cloneFails: boolean = false;
  readonly existingBranchNames: Set<string> = new Set([SOURCE_DEFAULT_BRANCH]);

  readonly run: EphemeralCloneGitRunner = (argv, options) => {
    this.invocations.push({ argv: [...argv], timeoutMs: options.timeoutMs });
    const verb: string | undefined = gitVerb(argv);

    if (verb === "clone") {
      if (this.cloneFails) {
        return Promise.reject(new Error("fatal: could not create work tree dir"));
      }
      // The target is the last positional of `clone [<flags>] <source> <target>`.
      const targetRoot: string | undefined = argv[argv.length - 1];
      if (targetRoot !== undefined) {
        mkdirSync(targetRoot, { recursive: true });
        writeFileSync(join(targetRoot, "README.md"), "fixture\n");
      }
      return resolveGit("");
    }

    if (verb === "checkout") {
      const branchName: string | undefined = argv[argv.length - 1];
      if (branchName !== undefined && this.existingBranchNames.has(branchName)) {
        return Promise.reject(new Error(`fatal: a branch named '${branchName}' already exists`));
      }
      return resolveGit("");
    }

    return Promise.reject(new Error(`unexpected git verb in fixture: ${String(verb)}`));
  };

  verbs(): readonly (string | undefined)[] {
    return this.invocations.map((invocation) => gitVerb(invocation.argv));
  }

  argvFor(verb: string): readonly string[] {
    const found = this.invocations.find((invocation) => gitVerb(invocation.argv) === verb);
    if (found === undefined) {
      throw new Error(`no recorded git invocation for verb "${verb}"`);
    }
    return found.argv;
  }
}

// ----------------------------------------------------------------------------
// Per-test lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  workspaces: WorkspaceService;
  git: FakeCloneGit;
  executionRootsDirectory: string;
  hookNeutralizationDirectory: string;
  tmpDir: string;
  /** MUTABLE: the TTL arms move it past an `expires_at`. */
  currentInstantMs: number;
}

let ctx: TestContext;

/**
 * A clock that does NOT advance on its own.
 *
 * Every timestamp in a case is therefore the instant the case put on the clock,
 * which is what lets the TTL arms be exact: a clone prepared at the epoch
 * expires at `epoch + ttl`, and whether the tick retires it is decided by
 * {@link advanceClock} alone rather than by how many times the service happened
 * to read the clock.
 */
function clock(): string {
  return new Date(ctx.currentInstantMs).toISOString();
}

function advanceClock(milliseconds: number): void {
  ctx.currentInstantMs += milliseconds;
}

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-ephemeral-clone-test-"));
  const db: DatabaseType = openDatabase(join(tmpDir, "test.db"));
  const executionRootsDirectory: string = join(tmpDir, "execution-roots");
  ctx = {
    db,
    // `clock` reads `ctx`, and is only CALLED once `ctx` is assigned — passing
    // the reference during construction is what lets both services share one
    // clock without a placeholder.
    workspaces: new WorkspaceService({
      database: db,
      events: new WorkspaceEventEmitter({
        sessionEvents: new EventLogService({
          db,
          signingKeySource: new FixedDaemonSigningKeySource(),
        }),
      }),
      now: clock,
    }),
    git: new FakeCloneGit(),
    executionRootsDirectory,
    hookNeutralizationDirectory: join(executionRootsDirectory, ".hook-neutralization"),
    tmpDir,
    currentInstantMs: Date.parse(EPOCH),
  };
  insertAttachedMount();
});

afterEach(() => {
  // The per-session append lock is a MODULE SINGLETON — a case that left a queue
  // entry behind would stall the next case on the same session id.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeService(overrides: Partial<EphemeralCloneServiceDeps> = {}): EphemeralCloneService {
  return new EphemeralCloneService({
    database: ctx.db,
    executionRootsDirectory: ctx.executionRootsDirectory,
    // The REAL Plan-009 primitive (CP-010-2), wired exactly as a composition
    // root would wire it.
    beginWorkspaceReprovision: (workspaceId, targetMode) =>
      ctx.workspaces.beginReprovision(workspaceId, targetMode),
    git: ctx.git.run,
    now: clock,
    ...overrides,
  });
}

// ----------------------------------------------------------------------------
// Row fixtures and reads
// ----------------------------------------------------------------------------

/** The suite's single attached git mount. `vcs_type` takes its `'git'` default. */
function insertAttachedMount(): void {
  const statement = ctx.db.prepare(
    `INSERT INTO repo_mounts (
       id, session_id, node_id, local_path, canonical_root, state, attached_at, updated_at
     ) VALUES (?, ?, 'node-1', ?, ?, 'attached', ?, ?)`,
  );
  statement.run(REPO_MOUNT_ID, SESSION_ID, CANONICAL_ROOT, CANONICAL_ROOT, EPOCH, EPOCH);
}

/**
 * Seed a clone-mode workspace in `provisioning` with no execution root — the
 * state a per-run prepare starts from.
 *
 * Raw INSERT rather than `WorkspaceService.create`: every case that cares about
 * a TRANSITION drives the real Plan-009 primitives from here
 * (`completeReprovision`, `markBusy`), so the states this service's guards read
 * are states Plan-009 itself produced. Cases that only need a row in some other
 * state say so with a one-line UPDATE at the point they need it, where the
 * reason is visible.
 */
function insertWorkspace(workspaceId: string = WORKSPACE_ID): void {
  const statement = ctx.db.prepare(
    `INSERT INTO workspaces (
       id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at
     ) VALUES (
       @id, @session_id, @repo_mount_id, 'ephemeral clone', NULL, 'provisioning', @now, @now
     )`,
  );
  statement.run({
    id: workspaceId,
    session_id: SESSION_ID,
    repo_mount_id: REPO_MOUNT_ID,
    now: EPOCH,
  });
}

/**
 * `updated_at` is selected deliberately: the idempotence arm asserts the WHOLE
 * row is unchanged by a second `dispose`, and a stamp that moved is the only
 * evidence a compare-and-swap ran again on a row already in its terminal state.
 */
interface CloneTestRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly clone_root: string;
  readonly branch_name: string;
  readonly cleanup_policy: string;
  readonly state: string;
  readonly expires_at: string;
  readonly updated_at: string;
  readonly cleaned_at: string | null;
}

function readCloneRow(cloneId: string): CloneTestRow {
  const statement = ctx.db.prepare<[string], CloneTestRow>(
    `SELECT id, workspace_id, clone_root, branch_name, cleanup_policy, state,
            expires_at, updated_at, cleaned_at
       FROM ephemeral_clones
      WHERE id = ?`,
  );
  const row = statement.get(cloneId);
  if (row === undefined) {
    throw new Error(`expected an ephemeral_clones row for ${cloneId}`);
  }
  return row;
}

/**
 * The id of the single clone a case expects to exist, unwrapped once.
 *
 * `noUncheckedIndexedAccess` makes `ids[0]` a `string | undefined`, so the
 * unwrap has to happen somewhere; doing it here keeps the cases that only need
 * "the row that was just written" free of the ceremony — and the count check
 * makes "exactly one row" part of what each of them asserts.
 */
function readSoleCloneId(): string {
  const ids = ctx.db
    .prepare<[], { id: string }>(`SELECT id FROM ephemeral_clones`)
    .all()
    .map((row) => row.id);
  const soleId = ids[0];
  if (ids.length !== 1 || soleId === undefined) {
    throw new Error(`expected exactly one ephemeral_clones row, found ${ids.length}`);
  }
  return soleId;
}

interface WorkspaceTestRow {
  readonly state: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
}

function readWorkspaceRow(workspaceId: string = WORKSPACE_ID): WorkspaceTestRow {
  const statement = ctx.db.prepare<[string], WorkspaceTestRow>(
    `SELECT state, execution_mode, fs_root FROM workspaces WHERE id = ?`,
  );
  const row = statement.get(workspaceId);
  if (row === undefined) {
    throw new Error(`expected a workspaces row for ${workspaceId}`);
  }
  return row;
}

function readEventTypes(): readonly string[] {
  const statement = ctx.db.prepare<[string], { type: string }>(
    `SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence ASC`,
  );
  return statement.all(SESSION_ID).map((row) => row.type);
}

async function captureRejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected the operation to reject");
}

/** The happy path: a workspace row plus a `ready` clone against it. */
async function prepareReadyClone(
  service: EphemeralCloneService,
  workspaceId: string = WORKSPACE_ID,
): Promise<string> {
  const prepared = await service.prepare({ workspaceId, branchName: BRANCH_NAME });
  return prepared.cloneId;
}

/**
 * Take the workspace from `provisioning` to `ready` on the prepared clone, the
 * way T2.4's orchestrator will: through Plan-009's own primitive, so the state
 * the deferral guard and the disposition read is one Plan-009 produced.
 */
async function adoptCloneAsExecutionRoot(cloneId: string): Promise<string> {
  const cloneRoot = readCloneRow(cloneId).clone_root;
  await ctx.workspaces.completeReprovision(WORKSPACE_ID, cloneRoot);
  return cloneRoot;
}

// ----------------------------------------------------------------------------
// prepare
// ----------------------------------------------------------------------------

describe("EphemeralCloneService.prepare (`Spec-010 §Required Behavior`)", () => {
  beforeEach(() => {
    insertWorkspace();
  });

  it("reports the effective policy, expiry and branch, and persists all three", async () => {
    const service = makeService();

    const prepared = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME });

    expect(prepared.state).toBe("ready");
    expect(prepared.workspaceId).toBe(WORKSPACE_ID);
    expect(prepared.branchName).toBe(BRANCH_NAME);
    expect(prepared.cleanupPolicy).toBe("on_run_complete");
    // `Spec-010 §Resolved Questions and V1 Scope Decisions`: the default TTL is
    // 24 hours, and it is daemon configuration — the request carried none.
    expect(prepared.expiresAt).toBe(
      new Date(Date.parse(EPOCH) + TWENTY_FOUR_HOURS_MS).toISOString(),
    );

    const row = readCloneRow(prepared.cloneId);
    expect(row.state).toBe("ready");
    expect(row.workspace_id).toBe(WORKSPACE_ID);
    expect(row.branch_name).toBe(BRANCH_NAME);
    expect(row.cleanup_policy).toBe("on_run_complete");
    expect(row.expires_at).toBe(prepared.expiresAt);
    expect(row.clone_root).toBe(prepared.cloneRoot);
    expect(row.cleaned_at).toBeNull();
  });

  it("honours an explicitly requested `manual` cleanup policy", async () => {
    const service = makeService();

    const prepared = await service.prepare({
      workspaceId: WORKSPACE_ID,
      branchName: BRANCH_NAME,
      cleanupPolicy: "manual",
    });

    expect(prepared.cleanupPolicy).toBe("manual");
    expect(readCloneRow(prepared.cloneId).cleanup_policy).toBe("manual");
  });

  it("honours a configured TTL, which no request can override", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });

    const prepared = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME });

    expect(prepared.expiresAt).toBe(new Date(Date.parse(EPOCH) + ONE_HOUR_MS).toISOString());
  });

  it("places the clone root at the D-010-6 path", async () => {
    const service = makeService();

    const prepared = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME });

    expect(prepared.cloneRoot).toBe(
      join(ctx.executionRootsDirectory, REPO_MOUNT_ID, "clones", prepared.cloneId),
    );
    expect(existsSync(prepared.cloneRoot)).toBe(true);
  });

  it("clones the canonical root and then creates the caller's branch in the clone", async () => {
    const service = makeService();

    const prepared = await service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME });

    expect(ctx.git.verbs()).toEqual(["clone", "checkout"]);
    // Both `clone` positionals are daemon-derived; the caller's branch name
    // rides the VALUE slot of `-b`, which is what keeps it out of git's option
    // parser.
    const cloneArgv = ctx.git.argvFor("clone");
    expect(cloneArgv.slice(2)).toEqual([
      "clone",
      "--no-hardlinks",
      CANONICAL_ROOT,
      prepared.cloneRoot,
    ]);
    // Pinned separately from the argv shape. Dropping the flag lets git hardlink
    // `.git/objects/**` into the clone, and the hazard is MUTATION, not removal —
    // unlinking one link never harms the other. CP-009-8 hands this root to
    // Plan-012 as an approval scope, so a tool writing inside a scope that looks
    // disposable would be writing files that ARE the user's repository.
    expect(cloneArgv).toContain("--no-hardlinks");
    expect(ctx.git.argvFor("checkout")).toEqual([
      "-c",
      `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
      "-C",
      prepared.cloneRoot,
      "checkout",
      "-b",
      BRANCH_NAME,
    ]);
  });

  it("records the failure and refuses when the clone invocation fails", async () => {
    const service = makeService();
    ctx.git.cloneFails = true;

    const failure = await captureRejection(
      service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME }),
    );

    expect(failure).toBeInstanceOf(ClonePrepareFailedError);
    expect((failure as ClonePrepareFailedError).code).toBe("clone.prepare_failed");
    expect((failure as ClonePrepareFailedError).reason).toBe("clone_invocation_failed");
    // `Spec-010 §Fallback Behavior`: the row survives as the queryable incident
    // (it is the only trail a clone failure has — D-010-11), and nothing was
    // substituted.
    expect(readCloneRow(readSoleCloneId()).state).toBe("failed");
  });

  it("refuses a branch name that already exists in the clone rather than binding it", async () => {
    // The clone's HEAD sits on the source's default branch, so `checkout -b main`
    // asks git to create a branch that is already there. Pinned as a DECISION:
    // this seam creates the head branch (the task row's wording) and does not
    // silently bind an existing one. What stays open is the STATUS — whether a
    // clone head-branch collision deserves a 409 row of its own, the way the
    // worktree surface has one — recorded at the service's header.
    const service = makeService();

    const failure = await captureRejection(
      service.prepare({ workspaceId: WORKSPACE_ID, branchName: SOURCE_DEFAULT_BRANCH }),
    );

    expect(failure).toBeInstanceOf(ClonePrepareFailedError);
    expect((failure as ClonePrepareFailedError).reason).toBe("head_branch_unavailable");
    expect(ctx.git.verbs()).toEqual(["clone", "checkout"]);
    expect(readCloneRow(readSoleCloneId()).state).toBe("failed");
  });

  it("refuses when the clone-roots directory cannot be created", async () => {
    const cloneRootsDirectory = join(ctx.executionRootsDirectory, REPO_MOUNT_ID, "clones");
    const service = makeService({
      filesystem: {
        async createDirectory(path: string): Promise<void> {
          if (path === cloneRootsDirectory) {
            throw new Error("EACCES: permission denied, mkdir");
          }
          mkdirSync(path, { recursive: true });
        },
        async removeDirectory(path: string): Promise<void> {
          rmSync(path, { recursive: true, force: true });
        },
      },
    });

    const failure = await captureRejection(
      service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME }),
    );

    expect(failure).toBeInstanceOf(ClonePrepareFailedError);
    expect((failure as ClonePrepareFailedError).reason).toBe("execution_root_unavailable");
    // The D-010-6 root is prepared before anything is spawned, so this arm is
    // reached with no git call at all — which is what distinguishes it from the
    // clone-invocation arm above.
    expect(ctx.git.invocations).toHaveLength(0);
    expect(readCloneRow(readSoleCloneId()).state).toBe("failed");
  });

  it("reports the preparation failure even when cleaning the failed root fails", async () => {
    const service = makeService({
      filesystem: {
        async createDirectory(path: string): Promise<void> {
          mkdirSync(path, { recursive: true });
        },
        async removeDirectory(): Promise<void> {
          throw new Error("EBUSY: resource busy or locked, rmdir");
        },
      },
    });
    ctx.git.cloneFails = true;

    const failure = await captureRejection(
      service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME }),
    );

    // The swallow in `#recordPrepareFailure` is scoped to the CLEANUP: the
    // caller still learns why provisioning failed rather than why the tidy-up
    // did, which is the only reason swallowing is defensible there.
    expect(failure).toBeInstanceOf(ClonePrepareFailedError);
    expect((failure as ClonePrepareFailedError).reason).toBe("clone_invocation_failed");
    // And the row still records the incident — the queryable trail survives the
    // failed removal, which is what makes the leaked directory recoverable.
    expect(readCloneRow(readSoleCloneId()).state).toBe("failed");
  });

  it("reports `concurrently_retired` when the row leaves `creating` during git", async () => {
    // Modelled deterministically rather than with real concurrency: the row is
    // moved out of `creating` while materialization is in flight, which is what
    // a `dispose` or a sweep interleaved with the clone does to it.
    const service = makeService({
      git: async (argv, options) => {
        const result = await ctx.git.run(argv, options);
        if (gitVerb(argv) === "checkout") {
          // No WHERE clause: the fixture holds exactly one clone row, and
          // `readSoleCloneId` below fails the test if that ever stops being
          // true, so naming the id here would only restate a guard the
          // assertions already carry.
          ctx.db.prepare(`UPDATE ephemeral_clones SET state = 'retired'`).run();
        }
        return result;
      },
    });

    const failure = await captureRejection(
      service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME }),
    );

    expect(failure).toBeInstanceOf(ClonePrepareFailedError);
    expect((failure as ClonePrepareFailedError).reason).toBe("concurrently_retired");
    // NOT `failed`, and that is the assertion that proves this is the
    // compare-and-swap arm rather than the materialization one: the CAS arm
    // deliberately records no failure over a row another path already retired,
    // leaving the directory to leg (d).
    const cloneId = readSoleCloneId();
    expect(readCloneRow(cloneId).state).toBe("retired");
    // And the ROOT SURVIVES. This is the assertion that pins the decision rather
    // than the outcome: routing this arm through `#recordPrepareFailure` would
    // satisfy every check above — its `state = 'creating'` predicate simply
    // no-ops on the already-retired row — while its best-effort `removeDirectory`
    // deleted the directory. On a clone the concurrent retirement was a `dispose`
    // of a BUSY-held workspace, that directory is a running run's execution root.
    expect(existsSync(readCloneRow(cloneId).clone_root)).toBe(true);
  });

  it("raises `workspace.not_found` before any git runs when the workspace is unknown", async () => {
    const service = makeService();

    const failure = await captureRejection(
      service.prepare({ workspaceId: UNKNOWN_WORKSPACE_ID, branchName: BRANCH_NAME }),
    );

    expect(failure).toBeInstanceOf(WorkspaceNotFoundError);
    expect(ctx.git.invocations).toHaveLength(0);
    expect(ctx.db.prepare(`SELECT id FROM ephemeral_clones`).all()).toHaveLength(0);
  });

  it("raises `repo.not_found` when the owning mount is no longer attached", async () => {
    ctx.db.prepare(`UPDATE repo_mounts SET state = 'detached' WHERE id = ?`).run(REPO_MOUNT_ID);
    const service = makeService();

    const failure = await captureRejection(
      service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME }),
    );

    expect(failure).toBeInstanceOf(RepoMountNotFoundError);
    expect(ctx.git.invocations).toHaveLength(0);
  });

  it("names no filesystem path in any typed carrier", async () => {
    const service = makeService();
    ctx.git.cloneFails = true;

    const prepareFailure = await captureRejection(
      service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME }),
    );
    const notFound = await captureRejection(service.dispose(UNKNOWN_CLONE_ID));

    expect(notFound).toBeInstanceOf(CloneNotFoundError);
    // EVERY member of the taxonomy, not only the one the arm above drives. The
    // §Ephemeral Clone ban is on the message TABLE, so the way a path would
    // enter it is through a member no live arm in this suite happens to reach.
    // Keyed as a total `Record`: a fifth member added to the union without a row
    // here fails to compile rather than silently escaping the guard.
    const everyPrepareCarrier: Record<ClonePrepareFailureReason, ClonePrepareFailedError> = {
      execution_root_unavailable: new ClonePrepareFailedError("execution_root_unavailable"),
      clone_invocation_failed: new ClonePrepareFailedError("clone_invocation_failed"),
      head_branch_unavailable: new ClonePrepareFailedError("head_branch_unavailable"),
      concurrently_retired: new ClonePrepareFailedError("concurrently_retired"),
    };

    for (const failure of [prepareFailure, notFound, ...Object.values(everyPrepareCarrier)]) {
      const message = (failure as Error).message;
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(ctx.tmpDir);
      expect(message).not.toContain(ctx.executionRootsDirectory);
      expect(message).not.toContain(CANONICAL_ROOT);
      // The structural form of the same ban, mirroring the T2.2 suite: no path
      // SEPARATOR at all, which holds whatever the fixture's tmp paths happen to
      // be. The three checks above stay because they catch a message that echoed
      // a bare directory name.
      expect(message).not.toMatch(/[\\/]/);
    }

    // The wire projection of the discriminant, asserted here because it is
    // asserted nowhere else in either suite: `mapJsonRpcError` puts `detail`
    // on the envelope as `data.fields`, so this is the shape a Phase-3 caller
    // actually receives, and a member that reached the carrier without its
    // reason would be invisible to every assertion above.
    for (const [reason, carrier] of Object.entries(everyPrepareCarrier)) {
      expect(carrier.detail).toEqual({ reason });
    }
  });
});

// ----------------------------------------------------------------------------
// dispose
// ----------------------------------------------------------------------------

describe("EphemeralCloneService.dispose (explicit disposal)", () => {
  beforeEach(() => {
    insertWorkspace();
  });

  it("records the retirement and leaves the root on disk with `cleaned_at` NULL (I-010-9)", async () => {
    const service = makeService();
    const cloneId = await prepareReadyClone(service);
    const cloneRoot = readCloneRow(cloneId).clone_root;

    const response = await service.dispose(cloneId);

    expect(response).toEqual({ cloneId, state: "retired" });
    const row = readCloneRow(cloneId);
    expect(row.state).toBe("retired");
    expect(row.cleaned_at).toBeNull();
    expect(existsSync(cloneRoot)).toBe(true);
  });

  it("is idempotent on an already-retired clone", async () => {
    const service = makeService();
    const cloneId = await prepareReadyClone(service);
    await service.dispose(cloneId);
    const retiredAt = readCloneRow(cloneId);
    advanceClock(ONE_HOUR_MS);

    const response = await service.dispose(cloneId);

    expect(response).toEqual({ cloneId, state: "retired" });
    // No second write. The clock was advanced first, so an `updated_at` that
    // moved would mean the compare-and-swap ran again on a row that had already
    // reached its terminal state.
    expect(readCloneRow(cloneId)).toEqual(retiredAt);
  });

  it("retires a `failed` clone so the sweep can reach its root", async () => {
    const service = makeService();
    ctx.git.cloneFails = true;
    await captureRejection(service.prepare({ workspaceId: WORKSPACE_ID, branchName: BRANCH_NAME }));
    const failedCloneId = readSoleCloneId();

    const response = await service.dispose(failedCloneId);

    expect(response.state).toBe("retired");
    expect(readCloneRow(failedCloneId).state).toBe("retired");
  });

  it("raises `clone.not_found` for an unknown clone id", async () => {
    const service = makeService();

    const failure = await captureRejection(service.dispose(UNKNOWN_CLONE_ID));

    expect(failure).toBeInstanceOf(CloneNotFoundError);
    expect((failure as CloneNotFoundError).code).toBe("clone.not_found");
  });

  it("returns the holding workspace to `provisioning` when it disposes its current root (CP-009-8)", async () => {
    const service = makeService();
    const cloneId = await prepareReadyClone(service);
    await adoptCloneAsExecutionRoot(cloneId);
    expect(readWorkspaceRow().state).toBe("ready");

    await service.dispose(cloneId);

    const workspace = readWorkspaceRow();
    expect(workspace.state).toBe("provisioning");
    expect(workspace.fs_root).toBeNull();
    expect(workspace.execution_mode).toBe("ephemeral clone");
  });
});

// ----------------------------------------------------------------------------
// retireForWorkspace
// ----------------------------------------------------------------------------

describe("EphemeralCloneService.retireForWorkspace (the run-terminal path)", () => {
  beforeEach(() => {
    insertWorkspace();
  });

  it("retires the `on_run_complete` clones and leaves `manual` ones live", async () => {
    const service = makeService();
    const disposableCloneId = await prepareReadyClone(service);
    const manualClone = await service.prepare({
      workspaceId: WORKSPACE_ID,
      branchName: `${BRANCH_NAME}-manual`,
      cleanupPolicy: "manual",
    });

    const retired = await service.retireForWorkspace(WORKSPACE_ID, "on_run_complete");

    expect(retired).toEqual([disposableCloneId]);
    expect(readCloneRow(disposableCloneId).state).toBe("retired");
    expect(readCloneRow(manualClone.cloneId).state).toBe("ready");
  });

  it("leaves another workspace's clones alone", async () => {
    insertWorkspace(OTHER_WORKSPACE_ID);
    const service = makeService();
    const ownCloneId = await prepareReadyClone(service);
    const otherCloneId = await prepareReadyClone(service, OTHER_WORKSPACE_ID);

    await service.retireForWorkspace(WORKSPACE_ID, "on_run_complete");

    expect(readCloneRow(ownCloneId).state).toBe("retired");
    expect(readCloneRow(otherCloneId).state).toBe("ready");
  });

  it("is a no-op for a workspace that never prepared a clone", async () => {
    const service = makeService();

    const retired = await service.retireForWorkspace(UNKNOWN_WORKSPACE_ID, "on_run_complete");

    expect(retired).toEqual([]);
  });

  it("defers a clone the next run is already executing in (I-010-11)", async () => {
    const service = makeService();
    const cloneId = await prepareReadyClone(service);
    await adoptCloneAsExecutionRoot(cloneId);
    await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);

    const retired = await service.retireForWorkspace(WORKSPACE_ID, "on_run_complete");

    expect(retired).toEqual([]);
    expect(readCloneRow(cloneId).state).toBe("ready");
  });
});

// ----------------------------------------------------------------------------
// cleanupTick
// ----------------------------------------------------------------------------

describe("EphemeralCloneService.cleanupTick (D-010-13 legs (a), (b), (d))", () => {
  beforeEach(() => {
    insertWorkspace();
  });

  it("retires a clone past its TTL and leaves an unexpired one alone (leg (a))", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const expiringCloneId = await prepareReadyClone(service);
    advanceClock(2 * ONE_HOUR_MS);
    // Prepared AFTER the jump, so its own deadline is still in the future — the
    // negative control without which "the expired one was retired" would also
    // pass for a tick that retired everything.
    const survivingClone = await service.prepare({
      workspaceId: WORKSPACE_ID,
      branchName: `${BRANCH_NAME}-2`,
    });

    const result = await service.cleanupTick();

    expect(result.retiredCloneIds).toEqual([expiringCloneId]);
    expect(readCloneRow(expiringCloneId).state).toBe("retired");
    expect(readCloneRow(survivingClone.cloneId).state).toBe("ready");
  });

  it("retires a clone whose owning workspace archived (leg (b))", async () => {
    const service = makeService();
    const cloneId = await prepareReadyClone(service);
    ctx.db.prepare(`UPDATE workspaces SET state = 'archived' WHERE id = ?`).run(WORKSPACE_ID);

    const result = await service.cleanupTick();

    expect(result.retiredCloneIds).toEqual([cloneId]);
    // No disposition: an archived workspace has no live root to hand back, and
    // `beginReprovision` would refuse the predecessor anyway.
    expect(result.returnedToProvisioningWorkspaceIds).toEqual([]);
    expect(readWorkspaceRow().state).toBe("archived");
  });

  it("returns a live clone-mode workspace to `provisioning`, never to `stale`", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const cloneId = await prepareReadyClone(service);
    await adoptCloneAsExecutionRoot(cloneId);
    advanceClock(2 * ONE_HOUR_MS);

    const result = await service.cleanupTick();

    expect(result.returnedToProvisioningWorkspaceIds).toEqual([WORKSPACE_ID]);
    const workspace = readWorkspaceRow();
    // `Spec-010 §Fallback Behavior`, in its own words: the workspace awaits the
    // next per-run prepare, and `stale` is reserved for fault paths.
    expect(workspace.state).toBe("provisioning");
    expect(workspace.fs_root).toBeNull();
    expect(workspace.execution_mode).toBe("ephemeral clone");
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.provisioning"]);
  });

  // The three negative controls below move ONE variable each — one per clause of
  // `requiresReturnToProvisioning` (state, mode, root). The positive case above
  // cannot pin any of them, and neither could a single control moving several at
  // once: any clause it did not isolate could be deleted from the production
  // predicate and every assertion would still pass.

  it("leaves a workspace whose current root is no longer this clone untouched", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const cloneId = await prepareReadyClone(service);
    await adoptCloneAsExecutionRoot(cloneId);
    // Still `ephemeral clone` mode — only the ROOT moved on. This clone is now a
    // predecessor rather than the current one, so retiring it says nothing about
    // the workspace.
    ctx.db
      .prepare(`UPDATE workspaces SET fs_root = ? WHERE id = ?`)
      .run(join(ctx.tmpDir, "some-newer-clone"), WORKSPACE_ID);
    advanceClock(2 * ONE_HOUR_MS);

    const result = await service.cleanupTick();

    expect(result.retiredCloneIds).toEqual([cloneId]);
    expect(result.returnedToProvisioningWorkspaceIds).toEqual([]);
    const workspace = readWorkspaceRow();
    expect(workspace.state).toBe("ready");
    expect(workspace.execution_mode).toBe("ephemeral clone");
  });

  it("leaves a workspace that switched execution mode untouched", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const cloneId = await prepareReadyClone(service);
    const cloneRoot = await adoptCloneAsExecutionRoot(cloneId);
    // The ROOT still matches — only the mode moved on. The disposition is scoped
    // to clone-mode workspaces because `beginReprovision`'s target mode is what
    // this service would be asserting, and it has no standing to reprovision a
    // workspace another mode's provisioner now owns. A mode that moved while the
    // root stayed is fixture-manufactured — no seam writes it, and a real switch
    // would swap the root too — so that the mode clause is the ONLY thing the
    // assertion below can be reading.
    ctx.db
      .prepare(`UPDATE workspaces SET execution_mode = 'worktree' WHERE id = ?`)
      .run(WORKSPACE_ID);
    expect(readWorkspaceRow().fs_root).toBe(cloneRoot);
    advanceClock(2 * ONE_HOUR_MS);

    const result = await service.cleanupTick();

    expect(result.retiredCloneIds).toEqual([cloneId]);
    expect(result.returnedToProvisioningWorkspaceIds).toEqual([]);
    expect(readWorkspaceRow().state).toBe("ready");
  });

  it("leaves a `stale` workspace in its repair state untouched", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const cloneId = await prepareReadyClone(service);
    const cloneRoot = await adoptCloneAsExecutionRoot(cloneId);
    const staleRepairDetail = "probe: execution root unreachable";
    // Root and mode both still match — only the STATE moved, through the real
    // `markStale`, which touches neither `fs_root` nor `execution_mode`. The
    // recorded failure is planted directly because the only primitive that writes
    // one, `failReprovision`, is reachable only through `provisioning` — which
    // nulls `fs_root` and so cannot set this row up.
    ctx.db
      .prepare(`UPDATE workspaces SET metadata = json_object('lastError', ?) WHERE id = ?`)
      .run(staleRepairDetail, WORKSPACE_ID);
    expect(await ctx.workspaces.markStale(WORKSPACE_ID)).toBe(true);
    expect(readWorkspaceRow().fs_root).toBe(cloneRoot);
    advanceClock(2 * ONE_HOUR_MS);

    const result = await service.cleanupTick();

    // Leg (d) still CLEANS: the retirement and the removal are not in question,
    // only the disposition is. The reason it declines is the predicate docblock's
    // — `beginReprovision` ACCEPTS `stale`, so a disposition here would succeed
    // silently, pull the workspace out of the state its repair path is waiting on,
    // and take the recorded failure with it via the statement's `json_remove`.
    // The state assertion catches a disposition that fired; the surviving detail
    // names what firing would have cost.
    expect(result.retiredCloneIds).toEqual([cloneId]);
    expect(result.returnedToProvisioningWorkspaceIds).toEqual([]);
    expect(result.cleanedCloneIds).toEqual([cloneId]);
    expect(existsSync(cloneRoot)).toBe(false);
    expect(readCloneRow(cloneId).cleaned_at).toBe(clock());
    expect(readWorkspaceRow().state).toBe("stale");
    const repairRow = ctx.db
      .prepare<
        [string],
        { lastError: string | null }
      >(`SELECT json_extract(metadata, '$.lastError') AS lastError FROM workspaces WHERE id = ?`)
      .get(WORKSPACE_ID);
    expect(repairRow?.lastError).toBe(staleRepairDetail);
  });

  it("defers the retirement while a busy workspace is executing in the root", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const cloneId = await prepareReadyClone(service);
    const cloneRoot = await adoptCloneAsExecutionRoot(cloneId);
    await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);
    advanceClock(2 * ONE_HOUR_MS);

    const result = await service.cleanupTick();

    expect(result.retiredCloneIds).toEqual([]);
    expect(readCloneRow(cloneId).state).toBe("ready");
    expect(existsSync(cloneRoot)).toBe(true);
    expect(readWorkspaceRow().state).toBe("busy");
  });

  it("defers the removal of a clone `dispose` retired under a busy workspace", async () => {
    const service = makeService();
    const cloneId = await prepareReadyClone(service);
    const cloneRoot = await adoptCloneAsExecutionRoot(cloneId);
    await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);
    // `dispose` retires regardless — there is no ratified conflict code for the
    // clone surface — so leg (d) is what protects the running run's directory.
    await service.dispose(cloneId);

    const result = await service.cleanupTick();

    expect(result.cleanedCloneIds).toEqual([]);
    expect(existsSync(cloneRoot)).toBe(true);
    expect(readCloneRow(cloneId).cleaned_at).toBeNull();
  });

  it("pays the disposition owed by that deferral before it removes the root", async () => {
    const service = makeService();
    const cloneId = await prepareReadyClone(service);
    const cloneRoot = await adoptCloneAsExecutionRoot(cloneId);
    await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);
    // Disposal DURING the run: the row retires, but a `busy` workspace is not a
    // legal `beginReprovision` predecessor, so the disposition is deferred — not
    // skipped forever.
    await service.dispose(cloneId);
    expect(readWorkspaceRow().state).toBe("busy");

    // The run ends. Plan-009's `releaseBusy` deliberately does not clear
    // `fs_root`, so the workspace is `ready` again while still naming the root
    // of a clone that is already retired.
    expect(ctx.workspaces.releaseBusy(WORKSPACE_ID)).toBe(true);
    expect(readWorkspaceRow().fs_root).toBe(cloneRoot);

    const result = await service.cleanupTick();

    // Leg (d) settles the debt before deleting anything. Without it the tick
    // removes the directory under a `ready` workspace, and that workspace can
    // only rediscover the truth through the health probe deriving `stale` — the
    // FAULT state, where `Spec-010 §Fallback Behavior` prescribes `provisioning`
    // for a clone that simply ended (CP-009-8).
    expect(result.returnedToProvisioningWorkspaceIds).toEqual([WORKSPACE_ID]);
    expect(result.cleanedCloneIds).toEqual([cloneId]);
    // Nothing was retired by this tick: the row was already `retired`, so this
    // is leg (d) acting alone.
    expect(result.retiredCloneIds).toEqual([]);
    const workspace = readWorkspaceRow();
    expect(workspace.state).toBe("provisioning");
    expect(workspace.fs_root).toBeNull();
    expect(existsSync(cloneRoot)).toBe(false);
    expect(readCloneRow(cloneId).cleaned_at).toBe(clock());
    // `markBusy` and `releaseBusy` are not evented; the disposition is, and it is
    // Plan-009's event rather than a clone transition (D-010-11).
    expect(readEventTypes()).toEqual(["workspace.ready", "workspace.provisioning"]);
  });

  it("skips a leg (d) row whose disposition loses to a run claiming the root", async () => {
    const service = makeService();
    const cloneId = await prepareReadyClone(service);
    const cloneRoot = await adoptCloneAsExecutionRoot(cloneId);
    await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);
    await service.dispose(cloneId);
    expect(ctx.workspaces.releaseBusy(WORKSPACE_ID)).toBe(true);

    // The race the adjudication is about, made deterministic: a new run claims
    // the workspace between leg (d)'s candidate snapshot and the disposition.
    // Claiming it INSIDE the primitive is what makes the refusal the real
    // Plan-009 carrier rather than a stubbed throw.
    const racingService = makeService({
      beginWorkspaceReprovision: async (workspaceId, targetMode) => {
        await ctx.workspaces.markBusy(workspaceId, RUN_ID);
        await ctx.workspaces.beginReprovision(workspaceId, targetMode);
      },
    });

    const result = await racingService.cleanupTick();

    // The tick SURVIVES the refusal and leaves the row exactly as it found it,
    // for the next tick's busy guard to defer again. The run that won the race
    // still has its execution root — which is the whole point of ordering the
    // disposition before the removal.
    expect(result.cleanedCloneIds).toEqual([]);
    expect(result.returnedToProvisioningWorkspaceIds).toEqual([]);
    expect(existsSync(cloneRoot)).toBe(true);
    expect(readCloneRow(cloneId).cleaned_at).toBeNull();
    expect(readWorkspaceRow().state).toBe("busy");
  });

  it("aborts the tick when the disposition refuses for a non-busy reason", async () => {
    const service = makeService();
    const cloneId = await prepareReadyClone(service);
    const cloneRoot = await adoptCloneAsExecutionRoot(cloneId);
    await ctx.workspaces.markBusy(WORKSPACE_ID, RUN_ID);
    await service.dispose(cloneId);
    expect(ctx.workspaces.releaseBusy(WORKSPACE_ID)).toBe(true);

    // The other side of the adjudication, driven by the REAL primitive for the
    // same reason the skip arm is: `beginReprovision` validates the target mode
    // against the mount's capability matrix BEFORE it reads the predecessor, and
    // a `vcs_type` of `none` offers no clone mode at all. Without the `instanceof`
    // narrowing, an unconditional skip would swallow this — a mount that cannot
    // serve the mode this service is asking for is exactly the cross-plan
    // disagreement the fail-closed arm exists to surface.
    ctx.db.prepare(`UPDATE repo_mounts SET vcs_type = 'none' WHERE id = ?`).run(REPO_MOUNT_ID);

    const failure = await captureRejection(service.cleanupTick());

    expect(failure).toBeInstanceOf(WorkspaceModeUnsupportedError);
    // Ordering the disposition before the removal is what makes a propagating
    // refusal safe: the row leaves the tick exactly as it entered it.
    expect(existsSync(cloneRoot)).toBe(true);
    expect(readCloneRow(cloneId).cleaned_at).toBeNull();
  });

  it("removes the root and stamps `cleaned_at` in the same tick that retired it (leg (d))", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const cloneId = await prepareReadyClone(service);
    const cloneRoot = readCloneRow(cloneId).clone_root;
    advanceClock(2 * ONE_HOUR_MS);

    const result = await service.cleanupTick();

    expect(result.retiredCloneIds).toEqual([cloneId]);
    expect(result.cleanedCloneIds).toEqual([cloneId]);
    expect(existsSync(cloneRoot)).toBe(false);
    expect(readCloneRow(cloneId).cleaned_at).toBe(clock());
  });

  it("does not move `cleaned_at` on a later tick", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const cloneId = await prepareReadyClone(service);
    advanceClock(2 * ONE_HOUR_MS);
    await service.cleanupTick();
    const firstStamp = readCloneRow(cloneId).cleaned_at;
    advanceClock(ONE_HOUR_MS);

    const result = await service.cleanupTick();

    expect(result).toEqual({
      retiredCloneIds: [],
      cleanedCloneIds: [],
      returnedToProvisioningWorkspaceIds: [],
    });
    expect(readCloneRow(cloneId).cleaned_at).toBe(firstStamp);
  });

  it("issues no git invocation at all", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    await prepareReadyClone(service);
    advanceClock(2 * ONE_HOUR_MS);
    const invocationsAfterPrepare = ctx.git.invocations.length;

    await service.cleanupTick();

    // A clone is a standalone repository: removing its directory leaves no
    // administrative entry in the source, so there is no `prune` counterpart to
    // `./worktree-service.ts`'s cleanup pass.
    expect(ctx.git.invocations).toHaveLength(invocationsAfterPrepare);
  });
});

// ----------------------------------------------------------------------------
// Cross-cutting invariants
// ----------------------------------------------------------------------------

describe("EphemeralCloneService — invariants across a full lifecycle", () => {
  beforeEach(() => {
    insertWorkspace();
  });

  it("hook-neutralizes EVERY recorded invocation against an empty directory (I-010-10)", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const firstCloneId = await prepareReadyClone(service);
    await service.dispose(firstCloneId);
    await service.prepare({ workspaceId: WORKSPACE_ID, branchName: `${BRANCH_NAME}-2` });
    advanceClock(2 * ONE_HOUR_MS);
    await service.cleanupTick();

    expect(ctx.git.invocations.length).toBeGreaterThan(0);
    for (const invocation of ctx.git.invocations) {
      expect(invocation.argv.slice(0, 2)).toEqual([
        "-c",
        `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
      ]);
      // Bounded, in the same universal loop and for the same reason: `execFile`
      // reads `timeout: 0` as NO timeout, so a zero here would fail OPEN and
      // park a run in setup on a clone that never returns.
      expect(invocation.timeoutMs).toBeGreaterThan(0);
    }
    // An EMPTY directory is the mechanism — a populated one would silently be a
    // hooks directory of its own.
    expect(existsSync(ctx.hookNeutralizationDirectory)).toBe(true);
    expect(readdirSync(ctx.hookNeutralizationDirectory)).toEqual([]);
  });

  it("appends no clone event for any transition (D-010-11)", async () => {
    const service = makeService({ ttlMs: ONE_HOUR_MS });
    const cloneId = await prepareReadyClone(service);
    await service.dispose(cloneId);
    const failingService = makeService();
    ctx.git.cloneFails = true;
    await captureRejection(
      failingService.prepare({ workspaceId: WORKSPACE_ID, branchName: `${BRANCH_NAME}-3` }),
    );
    advanceClock(2 * ONE_HOUR_MS);
    await service.cleanupTick();

    // Not one event of any kind: no clone transition is evented, and none of
    // these paths reached the disposition, which is the only thing in this
    // service that causes an event at all — and it is Plan-009's.
    expect(readEventTypes()).toEqual([]);
  });
});
