// WorktreeService + the Plan-010 typed error vocabulary — Phase 2 T2.2.
//
// Drives the real service over a real test SQLite database (same lifecycle as
// the T2.1 emitter suite: `openDatabase` factory → per-test tmp file →
// `afterEach` close + remove) with Plan-006's `EventLogService` as the durable
// append path and a RECORDING fake git runner in place of the child process.
// The fake is what makes the invocation-shape invariants assertable: argv is
// the whole invocation (the seam takes no `cwd`), so a recorded argv is the
// complete claim about what git was asked to do.
//
// Coverage map (the cites are the contract, not just the ACs):
//   * `Spec-010 §Default Behavior` — the branch-name PATTERN
//     `sidekicks/<session-short-id>/<task-slug>`, which is all that section
//     carries about naming.
//   * `Spec-010 §Resolved Questions and V1 Scope Decisions` — three rules. The
//     slug MECHANICS, table-driven over lowercasing, non-alphanumeric collapse,
//     trimming, the 40-character truncation at a `-` boundary, and the
//     `run-<run-short-id>` fallback (they are locked here, not in the section
//     that states the pattern). The provenance-split collision policy, carried
//     by the explicit `onCollision` parameter (`refuse` raises the typed
//     collision error; `suffix` takes `-2` then `-3` and reports the chosen name
//     verbatim) — both arms exercised on the SAME branch name, which is what
//     pins the behavior to the parameter rather than to how the name happened to
//     be obtained. And the base-ref policy (a detached-HEAD mount with no
//     explicit base ref refuses rather than guessing).
//   * `Spec-010 §Fallback Behavior` — a dirty candidate without acknowledgement
//     refuses and with one binds; an INCOMPATIBLE candidate refuses even with an
//     acknowledgement; a failed provisioning records the failure rather than
//     substituting anything.
//   * `Spec-010 §Required Behavior` — reuse of an existing checkout is explicit
//     and preserves the candidate's branch and provenance context.
//   * `Spec-010 §State And Data Implications` — the row's provenance columns are
//     populated at creation and survive retirement.
//   * `error-contracts.md §Worktree` / `§Ephemeral Clone` / `§Workspace` — the
//     carrier census: every class reports its ratified code and notional status,
//     the three registries are covered exactly, and `workspace.busy` (Plan-009's,
//     already shipped as `WorkspaceBusyError`) is absent.
//
// Verifies invariant: I-010-3 (provenance columns are populated at creation and
// preserved across retirement), I-010-4 (the partial-unique index arbitrates the
// collision — a losing attempt leaves NEITHER a row nor an event, and a
// constraint failure it does not explain is never laundered into a collision),
// I-010-6 (no recorded invocation names a working-tree-mutating verb), I-010-8
// (reuse refuses rather than substituting), I-010-9 (retire leaves `cleaned_at`
// NULL and the root on disk; only a cleanup pass removes, prunes and stamps —
// and the busy refusal that guards it is decided inside the retirement
// transaction, so a hold taken mid-flight still refuses), I-010-10 (EVERY
// recorded invocation carries `-c core.hooksPath=<empty dir>`, asserted over all
// four invocation shapes rather than only the two `create` issues), I-010-13
// (one event per real transition; `-> failed` emits none; a failed
// `worktree.ready` emission leaves no `ready` row behind).
//
// The interleaving-sensitive cases drive their races through a SUBCLASSED
// `WorktreeEventEmitter` whose overridden emit method performs the interfering
// write and then delegates to `super`. That is the deterministic form of "a
// concurrent writer landed between the read and the transaction": the write
// commits on the same synchronous connection immediately before the append
// transaction opens, which is precisely the window an out-of-transaction probe
// leaves open and an in-prelude one closes.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonRpcErrorCode, WORKTREE_GIT_REF_MAX_LEN } from "@ai-sidekicks/contracts";
import type { SessionId, WorkspaceState } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import type { EventLogAppendReceipt } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
// A VALUE import, not a type-only one: the exported-carrier census below tests
// `prototype instanceof DaemonDomainError` at runtime.
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { openDatabase } from "../../session/migration-runner.js";
import { RepoMountNotFoundError } from "../../workspace/repo-errors.js";
import { WorktreeEventEmitter } from "../worktree-event-emitter.js";
import type {
  EmitWorktreeEventInput,
  WorktreeEventEmitterDeps,
} from "../worktree-event-emitter.js";
import {
  CloneNotFoundError,
  ClonePrepareFailedError,
  EPHEMERAL_CLONE_ERROR_CODES,
  PLAN_010_WORKSPACE_ERROR_CODES,
  WORKTREE_ERROR_CODES,
  WorkspaceBranchMismatchError,
  WorkspaceBranchNameRequiredError,
  WorkspaceExecutionRootUnresolvedError,
  WorktreeBranchCollisionError,
  WorktreeCreateFailedError,
  WorktreeNotFoundError,
  WorktreeRetireConflictError,
  WorktreeReuseConflictError,
} from "../worktree-errors.js";
import type { WorktreeCreateFailureReason } from "../worktree-errors.js";
// The whole module surface, for the exported-carrier census. Named imports
// cannot serve it: a class the suite forgot to import is exactly the class the
// census exists to catch.
import * as worktreeErrorsModule from "../worktree-errors.js";
import { WorktreeService, deriveWorktreeBranchName } from "../worktree-service.js";
import type {
  CreateWorktreeInput,
  CreatedWorktree,
  WorktreeFilesystem,
  WorktreeGitInvocationResult,
  WorktreeGitRunner,
  WorktreeServiceDeps,
} from "../worktree-service.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Session, mount, workspace and worktree ids all flow through branded UUID
// schemas — at the emission boundary for the first two and at `retire`'s
// response projection for the last — so every fixture is a real UUID.
const SESSION_ID: string = "0190f8b0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const REPO_MOUNT_ID: string = "0190f8b2-2d4e-7f7b-9a32-3d8e7c5f0b21";
const OTHER_REPO_MOUNT_ID: string = "0190f8b5-5a7b-7c9d-8e54-6f0a9e82d354";
const WORKSPACE_ID: string = "0190f8b3-3e5f-7a8c-8b43-4e9f8d60c132";
const RUN_ID: string = "0190f8b4-4f60-7b9d-9c54-5f0a9e71c243";
const BRANCH_CONTEXT_ID: string = "0190f8b6-6b8c-7d0e-8f65-7a1b0f93e465";
const UNKNOWN_WORKTREE_ID: string = "0190f8b7-7c9d-7e1f-9a76-8b2c1a04f576";
// A real UUID, because an injected id still travels the emitter's
// `WorktreeIdSchema.parse` on every emission — a counter would fail there
// rather than at the constraint the case is about.
const FIXED_WORKTREE_ID: string = "0190f8b8-8d0e-7f20-8b87-9c3d2b15a687";

// Two distinct canonical roots: `idx_repo_mounts_active_root` is UNIQUE over
// (session_id, node_id, canonical_root) for attached rows, so a second mount in
// the same session needs a root of its own.
const CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-mount";
const OTHER_CANONICAL_ROOT: string = "/tmp/ai-sidekicks-fixture-other-mount";
const HEAD_BRANCH: string = "main";
const NOW: string = "2026-08-04T00:00:00.000Z";

// The name the run-setup gate would derive for these fixtures, COMPOSED the way
// T2.4 composes it: derive first, then hand `create` an explicit name (D-010-19).
// Calling the helper rather than restating its output as a literal is what makes
// the collision cases exercise the real two-layer path — the service itself
// holds no summary and derives nothing.
const DERIVED_BRANCH_NAME: string = deriveWorktreeBranchName({
  sessionId: SESSION_ID,
  runId: RUN_ID,
  taskSummary: "Fix login",
});

// The git verbs that would mutate the mount's main checkout. I-010-6 is the
// claim that NONE of them is ever issued, so the roster is spelled out here
// rather than inferred from the service's own source.
const MAIN_CHECKOUT_MUTATING_VERBS: readonly string[] = [
  "checkout",
  "switch",
  "branch",
  "merge",
  "rebase",
  "reset",
  "stash",
  "commit",
  "pull",
];

/** A fixed-key signing source — enough for a suite that only ever signs. */
const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(9) as Ed25519PrivateKey;

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

function resolveGit(stdout: string): Promise<WorktreeGitInvocationResult> {
  return Promise.resolve({ stdout, stderr: "" });
}

/**
 * Records every invocation and answers the three verbs the service issues,
 * across the four invocation shapes they take.
 *
 * `worktree add` MATERIALIZES the target directory, because two arms depend on a
 * root that really exists: the cleanup pass has to be observed removing one, and
 * a retire has to be observed NOT removing one.
 *
 * An unrecognized verb — or an unrecognized `worktree` subcommand — REJECTS
 * rather than resolving empty. A fixture that shrugged at an unknown invocation
 * would let a new git call into the service without a single case noticing, and
 * the two universal-quantifier claims below are exactly the ones such a call
 * would escape.
 */
class FakeGit {
  readonly invocations: RecordedGitInvocation[] = [];
  headBranch: string | null = HEAD_BRANCH;
  statusOutput: string = "";
  statusFails: boolean = false;
  worktreeAddFails: boolean = false;
  worktreePruneFails: boolean = false;

  readonly run: WorktreeGitRunner = (argv, options) => {
    this.invocations.push({ argv: [...argv], timeoutMs: options.timeoutMs });
    // argv is `-c core.hooksPath=… -C <dir> <verb> …`, so the verb is index 4
    // and a `worktree` subcommand is index 5.
    const verb: string | undefined = argv[4];

    if (verb === "symbolic-ref") {
      if (this.headBranch === null) {
        return Promise.reject(new Error("fatal: ref HEAD is not a symbolic ref"));
      }
      return resolveGit(`${this.headBranch}\n`);
    }

    if (verb === "worktree") {
      const subcommand: string | undefined = argv[5];
      if (subcommand === "prune") {
        if (this.worktreePruneFails) {
          return Promise.reject(new Error("fatal: not a git repository"));
        }
        return resolveGit("");
      }
      if (subcommand === "add") {
        if (this.worktreeAddFails) {
          return Promise.reject(new Error("fatal: could not create worktree"));
        }
        const targetRoot: string | undefined = argv[8];
        if (targetRoot !== undefined) {
          mkdirSync(targetRoot, { recursive: true });
          writeFileSync(join(targetRoot, "README.md"), "fixture\n");
        }
        return resolveGit("");
      }
      return Promise.reject(
        new Error(`unexpected git worktree subcommand in fixture: ${String(subcommand)}`),
      );
    }

    if (verb === "status") {
      if (this.statusFails) {
        return Promise.reject(new Error("fatal: not a git repository"));
      }
      return resolveGit(this.statusOutput);
    }

    return Promise.reject(new Error(`unexpected git verb in fixture: ${String(verb)}`));
  };

  verbs(): readonly (string | undefined)[] {
    return this.invocations.map((invocation) => invocation.argv[4]);
  }

  argvFor(verb: string): readonly string[] {
    const found = this.invocations.find((invocation) => invocation.argv[4] === verb);
    if (found === undefined) {
      throw new Error(`no recorded git invocation for verb "${verb}"`);
    }
    return found.argv;
  }

  /** Every recorded `git worktree <subcommand>` argv, in invocation order. */
  worktreeSubcommandArgvs(subcommand: string): readonly (readonly string[])[] {
    return this.invocations
      .filter(
        (invocation) => invocation.argv[4] === "worktree" && invocation.argv[5] === subcommand,
      )
      .map((invocation) => invocation.argv);
  }
}

// ----------------------------------------------------------------------------
// Per-test lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  eventLog: EventLogService;
  emitter: WorktreeEventEmitter;
  git: FakeGit;
  executionRootsDirectory: string;
  hookNeutralizationDirectory: string;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-worktree-service-test-"));
  const db: DatabaseType = openDatabase(join(tmpDir, "test.db"));
  const eventLog = new EventLogService({
    db,
    signingKeySource: new FixedDaemonSigningKeySource(),
  });
  const executionRootsDirectory: string = join(tmpDir, "execution-roots");
  ctx = {
    db,
    eventLog,
    emitter: new WorktreeEventEmitter({ sessionEvents: eventLog }),
    git: new FakeGit(),
    executionRootsDirectory,
    hookNeutralizationDirectory: join(executionRootsDirectory, ".hook-neutralization"),
    tmpDir,
  };
  insertMount({ repoMountId: REPO_MOUNT_ID });
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

function makeService(overrides: Partial<WorktreeServiceDeps> = {}): WorktreeService {
  return new WorktreeService({
    database: ctx.db,
    events: ctx.emitter,
    executionRootsDirectory: ctx.executionRootsDirectory,
    git: ctx.git.run,
    ...overrides,
  });
}

// ----------------------------------------------------------------------------
// Row fixtures and reads
// ----------------------------------------------------------------------------

// Options objects rather than positionals, matching the T2.4 and T2.6 suites:
// the sibling T2.3 suite's same-named workspace seeder keys its one slot on the
// workspace ID where this one keys the STATE, and the acceptance suite's mount
// seeder puts a PATH in the slot this one gives a state — same-arity `(string)`
// signatures with opposite meanings let a miscopied call type-check while
// seeding garbage.
function insertMount(options: {
  readonly repoMountId: string;
  readonly state?: string;
  readonly canonicalRoot?: string;
}): void {
  const canonicalRoot = options.canonicalRoot ?? CANONICAL_ROOT;
  const statement = ctx.db.prepare(
    `INSERT INTO repo_mounts (
       id, session_id, node_id, local_path, canonical_root, state, attached_at, updated_at
     ) VALUES (?, ?, 'node-1', ?, ?, ?, ?, ?)`,
  );
  statement.run(
    options.repoMountId,
    SESSION_ID,
    canonicalRoot,
    canonicalRoot,
    options.state ?? "attached",
    NOW,
    NOW,
  );
}

function insertWorkspace(options: {
  readonly state: WorkspaceState;
  readonly fsRoot?: string;
}): void {
  const statement = ctx.db.prepare(
    `INSERT INTO workspaces (
       id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at
     ) VALUES (?, ?, ?, 'worktree', ?, ?, ?, ?)`,
  );
  statement.run(
    WORKSPACE_ID,
    SESSION_ID,
    REPO_MOUNT_ID,
    options.fsRoot ?? CANONICAL_ROOT,
    options.state,
    NOW,
    NOW,
  );
}

function insertBranchContext(worktreeId: string): void {
  const statement = ctx.db.prepare(
    `INSERT INTO branch_contexts (
       id, workspace_id, worktree_id, base_branch, head_branch, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  statement.run(BRANCH_CONTEXT_ID, WORKSPACE_ID, worktreeId, HEAD_BRANCH, "feature", NOW, NOW);
}

interface WorktreeTestRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  readonly state: string;
  readonly cleaned_at: string | null;
}

function readWorktreeRow(worktreeId: string): WorktreeTestRow {
  const statement = ctx.db.prepare<[string], WorktreeTestRow>(
    `SELECT id, repo_mount_id, created_by_session_id, created_by_run_id, branch_name,
            fs_root, state, cleaned_at
       FROM worktrees
      WHERE id = ?`,
  );
  const row = statement.get(worktreeId);
  if (row === undefined) {
    throw new Error(`expected a worktrees row for ${worktreeId}`);
  }
  return row;
}

function readAllWorktreeIds(): readonly string[] {
  const rows = ctx.db.prepare<[], { id: string }>(`SELECT id FROM worktrees`).all();
  return rows.map((row) => row.id);
}

/**
 * The id of the single row a case expects to exist, unwrapped once.
 *
 * `noUncheckedIndexedAccess` makes `ids[0]` a `string | undefined`, so the
 * unwrap has to happen somewhere; doing it here keeps the cases that only need
 * "the row that was just written" free of the ceremony.
 */
function readSoleWorktreeId(): string {
  const ids = readAllWorktreeIds();
  const soleId = ids[0];
  if (ids.length !== 1 || soleId === undefined) {
    throw new Error(`expected exactly one worktrees row, found ${ids.length}`);
  }
  return soleId;
}

function readEventTypes(): readonly string[] {
  const statement = ctx.db.prepare<[string], { type: string }>(
    `SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence ASC`,
  );
  return statement.all(SESSION_ID).map((row) => row.type);
}

async function captureRejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (rejection) {
    return rejection;
  }
  throw new Error("expected the call to reject, but it resolved");
}

/**
 * The happy path, reused by the reuse / retire / cleanup blocks. `refuse` is
 * the wire-prepare arm (D-010-7), so it is the default posture here.
 */
async function createReadyWorktree(service: WorktreeService): Promise<CreatedWorktree> {
  return service.create({
    repoMountId: REPO_MOUNT_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    branchName: "feature/login",
    onCollision: "refuse",
  });
}

// ----------------------------------------------------------------------------
// Emitter subclasses — injected races and injected append failures
// ----------------------------------------------------------------------------
//
// Two roles, and which one a case uses decides what its assertions can mean.
//
// The RACE-INJECTING pair performs its interfering write and THEN delegates to
// `super`: the write commits on the shared synchronous connection in the exact
// window a pre-transaction decision cannot see into, and the append that follows
// is the real one, prelude included. That is the deterministic form of "a
// concurrent writer landed between the read and the transaction".
//
// The FAILURE-INJECTING pair interferes with nothing and never calls `super`. It
// rejects outright, so no append transaction opens and the prelude never runs at
// all — which is what the row and event censuses in those cases rest on: an
// absent row means the write never happened, not that it was rolled back.
//
// The service under test is the real one throughout; only the emission seam is
// wrapped.

/** Takes the busy hold while the retirement is in flight (A1's race). */
class BusyHolderInjectingEmitter extends WorktreeEventEmitter {
  override async emitWorktreeRetired(
    input: EmitWorktreeEventInput,
  ): Promise<EventLogAppendReceipt> {
    // The hold is what CP-009-7 means by one: a `busy` workspace whose CURRENT
    // `fs_root` is the worktree's own directory.
    const row = ctx.db
      .prepare<[string], { fs_root: string }>(`SELECT fs_root FROM worktrees WHERE id = ?`)
      .get(input.worktreeId);
    if (row === undefined) {
      throw new Error(`expected a worktrees row for ${input.worktreeId}`);
    }
    insertWorkspace({ state: "busy", fsRoot: row.fs_root });
    return super.emitWorktreeRetired(input);
  }
}

/** Lets a competing retirement commit first, with no event of its own. */
class PreRetiringEmitter extends WorktreeEventEmitter {
  override async emitWorktreeRetired(
    input: EmitWorktreeEventInput,
  ): Promise<EventLogAppendReceipt> {
    ctx.db
      .prepare(`UPDATE worktrees SET state = 'retired', updated_at = ? WHERE id = ?`)
      .run(NOW, input.worktreeId);
    return super.emitWorktreeRetired(input);
  }
}

/** The `worktree.ready` append that never lands (A2's failure). */
const READY_EMISSION_FAILURE: Error = new Error("fixture: the worktree.ready append failed");

class ReadyEmissionFailingEmitter extends WorktreeEventEmitter {
  override emitWorktreeReady(): Promise<EventLogAppendReceipt> {
    return Promise.reject(READY_EMISSION_FAILURE);
  }
}

/**
 * Rejects the `worktree.created` append with a caller-chosen value.
 *
 * The only way to drive the two arms of the UNIQUE-violation confirmation
 * separately: through the real database each arm shadows the other, because the
 * partial-unique branch index reports `SQLITE_CONSTRAINT_UNIQUE` exactly when a
 * live row on that branch exists to confirm it.
 */
class CreatedEmissionFailingEmitter extends WorktreeEventEmitter {
  readonly #failure: unknown;

  constructor(deps: WorktreeEventEmitterDeps, failure: unknown) {
    super(deps);
    this.#failure = failure;
  }

  override emitWorktreeCreated(): Promise<EventLogAppendReceipt> {
    return Promise.reject(this.#failure);
  }
}

// ----------------------------------------------------------------------------
// The two per-invocation quantifiers, hoisted
// ----------------------------------------------------------------------------
//
// Hoisted because the claims are over EVERY invocation the service can issue,
// and a loop living inside one `create` case only ever sees the two verbs
// `create` reaches. The reuse path's `status --porcelain` is the third, and the
// sweep's `worktree prune` the fourth invocation shape; each caller below names
// which ones its own run produced.

function assertEveryInvocationIsHookNeutralized(): void {
  expect(ctx.git.invocations.length).toBeGreaterThan(0);
  for (const invocation of ctx.git.invocations) {
    expect(invocation.argv.slice(0, 2)).toEqual([
      "-c",
      `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
    ]);
    expect(invocation.timeoutMs).toBeGreaterThan(0);
  }
  expect(existsSync(ctx.hookNeutralizationDirectory)).toBe(true);
}

function assertNoInvocationMutatesTheMainCheckout(): void {
  expect(ctx.git.invocations.length).toBeGreaterThan(0);
  for (const invocation of ctx.git.invocations) {
    for (const verb of MAIN_CHECKOUT_MUTATING_VERBS) {
      expect(invocation.argv).not.toContain(verb);
    }
  }
}

// ----------------------------------------------------------------------------
// deriveWorktreeBranchName — the `Spec-010 §Default Behavior` pattern, filled in
// by the `Spec-010 §Resolved Questions and V1 Scope Decisions` slug rule
// ----------------------------------------------------------------------------

// The rule's clauses, one row each. The third column is the SLUG SEGMENT alone;
// the assertion composes the full `sidekicks/<session-short-id>/<slug>` name
// around it, so every row re-asserts the prefix and the short-id derivation as
// well as the clause it is named for.
const SLUG_CASES: ReadonlyArray<readonly [string, string | null, string]> = [
  ["lowercases and hyphenates a plain summary", "Fix the login bug", "fix-the-login-bug"],
  [
    "collapses runs of non-alphanumerics and trims the edges",
    "  !!Hello,   World!!  ",
    "hello-world",
  ],
  [
    "truncates at the last boundary inside 40 characters",
    "Add support for cross machine dispatch routing tables",
    "add-support-for-cross-machine-dispatch",
  ],
  [
    "keeps a full 40 characters when the 41st is itself a boundary",
    "AAAAAAAAA BBBBBBBBB CCCCCCCCC DDDDDDDDDD EEE",
    "aaaaaaaaa-bbbbbbbbb-ccccccccc-dddddddddd",
  ],
  ["cuts a single long word hard rather than to nothing", "a".repeat(50), "a".repeat(40)],
  ["falls back to the run short id when the summary is punctuation", "---", "run-0190f8b4"],
  ["falls back to the run short id when the summary is empty", "", "run-0190f8b4"],
  ["falls back to the run short id when there is no summary", null, "run-0190f8b4"],
];

describe("deriveWorktreeBranchName", () => {
  for (const [label, taskSummary, expectedSlug] of SLUG_CASES) {
    it(label, () => {
      const derived = deriveWorktreeBranchName({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        taskSummary,
      });
      expect(derived).toBe(`sidekicks/0190f8b0/${expectedSlug}`);
    });
  }

  it("refuses when neither a summary nor a run id can produce a slug", () => {
    let thrown: unknown;
    try {
      deriveWorktreeBranchName({ sessionId: SESSION_ID, runId: null, taskSummary: "!!!" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    const failure = thrown as WorktreeCreateFailedError;
    expect(failure.reason).toBe("branch_name_underivable");
  });
});

// ----------------------------------------------------------------------------
// create
// ----------------------------------------------------------------------------

describe("WorktreeService.create", () => {
  it("records provenance, materializes the root, and emits created then ready", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    expect(created.branchName).toBe("feature/login");
    expect(created.baseRef).toBe(HEAD_BRANCH);
    expect(created.state).toBe("ready");
    expect(created.fsRoot).toBe(
      join(ctx.executionRootsDirectory, REPO_MOUNT_ID, "worktrees", created.worktreeId),
    );

    const row = readWorktreeRow(created.worktreeId);
    expect(row.state).toBe("ready");
    expect(row.repo_mount_id).toBe(REPO_MOUNT_ID);
    // I-010-3: both provenance columns, populated at creation.
    expect(row.created_by_session_id).toBe(SESSION_ID);
    expect(row.created_by_run_id).toBe(RUN_ID);
    expect(row.cleaned_at).toBeNull();

    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("records a NULL creating run for a pre-run explicit prepare", async () => {
    const service = makeService();
    const created = await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      branchName: "feature/pre-run",
      onCollision: "refuse",
    });

    expect(readWorktreeRow(created.worktreeId).created_by_run_id).toBeNull();
  });

  it("hook-neutralizes EVERY recorded invocation", async () => {
    const service = makeService();
    await createReadyWorktree(service);

    // The quantifier is over ALL invocations, not the provisioning one: a
    // per-call-site assertion would let a later-added invocation escape. This
    // run produces two of the four shapes; the reuse and sweep cases below
    // carry the other two.
    expect(ctx.git.verbs()).toEqual(["symbolic-ref", "worktree"]);
    assertEveryInvocationIsHookNeutralized();
  });

  it("never issues a verb that would mutate the main checkout", async () => {
    const service = makeService();
    await createReadyWorktree(service);

    assertNoInvocationMutatesTheMainCheckout();
  });

  it("provisions with the exact `git worktree add` argv", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    expect(ctx.git.argvFor("worktree")).toEqual([
      "-c",
      `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
      "-C",
      CANONICAL_ROOT,
      "worktree",
      "add",
      "-b",
      "feature/login",
      created.fsRoot,
      HEAD_BRANCH,
    ]);
  });

  it("refuses a collision on the `refuse` arm, leaving neither a row nor an event", async () => {
    const service = makeService();
    await createReadyWorktree(service);
    const eventsBeforeCollision = readEventTypes().length;

    const thrown = await captureRejection(() => createReadyWorktree(service));

    expect(thrown).toBeInstanceOf(WorktreeBranchCollisionError);
    const collision = thrown as WorktreeBranchCollisionError;
    expect(collision.code).toBe("worktree.branch_collision");
    expect(collision.branchName).toBe("feature/login");
    expect(collision.repoMountId).toBe(REPO_MOUNT_ID);
    // The losing attempt left NEITHER a row nor an event (I-010-4 / I-010-13).
    expect(readAllWorktreeIds()).toHaveLength(1);
    expect(readEventTypes()).toHaveLength(eventsBeforeCollision);
  });

  it("ordinal-suffixes on the `suffix` arm and reports the chosen name verbatim", async () => {
    const service = makeService();
    const suffixingInput: CreateWorktreeInput = {
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: DERIVED_BRANCH_NAME,
      onCollision: "suffix",
    };

    const first = await service.create(suffixingInput);
    const second = await service.create(suffixingInput);
    const third = await service.create(suffixingInput);

    expect(first.branchName).toBe("sidekicks/0190f8b0/fix-login");
    expect(second.branchName).toBe("sidekicks/0190f8b0/fix-login-2");
    expect(third.branchName).toBe("sidekicks/0190f8b0/fix-login-3");
    expect(readWorktreeRow(second.worktreeId).branch_name).toBe("sidekicks/0190f8b0/fix-login-2");
  });

  it("selects the arm from `onCollision`, never from how the name was obtained", async () => {
    // The regression guard for a presence-based discriminant: ONE name, both
    // arms, opposite outcomes. Under D-010-19 every production request carries
    // an explicit name, so any policy inferred from the name's shape or its
    // presence would collapse to a single arm and make the other dead code.
    const service = makeService();
    // Annotated `Omit<…, "onCollision">` so the type states the case's own
    // claim: every input except the policy is identical across the three calls.
    const base: Omit<CreateWorktreeInput, "onCollision"> = {
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: DERIVED_BRANCH_NAME,
    };
    await service.create({ ...base, onCollision: "refuse" });

    const thrown = await captureRejection(() => service.create({ ...base, onCollision: "refuse" }));
    const suffixed = await service.create({ ...base, onCollision: "suffix" });

    expect(thrown).toBeInstanceOf(WorktreeBranchCollisionError);
    expect(suffixed.branchName).toBe(`${DERIVED_BRANCH_NAME}-2`);
  });

  it("refuses a suffix that would outgrow the ref cap instead of persisting it", async () => {
    // A name accepted AT `WORKTREE_GIT_REF_MAX_LEN` collides; every suffixed
    // candidate is strictly longer than the cap, and a persisted over-cap
    // `branch_name` would fail response validation for the WHOLE T2.5 status
    // projection. The write refuses instead — `branch_name_unavailable`, the
    // same answer ordinal exhaustion gives: the request's policy has no usable
    // name left.
    const service = makeService();
    const capLengthBranchName = `feature/${"x".repeat(WORKTREE_GIT_REF_MAX_LEN - "feature/".length)}`;
    const base: Omit<CreateWorktreeInput, "onCollision"> = {
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: capLengthBranchName,
    };
    await service.create({ ...base, onCollision: "refuse" });

    const thrown = await captureRejection(() => service.create({ ...base, onCollision: "suffix" }));

    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    expect((thrown as WorktreeCreateFailedError).reason).toBe("branch_name_unavailable");
    // The guard refused before anything landed: one row, the original's.
    expect(readAllWorktreeIds()).toHaveLength(1);
  });

  it("frees the bare name in the active-branch index once the colliding row is retired", async () => {
    const service = makeService();
    const suffixingInput: CreateWorktreeInput = {
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: DERIVED_BRANCH_NAME,
      onCollision: "suffix",
    };

    const first = await service.create(suffixingInput);
    await service.retire(first.worktreeId);
    const second = await service.create(suffixingInput);

    // A claim about the DB ARBITER and nothing more: the index predicate
    // excludes retired rows, so the bare name is free again and the "live"
    // reads agree with it. It is deliberately NOT a claim that the name is
    // reusable end to end — git keeps the branch after the worktree goes (see
    // the service header's residual section), and only T2.6's real-git tier can
    // observe that leg at all.
    expect(second.branchName).toBe("sidekicks/0190f8b0/fix-login");
  });

  it("re-throws an id collision rather than reading it as a branch collision", async () => {
    // The END-TO-END guard, driven through real SQLite: an injected id source is
    // the only way to collide on the PRIMARY KEY, and because the two branch
    // names differ the branch index is not in play, so the failure reaches the
    // retry loop coded `SQLITE_CONSTRAINT_PRIMARYKEY`.
    //
    // It pins the two checks as a PAIR — losing both is what it catches — and
    // isolates neither. The per-arm isolators are the two cases below: "re-throws
    // a non-constraint append failure even on a branch that IS taken" for the
    // code check, and "re-throws a UNIQUE violation that no live row on the
    // branch explains" for the live-row confirmation. All three earn their keep;
    // none is a redundant spelling of another.
    const service = makeService({ newWorktreeId: () => FIXED_WORKTREE_ID });
    await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      branchName: "feature/first",
      onCollision: "refuse",
    });

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feature/second",
        onCollision: "refuse",
      }),
    );

    // The observable outcome, never the SQLite code: an id collision reported
    // as a branch collision would send the caller to rename a branch that is
    // not the problem.
    expect(thrown).not.toBeInstanceOf(WorktreeBranchCollisionError);
    expect(readAllWorktreeIds()).toEqual([FIXED_WORKTREE_ID]);
    expect(readWorktreeRow(FIXED_WORKTREE_ID).branch_name).toBe("feature/first");
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("re-throws a non-constraint append failure even on a branch that IS taken", async () => {
    // The CODE check, isolated. The branch genuinely has a live row, so the
    // live-row confirmation would find one and — without the code check — would
    // launder an unrelated append failure into a 409 the caller cannot clear.
    const service = makeService();
    await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      branchName: "feature/taken",
      onCollision: "refuse",
    });
    const appendFailure = new Error("fixture: the worktree.created append failed");
    const failingService = makeService({
      events: new CreatedEmissionFailingEmitter({ sessionEvents: ctx.eventLog }, appendFailure),
    });

    const thrown = await captureRejection(() =>
      failingService.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feature/taken",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBe(appendFailure);
    expect(readAllWorktreeIds()).toHaveLength(1);
  });

  it("re-throws a UNIQUE violation that no live row on the branch explains", async () => {
    // The live-row CONFIRMATION, isolated. The code says UNIQUE and no row on
    // this branch accounts for it, which is what a constraint other than the
    // active-branch index would look like from here. Trusting the code alone
    // would suffix — or refuse — over a collision that never happened.
    const uniqueViolation = Object.assign(new Error("fixture: UNIQUE constraint failed"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    const service = makeService({
      events: new CreatedEmissionFailingEmitter({ sessionEvents: ctx.eventLog }, uniqueViolation),
    });

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feature/never-created",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBe(uniqueViolation);
    expect(readAllWorktreeIds()).toEqual([]);
  });

  it("refuses a detached-HEAD mount with no explicit base ref", async () => {
    ctx.git.headBranch = null;
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    const failure = thrown as WorktreeCreateFailedError;
    expect(failure.reason).toBe("base_ref_unresolved");
    expect(failure.httpStatus).toBe(500);
    // Refused before any row was written, so there is nothing to mark failed.
    expect(readAllWorktreeIds()).toEqual([]);
    expect(readEventTypes()).toEqual([]);
  });

  it("refuses an option-like base ref before spawning git at all", async () => {
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
        baseRef: "--upload-pack=payload",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    const failure = thrown as WorktreeCreateFailedError;
    expect(failure.reason).toBe("base_ref_option_like");
    expect(ctx.git.invocations).toEqual([]);
  });

  it("cuts from an explicit base ref when one is supplied", async () => {
    const service = makeService();
    const created = await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      branchName: "feat/x",
      onCollision: "refuse",
      baseRef: "release/1.0",
    });

    expect(created.baseRef).toBe("release/1.0");
    expect(ctx.git.argvFor("worktree").at(-1)).toBe("release/1.0");
    // No HEAD query at all — the supplied ref short-circuits D-010-8's default.
    expect(ctx.git.verbs()).toEqual(["worktree"]);
  });

  it("marks the row failed without an event when materialization fails", async () => {
    ctx.git.worktreeAddFails = true;
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeCreateFailedError);
    const failure = thrown as WorktreeCreateFailedError;
    expect(failure.reason).toBe("git_invocation_failed");
    // The message must not carry the git stderr, which is where a path would be.
    expect(failure.message).not.toContain(ctx.executionRootsDirectory);

    expect(readWorktreeRow(readSoleWorktreeId()).state).toBe("failed");
    // D-010-11: the row records the failure; no `worktree.failed` event exists.
    expect(readEventTypes()).toEqual(["worktree.created"]);
    // The interrupted create leaks the same administrative entry a completed
    // one would, so the recovery prunes it too.
    expect(ctx.git.worktreeSubcommandArgvs("prune")).toEqual([
      [
        "-c",
        `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
        "-C",
        CANONICAL_ROOT,
        "worktree",
        "prune",
      ],
    ]);
  });

  it("marks the row failed and clears the root when the READY emission fails", async () => {
    // The row is `creating` at this point, which `idx_worktrees_active_branch`
    // counts as LIVE — so without the recovery the (mount, branch) pair would
    // be wedged by a row no sweep leg can reach.
    const service = makeService({
      events: new ReadyEmissionFailingEmitter({ sessionEvents: ctx.eventLog }),
    });

    const thrown = await captureRejection(() => createReadyWorktree(service));

    // The ORIGINAL failure, not whatever the recovery did about it.
    expect(thrown).toBe(READY_EMISSION_FAILURE);
    const row = readWorktreeRow(readSoleWorktreeId());
    expect(row.state).toBe("failed");
    expect(existsSync(row.fs_root)).toBe(false);
    expect(readEventTypes()).toEqual(["worktree.created"]);
    // The one recovery arm where `worktree add` SUCCEEDED in full, so the
    // administrative entry certainly exists rather than possibly — which makes
    // this the case that most needs the prune, not the one that least does.
    expect(ctx.git.worktreeSubcommandArgvs("prune")).toEqual([
      [
        "-c",
        `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
        "-C",
        CANONICAL_ROOT,
        "worktree",
        "prune",
      ],
    ]);
  });

  it("refuses an unknown mount with Plan-009's carrier", async () => {
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: OTHER_REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBeInstanceOf(RepoMountNotFoundError);
    const failure = thrown as RepoMountNotFoundError;
    expect(failure.code).toBe("repo.not_found");
  });

  it("refuses a detached mount", async () => {
    insertMount({
      repoMountId: OTHER_REPO_MOUNT_ID,
      state: "detached",
      canonicalRoot: OTHER_CANONICAL_ROOT,
    });
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.create({
        repoMountId: OTHER_REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );

    expect(thrown).toBeInstanceOf(RepoMountNotFoundError);
  });
});

// ----------------------------------------------------------------------------
// validateReuse
// ----------------------------------------------------------------------------

describe("WorktreeService.validateReuse", () => {
  it("returns a clean, compatible candidate with its provenance", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    const candidate = await service.validateReuse({
      worktreeId: created.worktreeId,
      repoMountId: REPO_MOUNT_ID,
      branchName: "feature/login",
    });

    expect(candidate.dirty).toBe(false);
    expect(candidate.state).toBe("ready");
    expect(candidate.fsRoot).toBe(created.fsRoot);
    expect(candidate.createdBySessionId).toBe(SESSION_ID);
    expect(candidate.createdByRunId).toBe(RUN_ID);
  });

  it("hook-neutralizes and stays non-mutating on the cleanliness verb too", async () => {
    // The third verb, and the reason the two quantifiers are hoisted: it is
    // reachable only through `validateReuse`, so a suite that asserted them
    // inside a `create` case alone would leave `status --porcelain` covered by
    // nothing at all.
    const service = makeService();
    const created = await createReadyWorktree(service);

    await service.validateReuse({
      worktreeId: created.worktreeId,
      repoMountId: REPO_MOUNT_ID,
      branchName: "feature/login",
    });

    expect(ctx.git.verbs()).toEqual(["symbolic-ref", "worktree", "status"]);
    assertEveryInvocationIsHookNeutralized();
    assertNoInvocationMutatesTheMainCheckout();
  });

  it("refuses a dirty candidate that was not acknowledged", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.git.statusOutput = " M src/index.ts\n";

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("dirty_unacknowledged");
    expect(conflict.code).toBe("worktree.reuse_conflict");
    expect(conflict.httpStatus).toBe(409);
  });

  it("binds a dirty candidate once the caller acknowledges it", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.git.statusOutput = " M src/index.ts\n";

    const candidate = await service.validateReuse({
      worktreeId: created.worktreeId,
      repoMountId: REPO_MOUNT_ID,
      branchName: "feature/login",
      acknowledgeDirtyCandidate: true,
    });

    expect(candidate.dirty).toBe(true);
    // Reported, not acted on: validation writes no row and emits no event.
    expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("refuses an incompatible candidate even WITH an acknowledgement", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.git.statusOutput = " M src/index.ts\n";

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/other",
        acknowledgeDirtyCandidate: true,
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("branch_mismatch");
  });

  it("refuses a candidate that belongs to another mount", async () => {
    insertMount({ repoMountId: OTHER_REPO_MOUNT_ID, canonicalRoot: OTHER_CANONICAL_ROOT });
    const service = makeService();
    const created = await createReadyWorktree(service);

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: OTHER_REPO_MOUNT_ID,
        branchName: "feature/login",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("mount_mismatch");
    // The mount check precedes the git layer, so nothing was spawned for it.
    expect(ctx.git.verbs()).toEqual(["symbolic-ref", "worktree"]);
  });

  it("refuses a retired candidate as no longer live", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("not_live");
  });

  it("refuses when the cleanliness verdict cannot be computed", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.git.statusFails = true;

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: created.worktreeId,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
        acknowledgeDirtyCandidate: true,
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeReuseConflictError);
    const conflict = thrown as WorktreeReuseConflictError;
    expect(conflict.reason).toBe("cleanliness_unresolved");
  });

  it("answers not-found for a candidate id that names no row", async () => {
    const service = makeService();

    const thrown = await captureRejection(() =>
      service.validateReuse({
        worktreeId: UNKNOWN_WORKTREE_ID,
        repoMountId: REPO_MOUNT_ID,
        branchName: "feature/login",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreeNotFoundError);
    const failure = thrown as WorktreeNotFoundError;
    expect(failure.code).toBe("worktree.not_found");
  });
});

// ----------------------------------------------------------------------------
// retire
// ----------------------------------------------------------------------------

describe("WorktreeService.retire", () => {
  it("records the retirement and leaves the root on disk (I-010-9)", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    const response = await service.retire(created.worktreeId);

    expect(response).toEqual({ worktreeId: created.worktreeId, state: "retired" });
    const row = readWorktreeRow(created.worktreeId);
    expect(row.state).toBe("retired");
    // The observable form of recorded-then-cleaned: retire stamps nothing.
    expect(row.cleaned_at).toBeNull();
    expect(existsSync(created.fsRoot)).toBe(true);
    // Provenance survives retirement (I-010-3).
    expect(row.created_by_session_id).toBe(SESSION_ID);
    expect(row.created_by_run_id).toBe(RUN_ID);
    expect(row.branch_name).toBe("feature/login");

    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready", "worktree.retired"]);
  });

  it("refuses while a busy workspace is holding the worktree", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    insertWorkspace({ state: "busy", fsRoot: created.fsRoot });

    const thrown = await captureRejection(() => service.retire(created.worktreeId));

    expect(thrown).toBeInstanceOf(WorktreeRetireConflictError);
    const conflict = thrown as WorktreeRetireConflictError;
    expect(conflict.code).toBe("worktree.retire_conflict");
    expect(conflict.httpStatus).toBe(409);
    expect(conflict.holdingWorkspaceId).toBe(WORKSPACE_ID);
    expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("retires a worktree whose historical binder is busy on a different root", async () => {
    // `branch_contexts` rows are retained history: a workspace that once bound
    // this worktree and has since reprovisioned elsewhere is not holding THIS
    // root, and a probe keyed through the context rows would refuse the
    // retirement for the whole duration of an unrelated run. The probe is
    // `fs_root`-keyed exactly so this retirement proceeds.
    const service = makeService();
    const created = await createReadyWorktree(service);
    insertWorkspace({ state: "busy", fsRoot: OTHER_CANONICAL_ROOT });
    insertBranchContext(created.worktreeId);

    const response = await service.retire(created.worktreeId);

    expect(response).toEqual({ worktreeId: created.worktreeId, state: "retired" });
    expect(readWorktreeRow(created.worktreeId).state).toBe("retired");
  });

  it("retires once a released workspace no longer holds the worktree", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    insertWorkspace({ state: "ready", fsRoot: created.fsRoot });
    insertBranchContext(created.worktreeId);

    await service.retire(created.worktreeId);

    expect(readWorktreeRow(created.worktreeId).state).toBe("retired");
  });

  it("refuses a hold taken between the read and the retirement transaction", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    // The hold lands after `retire` has read the row and before the append
    // transaction opens — the window a pre-transaction probe cannot see into,
    // and the one in which a run's execution root would otherwise be retired
    // out from under it (after which the sweep would `rm -rf` a live root).
    const racedService = makeService({
      events: new BusyHolderInjectingEmitter({ sessionEvents: ctx.eventLog }),
    });

    const thrown = await captureRejection(() => racedService.retire(created.worktreeId));

    expect(thrown).toBeInstanceOf(WorktreeRetireConflictError);
    const conflict = thrown as WorktreeRetireConflictError;
    expect(conflict.holdingWorkspaceId).toBe(WORKSPACE_ID);
    // A prelude throw aborts before the event INSERT, so the refusal persists
    // nothing: not the row flip, not the event.
    expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("answers idempotently when a concurrent retirement wins the race", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    // The competing retirement commits inside the same window. Before the
    // in-prelude state re-check, this surfaced as an anonymous internal error
    // from the compare-and-swap assert — contradicting the documented
    // idempotency for a race the method is supposed to absorb.
    const racedService = makeService({
      events: new PreRetiringEmitter({ sessionEvents: ctx.eventLog }),
    });

    const response = await racedService.retire(created.worktreeId);

    expect(response).toEqual({ worktreeId: created.worktreeId, state: "retired" });
    expect(readWorktreeRow(created.worktreeId).state).toBe("retired");
    // No SECOND `worktree.retired`: one event per real transition (I-010-13),
    // and this call performed none.
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("is idempotent and emits no second event", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);
    const typesAfterFirst = readEventTypes();

    const response = await service.retire(created.worktreeId);

    expect(response.state).toBe("retired");
    expect(readEventTypes()).toEqual(typesAfterFirst);
  });

  it("retires a failed row, its only route to sweep eligibility", async () => {
    // The `failed -> retired` admission the service documents as deliberate. A
    // creation that never materialized still owns a row, and `cleanupPass` only
    // ever looks at `retired` rows — so without this transition the row would
    // sit forever, which is why `failed` is a legal predecessor even though it
    // is never a retire OUTCOME.
    ctx.git.worktreeAddFails = true;
    const service = makeService();
    await captureRejection(() =>
      service.create({
        repoMountId: REPO_MOUNT_ID,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        branchName: "feat/x",
        onCollision: "refuse",
      }),
    );
    const failedWorktreeId = readSoleWorktreeId();
    expect(readWorktreeRow(failedWorktreeId).state).toBe("failed");

    const response = await service.retire(failedWorktreeId);

    expect(response.state).toBe("retired");
    const retiredRow = readWorktreeRow(failedWorktreeId);
    expect(retiredRow.state).toBe("retired");
    // Provenance survives (I-010-3), and it is the ROW's own session the
    // retirement event rode — the only prior event is `worktree.created`,
    // because `-> failed` emits none (D-010-11).
    expect(retiredRow.created_by_session_id).toBe(SESSION_ID);
    expect(retiredRow.created_by_run_id).toBe(RUN_ID);
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.retired"]);

    const cleanup = await service.cleanupPass();

    // Sweep-eligible now. The root removal tolerates the debris directory the
    // failure path already cleared, so leg (d) still stamps — and leg (c) is
    // EMPTY, which is what makes this the retirement's doing rather than a
    // cascade the sweep would have performed anyway.
    expect(cleanup.retiredWorktreeIds).toEqual([]);
    expect(cleanup.cleanedWorktreeIds).toEqual([failedWorktreeId]);
    expect(readWorktreeRow(failedWorktreeId).cleaned_at).not.toBeNull();
  });

  it("answers not-found for an unknown worktree", async () => {
    const service = makeService();

    const thrown = await captureRejection(() => service.retire(UNKNOWN_WORKTREE_ID));

    expect(thrown).toBeInstanceOf(WorktreeNotFoundError);
  });
});

// ----------------------------------------------------------------------------
// cleanupPass
// ----------------------------------------------------------------------------

describe("WorktreeService.cleanupPass", () => {
  it("removes a retired root and only then stamps cleaned_at", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);

    const result = await service.cleanupPass();

    expect(result.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(existsSync(created.fsRoot)).toBe(false);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).not.toBeNull();
  });

  it("unregisters the worktree with git as part of the cleanup", async () => {
    // The directory removal alone leaves a `$GIT_DIR/worktrees/<name>` entry in
    // the USER's repository, visible in every `git worktree list` they run and
    // pruned by nothing else in the daemon.
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);

    await service.cleanupPass();

    expect(ctx.git.worktreeSubcommandArgvs("prune")).toEqual([
      [
        "-c",
        `core.hooksPath=${ctx.hookNeutralizationDirectory}`,
        "-C",
        CANONICAL_ROOT,
        "worktree",
        "prune",
      ],
    ]);
    // The fourth invocation shape, held to both per-invocation quantifiers.
    assertEveryInvocationIsHookNeutralized();
    assertNoInvocationMutatesTheMainCheckout();
  });

  it("still stamps cleaned_at when the prune fails", async () => {
    // Best-effort by design: the load-bearing half (the removal) has already
    // succeeded, and propagating a bookkeeping failure would wedge every later
    // row in the pass behind a cosmetic one.
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);
    ctx.git.worktreePruneFails = true;

    const result = await service.cleanupPass();

    expect(result.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(existsSync(created.fsRoot)).toBe(false);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).not.toBeNull();
  });

  it("skips a row a concurrent retirement already recorded and finishes the pass", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.db.prepare(`UPDATE repo_mounts SET state = 'detached' WHERE id = ?`).run(REPO_MOUNT_ID);
    const racedService = makeService({
      events: new PreRetiringEmitter({ sessionEvents: ctx.eventLog }),
    });

    const result = await racedService.cleanupPass();

    // An EMPTY `retiredWorktreeIds` here is the sentinel's signature, not the
    // sweep query's: the mount is detached and the row was live when leg (c)
    // selected it, so the row WAS visited — it is absent from the result only
    // because the prelude found the competing retirement and the pass skipped
    // past it. That it still appears below is what "continue" buys.
    expect(result.retiredWorktreeIds).toEqual([]);
    expect(result.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).not.toBeNull();
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("propagates a busy hold on the cascade arm instead of sweeping past it", async () => {
    // Leg (c) reaches retirement through the SAME prelude `retire` does, so the
    // busy probe is structural on this arm rather than absent — and the sweep
    // documents the resulting conflict as propagating fail-closed.
    //
    // The state is one Plan-009's detach guard makes unreachable (it refuses to
    // detach while a dependent workspace is busy), so it is constructed directly
    // here. That is the point of the pin: if the two plans' tables ever disagree,
    // the sweep must report it rather than retire a root a live run is using and
    // then remove it from disk in the same pass.
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.db.prepare(`UPDATE repo_mounts SET state = 'detached' WHERE id = ?`).run(REPO_MOUNT_ID);
    insertWorkspace({ state: "busy", fsRoot: created.fsRoot });

    const thrown = await captureRejection(() => service.cleanupPass());

    expect(thrown).toBeInstanceOf(WorktreeRetireConflictError);
    const conflict = thrown as WorktreeRetireConflictError;
    expect(conflict.holdingWorkspaceId).toBe(WORKSPACE_ID);
    // Nothing downstream of the refusal ran: the row never left `ready`, no
    // retirement event landed, and leg (d) — which would have removed the root
    // out from under the holder — never began.
    const row = readWorktreeRow(created.worktreeId);
    expect(row.state).toBe("ready");
    expect(row.cleaned_at).toBeNull();
    expect(existsSync(created.fsRoot)).toBe(true);
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready"]);
  });

  it("defers leg (d) removal while a busy workspace holds the retired root", async () => {
    // The retire-time probe decides at the retirement instant, and Plan-009's
    // `markBusy` requires only `ready` — so a workspace still pointing at the
    // root can become busy AFTERWARD. Without the sweep-side deferral the next
    // pass would remove a working tree out from under the run holding it.
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);
    insertWorkspace({ state: "busy", fsRoot: created.fsRoot });

    const held = await service.cleanupPass();

    expect(held.cleanedWorktreeIds).toEqual([]);
    expect(existsSync(created.fsRoot)).toBe(true);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).toBeNull();

    // Deferral, not exclusion: the holder returning to `ready` releases the
    // root to the very next pass.
    ctx.db.prepare(`UPDATE workspaces SET state = 'ready' WHERE id = ?`).run(WORKSPACE_ID);
    const released = await service.cleanupPass();

    expect(released.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(existsSync(created.fsRoot)).toBe(false);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).not.toBeNull();
  });

  it("re-decides the leg (d) deferral per row, before each removal", async () => {
    // The candidate list is a SNAPSHOT: a `markBusy` landing during an earlier
    // row's removal await would be invisible to a predicate evaluated once for
    // the whole pass, and the pass would then delete a working tree a live run
    // just received. Symmetric injection on purpose — leg (d)'s ordering is
    // not observable here, so whichever root is removed first takes a busy
    // hold on the OTHER, the deterministic form of "markBusy landed mid-pass".
    const service = makeService();
    const first = await createReadyWorktree(service);
    const second = await service.create({
      repoMountId: REPO_MOUNT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      branchName: "feature/second",
      onCollision: "refuse",
    });
    await service.retire(first.worktreeId);
    await service.retire(second.worktreeId);
    const otherRootOf = new Map([
      [first.fsRoot, second.fsRoot],
      [second.fsRoot, first.fsRoot],
    ]);
    let holdTaken = false;
    const raceInjectingFilesystem: WorktreeFilesystem = {
      createDirectory: (path: string): Promise<void> => {
        mkdirSync(path, { recursive: true });
        return Promise.resolve();
      },
      removeDirectory: (path: string): Promise<void> => {
        const otherRoot = otherRootOf.get(path);
        if (!holdTaken && otherRoot !== undefined) {
          insertWorkspace({ state: "busy", fsRoot: otherRoot });
          holdTaken = true;
        }
        rmSync(path, { recursive: true, force: true });
        return Promise.resolve();
      },
    };
    const racedService = makeService({ filesystem: raceInjectingFilesystem });

    const raced = await racedService.cleanupPass();

    // Exactly one root survived: the one whose hold landed mid-pass.
    expect(raced.cleanedWorktreeIds).toHaveLength(1);
    const survivors = [first, second].filter((worktree) => existsSync(worktree.fsRoot));
    expect(survivors).toHaveLength(1);
    const survivor = survivors[0];
    if (survivor === undefined) {
      throw new Error("expected a surviving worktree root");
    }
    expect(readWorktreeRow(survivor.worktreeId).cleaned_at).toBeNull();

    // Deferral, not exclusion: releasing the hold frees the root to the next
    // pass.
    ctx.db.prepare(`UPDATE workspaces SET state = 'ready' WHERE id = ?`).run(WORKSPACE_ID);
    const released = await service.cleanupPass();
    expect(released.cleanedWorktreeIds).toEqual([survivor.worktreeId]);
    expect(existsSync(survivor.fsRoot)).toBe(false);
  });

  it("is a no-op on a second pass", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    await service.retire(created.worktreeId);
    const first = await service.cleanupPass();
    const stampedAt = readWorktreeRow(created.worktreeId).cleaned_at;

    const second = await service.cleanupPass();

    expect(first.cleanedWorktreeIds).toHaveLength(1);
    expect(second.cleanedWorktreeIds).toEqual([]);
    expect(second.retiredWorktreeIds).toEqual([]);
    expect(readWorktreeRow(created.worktreeId).cleaned_at).toBe(stampedAt);
  });

  it("leaves a live worktree on an attached mount alone", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);

    const result = await service.cleanupPass();

    expect(result).toEqual({ retiredWorktreeIds: [], cleanedWorktreeIds: [] });
    expect(readWorktreeRow(created.worktreeId).state).toBe("ready");
    expect(existsSync(created.fsRoot)).toBe(true);
  });

  it("cascades a retirement onto worktrees whose mount is no longer attached", async () => {
    const service = makeService();
    const created = await createReadyWorktree(service);
    ctx.db.prepare(`UPDATE repo_mounts SET state = 'detached' WHERE id = ?`).run(REPO_MOUNT_ID);

    const result = await service.cleanupPass();

    expect(result.retiredWorktreeIds).toEqual([created.worktreeId]);
    expect(readWorktreeRow(created.worktreeId).state).toBe("retired");
    // Cascade-retired in the same tick, then cleaned by leg (d).
    expect(result.cleanedWorktreeIds).toEqual([created.worktreeId]);
    expect(readEventTypes()).toEqual(["worktree.created", "worktree.ready", "worktree.retired"]);
  });
});

// ----------------------------------------------------------------------------
// The typed error vocabulary — `error-contracts.md` §Worktree / §Ephemeral
// Clone / §Workspace
// ----------------------------------------------------------------------------

// `name` is spelled as a LITERAL per case, never derived from the instance.
// `DaemonDomainError` sets `this.name = new.target.name`, so asserting
// `error.name === error.constructor.name` would assert that JavaScript works;
// the literal catches a subclass that shadows `name` and so breaks the log and
// crash-report vocabulary downstream tasks grep for.
interface CarrierCase {
  readonly error: DaemonDomainError;
  readonly name: string;
  readonly code: string;
  readonly httpStatus: number;
}

function allCarriers(): readonly CarrierCase[] {
  return [
    {
      error: new WorktreeNotFoundError(UNKNOWN_WORKTREE_ID),
      name: "WorktreeNotFoundError",
      code: "worktree.not_found",
      httpStatus: 404,
    },
    {
      error: new WorktreeCreateFailedError("git_invocation_failed"),
      name: "WorktreeCreateFailedError",
      code: "worktree.create_failed",
      httpStatus: 500,
    },
    {
      error: new WorktreeBranchCollisionError(REPO_MOUNT_ID, "feature/login"),
      name: "WorktreeBranchCollisionError",
      code: "worktree.branch_collision",
      httpStatus: 409,
    },
    {
      error: new WorktreeReuseConflictError(UNKNOWN_WORKTREE_ID, "not_live"),
      name: "WorktreeReuseConflictError",
      code: "worktree.reuse_conflict",
      httpStatus: 409,
    },
    {
      error: new WorktreeRetireConflictError(UNKNOWN_WORKTREE_ID, WORKSPACE_ID),
      name: "WorktreeRetireConflictError",
      code: "worktree.retire_conflict",
      httpStatus: 409,
    },
    {
      error: new CloneNotFoundError(UNKNOWN_WORKTREE_ID),
      name: "CloneNotFoundError",
      code: "clone.not_found",
      httpStatus: 404,
    },
    {
      error: new ClonePrepareFailedError("clone_invocation_failed"),
      name: "ClonePrepareFailedError",
      code: "clone.prepare_failed",
      httpStatus: 500,
    },
    {
      error: new WorkspaceBranchMismatchError(WORKSPACE_ID, "feature/login", HEAD_BRANCH),
      name: "WorkspaceBranchMismatchError",
      code: "workspace.branch_mismatch",
      httpStatus: 409,
    },
    {
      error: new WorkspaceExecutionRootUnresolvedError(WORKSPACE_ID, "worktree.create_failed"),
      name: "WorkspaceExecutionRootUnresolvedError",
      code: "workspace.execution_root_unresolved",
      httpStatus: 409,
    },
    {
      error: new WorkspaceBranchNameRequiredError(WORKSPACE_ID),
      name: "WorkspaceBranchNameRequiredError",
      code: "workspace.branch_name_required",
      httpStatus: 400,
    },
  ];
}

/**
 * Whether an exported value is one of the module's `DaemonDomainError`
 * subclasses.
 *
 * Keyed on the PROTOTYPE CHAIN rather than on a name convention: the three
 * exported `*_ERROR_CODES` arrays are not functions and drop out on the first
 * clause, and a future exported helper function would not extend the base.
 */
function isCarrierClass(candidate: unknown): boolean {
  return typeof candidate === "function" && candidate.prototype instanceof DaemonDomainError;
}

/**
 * How many carrier classes the errors module EXPORTS, discovered from its
 * namespace rather than listed.
 *
 * This is the leg set-equality cannot cover, and the claim
 * `WORKTREE_ERROR_CODES`' docblock makes. `registeredPlan010Codes()` proves the
 * enumerated carriers and the three registries agree — but BOTH sides of that
 * comparison are written by hand here, so a class the module exports and
 * `allCarriers()` forgets leaves the comparison consistent and the class
 * asserted by nothing. Reading the namespace is what makes the census
 * independent of the list it is checking.
 */
function countExportedCarrierClasses(): number {
  return Object.values(worktreeErrorsModule).filter(isCarrierClass).length;
}

function registeredPlan010Codes(): readonly string[] {
  return [
    ...WORKTREE_ERROR_CODES,
    ...EPHEMERAL_CLONE_ERROR_CODES,
    ...PLAN_010_WORKSPACE_ERROR_CODES,
  ];
}

describe("Plan-010 error vocabulary", () => {
  it("carries the ratified code and notional status on every class", () => {
    for (const carrier of allCarriers()) {
      expect(carrier.error.code).toBe(carrier.code);
      expect(carrier.error.httpStatus).toBe(carrier.httpStatus);
      expect(carrier.error.name).toBe(carrier.name);
    }
  });

  it("covers the three registries exactly", () => {
    const registered = registeredPlan010Codes();
    const carried = allCarriers().map((carrier) => carrier.error.code);

    expect([...carried].sort()).toEqual([...registered].sort());
    expect(new Set(registered).size).toBe(registered.length);
  });

  it("enumerates every carrier class the module exports", () => {
    // The header's "SCOPE: ten classes" claim, pinned twice: against the
    // module's own exports, and against the literal that scope note names.
    expect(countExportedCarrierClasses()).toBe(10);
    expect(allCarriers()).toHaveLength(countExportedCarrierClasses());
  });

  it("declares no carrier for the Plan-009-owned workspace.busy code", () => {
    // `workspace.busy` ships as `WorkspaceBusyError` in the Plan-009 workspace
    // service. Re-declaring it here would fork a live symbol — two classes
    // minting one code, with `instanceof` depending on the import site.
    expect(registeredPlan010Codes()).not.toContain("workspace.busy");
  });

  it("routes not-found carriers to InvalidParams and leaves the rest unset", () => {
    for (const carrier of allCarriers()) {
      if (carrier.code.endsWith(".not_found")) {
        expect(carrier.error.jsonRpcCode).toBe(JsonRpcErrorCode.InvalidParams);
      } else {
        expect(carrier.error.jsonRpcCode).toBeUndefined();
      }
    }
  });

  it("omits the causeCode key entirely when no cause was captured", () => {
    const error = new WorkspaceExecutionRootUnresolvedError(WORKSPACE_ID, null);

    expect(error.causeCode).toBeNull();
    // The absence is reported by DROPPING the clause, never by rendering the
    // sentinel into prose a user reads.
    expect(error.message).not.toContain("null");
    expect(error.message).toContain("root preparation failed and the run stays parked in setup");
    // Positive membership: the conditional spread omits the key rather than
    // carrying `causeCode: null` through to `data.fields`.
    expect(error.detail).toEqual({ workspaceId: WORKSPACE_ID });
    expect(error.detail).not.toHaveProperty("causeCode");

    // The contrast pins the BRANCH rather than one side of it.
    const withCause = new WorkspaceExecutionRootUnresolvedError(
      WORKSPACE_ID,
      "worktree.create_failed",
    );
    expect(withCause.message).toContain("worktree.create_failed");
    expect(withCause.detail).toEqual({
      workspaceId: WORKSPACE_ID,
      causeCode: "worktree.create_failed",
    });
  });

  it("never echoes a filesystem path in a creation-failure message", () => {
    // A total `Record` rather than an array literal, so the "never" quantifier
    // is enforced by the compiler: a reason added to the union without a row
    // here fails to typecheck instead of silently escaping the sweep. Values
    // rather than keys because `Object.values` preserves the union type, where
    // `Object.keys` would widen to `string` and need a cast.
    const reasons: Record<WorktreeCreateFailureReason, WorktreeCreateFailureReason> = {
      base_ref_option_like: "base_ref_option_like",
      base_ref_unresolved: "base_ref_unresolved",
      branch_name_unavailable: "branch_name_unavailable",
      execution_root_unavailable: "execution_root_unavailable",
      git_invocation_failed: "git_invocation_failed",
      branch_name_underivable: "branch_name_underivable",
    };

    for (const reason of Object.values(reasons)) {
      const error = new WorktreeCreateFailedError(reason);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).not.toMatch(/[\\/]/);
      expect(error.detail).toEqual({ reason });
    }
  });
});
