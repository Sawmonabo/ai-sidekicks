/**
 * Repo-mount lifecycle service — the daemon-side owner of the `repo_mounts`
 * table (Plan-009 Phase 2, T2.3).
 *
 * Spec coverage: `Spec-009 §Required Behavior` (attach resolves and persists the
 * canonical repository root before anything else may reference it),
 * `Spec-009 §Default Behavior` (attach unconditionally creates the default
 * read-only workspace, git and non-git alike),
 * `Spec-009 §Fallback Behavior` (resolution failure is an explicit typed
 * refusal, never a guessed root), `Spec-009 §Detach Semantics (V1 Definition)`
 * (busy-dependent refusal, archive cascade, terminal `detached`),
 * `Spec-009 §Local Trust Envelope (V1 Definition)` (attach IS envelope
 * admission), `Spec-009 §Repo Mount Health (V1 Definition)` (the on-read probe
 * floor).
 *
 * Verifies invariant: I-009-1 (the persisted root is the resolver's canonical
 * output, never the entered path), I-009-2 (a root that cannot be resolved
 * fails loudly and persists nothing), I-009-4 (a non-git directory is recorded
 * honestly as `vcs_type 'none'`, which is not an error), I-009-5 (every mount
 * row carries resolved identity AND provenance), I-009-9 (exactly one lifecycle
 * event per real transition, committed with the row that caused it).
 *
 * ## Attach composes T2.4's two-closure creation, and the order is the contract
 *
 * `WorkspaceService.createDefaultWorkspace` returns a `DefaultWorkspaceCreation`
 * (`./workspace-service.js`) split in two halves precisely so this module can
 * commit the mount row and its default workspace row in ONE transaction:
 *
 * ```ts
 * const creation = workspaces.createDefaultWorkspace({ ... });
 * await events.emitRepoAttached({
 *   sessionId, repoMountId,
 *   transactionalPrelude: () => { insertMountRow(); creation.insertRow(); },
 * });
 * await creation.emitReady();
 * ```
 *
 * Do not reorder it. D-009-7 makes `defaultWorkspaceId` REQUIRED on the ATTACH
 * response — `RepoMountReadResponse` carries no such field, so the read side is
 * not what forces this. The contract states the reason directly
 * (`packages/contracts/src/repo.ts`, at `RepoAttachResponse.defaultWorkspaceId`):
 * optionality "would make 'attached, but no workspace' representable, and the
 * persistence model never produces it". A mount row committed without its
 * workspace row is exactly that unrepresentable state made durable. Both INSERTs
 * ride the `repo.attached` append's prelude so it cannot arise.
 *
 * The residual windows are the survivable ones, and both are post-commit:
 *
 *   * CRASH after the commit — both rows present and consistent,
 *     `workspace.ready` missing.
 *   * THROW from `creation.emitReady()` — same durable state, but the caller
 *     also gets a rejection while the mount is attached and holding its entry in
 *     `idx_repo_mounts_active_root`. A caller that reads the rejection as "the
 *     attach failed" and retries does NOT double-attach: the retry hits the
 *     index and surfaces `repo.already_attached` carrying
 *     `conflictingRepoMountId`, which names the mount the first call created.
 *     That is how the caller recovers the id the throw denied it.
 *
 * ## Attach refuses in a fixed order, and each position is load-bearing
 *
 * 1. **Session existence, before anything else.** `Plan-009 T2.3` names
 *    `SessionService.replay(sessionId)` returning `null` as the daemon's
 *    session-existence predicate, and attach refuses on `null` BEFORE resolving
 *    or persisting anything. Resolving first would spawn a `git` subprocess
 *    against an operator-supplied path on behalf of a session that does not
 *    exist; persisting first would leave a mount row (and its workspace, and two
 *    events) parented to nothing — `repo_mounts.session_id` carries no foreign
 *    key, so the database would not catch it.
 * 2. **Canonical-root resolution.** T1.5's resolver throws typed
 *    `repo.root_resolution_failed` on every non-resolution (I-009-2). Nothing
 *    has been written at this point, so the "persists nothing" half of that
 *    invariant is structural rather than a promise.
 * 3. **Active-root uniqueness.** Enforced by `idx_repo_mounts_active_root`
 *    inside the write transaction, NOT by a read-then-insert check — see below.
 *
 * ## NO containment check fires at attach
 *
 * This is the one place in Plan-009 where a path is accepted without being
 * tested against the session's trust envelope, and it is deliberate:
 * `Spec-009 §Local Trust Envelope (V1 Definition)` defines the envelope AS the
 * set of attached mount roots, and "envelope admission is the explicit
 * `RepoAttach` action; no path enters the envelope implicitly". Validating an
 * attach against the envelope would make the first attach of a session
 * impossible (an empty envelope contains nothing) and every later one a
 * subdirectory-only operation. Containment is T1.6's job at BIND time (I-009-3),
 * against the roots this method admitted.
 *
 * ## Duplicate detection is the index, not a pre-read
 *
 * A `SELECT`-then-`INSERT` uniqueness check would be a TOCTOU window: two
 * attaches of the same root interleaving at either `await` would both read
 * "free" and both insert, and the second would fail the index anyway — with the
 * failure surfacing as an anonymous internal error rather than
 * `repo.already_attached`. So the INSERT runs unguarded and its constraint
 * failure is translated INSIDE the prelude, by looking up the row that actually
 * holds the root. That lookup is also the discrimination: a constraint failure
 * with no conflicting active mount is some OTHER constraint (a minted-id
 * collision, say) and is rethrown untranslated.
 *
 * The translation throws, which aborts the transaction — so the refused attach
 * takes the `repo.attached` event row with it. Note WHERE it throws: the mount
 * INSERT is the FIRST statement in the prelude, so on the duplicate-root path
 * `creation.insertRow()` is never reached and no workspace row was written to
 * roll back. The rollback still matters for the event row, and for any prelude
 * failure that happens after both INSERTs. Either way, nothing lands.
 *
 * ## Detach reads its dependents inside the transaction that flips the mount
 *
 * T2.4's bind INSERT is conditional on `state = 'attached'`, which closes the
 * bind-vs-detach race from the BIND side: a bind that passes over an
 * about-to-detach mount writes zero rows and aborts. This module closes it from
 * the detach side, and the two halves only compose if the dependent-set read,
 * the archive writes, and the mount flip all happen in ONE transaction. Reading
 * the dependents outside it would let a bind commit a `ready` workspace in the
 * window between the read and the flip: the bind's own guard would pass (the
 * mount is still `attached`), and the cascade would then archive a set computed
 * before that workspace existed, leaving a live execution root on a detached
 * mount — exactly the I-009-3 hole the bind-side predicate was added to close.
 *
 * The mount flip is a compare-and-swap on `state = 'attached'`. Zero rows
 * changed means a concurrent detach won; the transaction aborts and the loser
 * returns the winner's outcome rather than appending a second `repo.detached`
 * for one transition (I-009-9).
 *
 * ## Detach's event order, and the crash window it accepts
 *
 * `repo.detached` is appended FIRST — it is the append whose prelude carries
 * every row write — and each `workspace.archived` follows, one per workspace the
 * cascade actually transitioned. The alternative (archived events first) is not
 * merely a different order: those events would have to be appended BEFORE their
 * rows moved, so a crash mid-sequence would leave `workspace.archived` events
 * for workspaces still sitting `ready`. Events describing transitions that never
 * happened are a strictly worse I-009-9 breach than events missing for
 * transitions that did.
 *
 * The accepted window is therefore: all rows durable, `repo.detached` durable,
 * some `workspace.archived` events missing. The same survivable class as the
 * attach window above.
 *
 * Two things reach that window, and they differ in what the caller learns. A
 * CRASH mid-loop is silent. A THROWING append is not: the loop attempts every
 * remaining announcement anyway — one bad append must not strand the events
 * after it, and independent appends carry no information about each other — and
 * the call then rejects with `detach_notification_incomplete`.
 *
 * Neither is repairable by calling `detach` again. The mount is already
 * `detached`, so a second call takes the no-op path and announces nothing; and
 * re-announcing would require distinguishing "this append failed" from "this
 * append landed and I failed to observe it", which nothing here can do. What
 * survives is what matters: the `archived` rows are the truth, and a projector
 * rebuilding from them reaches the correct end state regardless of which
 * announcements landed.
 *
 * Those follow-on events carry no `causationId` pointing at the `repo.detached`
 * they belong to. T2.2 ratified append receipts as UNEXAMINED (this module never
 * reads `.sequence`, `.eventId`, or anything else off one), so the emitted
 * event's id is not available to name as a cause without breaking that seam. The
 * caller's `correlationId` is threaded through every event of the cascade
 * instead, which is what makes them collatable.
 *
 * ## The Windows `git` seam
 *
 * `Plan-009 §Notes` (2026-07-25) records that libuv resolves a bare executable
 * name against the CHILD's working directory first on Windows, so spawning bare
 * `git` with `cwd` set to an operator-supplied repository path can execute a
 * `git.exe` sitting in that repository. T1.5's resolver takes an injectable
 * `gitExecutablePath` for exactly this, and this service exposes it through
 * {@link RepoMountServiceDeps.gitExecutablePath} so the daemon-config surface
 * can supply an ABSOLUTE path on `win32` without this module having to know
 * where the daemon keeps its configuration. Supplying both a ready-made
 * `resolver` and a `gitExecutablePath` is a construction-time error rather than
 * a silent precedence rule: silently ignoring an absolute git path is the exact
 * hazard the seam exists to prevent.
 */

import { randomUUID } from "node:crypto";

import type { Database, Statement } from "better-sqlite3";

import {
  RepoAttachResponseSchema,
  RepoDetachResponseSchema,
  RepoMountReadResponseSchema,
  type RepoAttachRequest,
  type RepoAttachResponse,
  type RepoDetachRequest,
  type RepoDetachResponse,
  type RepoMountId,
  type RepoMountReadResponse,
  type RepoMountState,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

import { SessionNotFoundError } from "../ipc/session-errors.js";

import {
  RepoAlreadyAttachedError,
  RepoDetachConflictError,
  RepoMountNotFoundError,
} from "./repo-errors.js";
import { RepoRootResolver } from "./repo-root-resolver.js";
import {
  DEFAULT_DIRECTORY_READABILITY_PROBE,
  type DirectoryReadabilityProbe,
} from "./trust-envelope.js";
import type { WorkspaceEventEmitter } from "./workspace-event-emitter.js";
import { computeRepoMountHealth, type FilesystemPathProbe } from "./workspace-projector.js";
import type { FilesystemPathProbeFn, WorkspaceService } from "./workspace-service.js";

// --------------------------------------------------------------------------
// Error carriers
// --------------------------------------------------------------------------

/**
 * The two daemon-internal failure classes this module can raise.
 *
 * One error class with a discriminant rather than two classes, mirroring
 * `WorkspaceServiceInvariantError`: both are the same wire outcome (an
 * anonymous internal error) and differ only in what an operator should go
 * inspect.
 */
export type RepoMountServiceInvariantKind =
  /**
   * A mount row — stored, or about to be — cannot be projected onto its wire
   * shape: an identifier the contracts schemas refuse, a `state` or `vcs_type`
   * outside the ratified vocabulary, an `attached_at` that is not ISO-8601. DB
   * corruption, or an id source that does not mint real UUIDs. The row is the
   * thing to inspect.
   */
  | "repo_mount_row_unprojectable"
  /**
   * A write inside the detach transaction matched no row when the transaction
   * guaranteed it would — the cascade read a workspace as non-`archived` and
   * then failed to archive it, with no interleaving writer possible. The write
   * path is the defect, not the row.
   */
  | "detach_cascade_diverged"
  /**
   * The detach COMMITTED — every dependent is archived and the mount is
   * `detached` — but one or more of the post-commit `workspace.archived`
   * appends failed, so the log under-reports what the rows already did.
   *
   * Unlike its two siblings this is not necessarily a bug: an append can fail
   * on a signing-key outage or a disk error. It shares the carrier because it
   * shares the defining property — there is no registered wire code for "the
   * write succeeded but the announcement did not". The rows are the truth; see
   * {@link RepoMountService.detach} for what a caller can and cannot recover.
   */
  | "detach_notification_incomplete";

/**
 * A daemon-internal failure with no registered wire code.
 *
 * Deliberately NOT a `DaemonDomainError`, for the reason
 * `WorkspaceServiceInvariantError` documents at length: minting an unregistered
 * `repo.*` code is banned by the error-contract registry, and borrowing a
 * registered one would misreport the cause. Reaching the IPC boundary as an
 * anonymous `-32603` is the correct outcome for corruption and bugs.
 */
export class RepoMountServiceInvariantError extends Error {
  /** What broke. See {@link RepoMountServiceInvariantKind}. */
  readonly kind: RepoMountServiceInvariantKind;
  /** The mount this failure attaches to, or `null` when no mount is implicated. */
  readonly repoMountId: string | null;

  constructor(
    message: string,
    options: {
      readonly kind: RepoMountServiceInvariantKind;
      readonly repoMountId?: string | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    // The class name comes from the constructor that ran, as on both sibling
    // carriers (`DaemonDomainError`, `WorkspaceServiceInvariantError`).
    this.name = new.target.name;
    this.kind = options.kind;
    this.repoMountId = options.repoMountId ?? null;
  }
}

/**
 * Module-private abort signal for {@link RepoMountService.detach}'s in-prelude
 * compare-and-swap on the mount state.
 *
 * The append path runs the prelude and then INSERTs the event row
 * UNCONDITIONALLY — only a throw rolls the transaction back. A prelude that
 * merely recorded "my flip matched no row" and returned would still commit a
 * `repo.detached` event for a transition that did not happen, which is the
 * I-009-9 duplicate the compare-and-swap exists to prevent. Throwing is the only
 * way to say "abort, but this is not an error".
 *
 * Modelled on `./workspace-service.js`'s `StaleTransitionRaceError`, and
 * unexported for the same reason: it never escapes this module, and it names an
 * internal concurrency event rather than anything a caller did wrong.
 */
class MountDetachRaceError extends Error {
  constructor(repoMountId: string) {
    super(
      `RepoMountService.detach: repo mount ${repoMountId} left the attached state between the ` +
        `read and the write transaction; aborting so no second repo.detached event is appended ` +
        `for one transition.`,
    );
    this.name = "MountDetachRaceError";
  }
}

// --------------------------------------------------------------------------
// Row and dependency shapes
// --------------------------------------------------------------------------

/** The `repo_mounts` columns this service reads. */
interface RepoMountRow {
  readonly id: string;
  readonly session_id: string;
  readonly node_id: string;
  readonly local_path: string;
  readonly canonical_root: string;
  readonly vcs_type: string;
  readonly state: string;
  readonly attached_at: string;
}

/** The `workspaces` columns the detach cascade reads. */
interface DependentWorkspaceRow {
  readonly id: string;
  readonly state: string;
}

/**
 * The one question this service asks the session domain: does this session
 * exist?
 *
 * Structural and minimal on purpose — the same stance T2.2's emitter takes on
 * its append seam. `SessionService.replay(sessionId)` satisfies it, and
 * `Plan-009 T2.3` names that method as the daemon's session-existence
 * predicate: `null` means "no such session".
 *
 * The return type is `unknown` because only the `null` / non-`null`
 * discrimination is read here. Widening it to the real snapshot type would
 * couple this module to the session projection's shape for no gain, and would
 * invite a future reader to start branching on session CONTENT — which is the
 * session domain's authority, not this one's.
 *
 * A `replay` that THROWS (a corrupt event chain whose first event is not
 * `session.created`) propagates unchanged. That is not "session not found": the
 * session exists and its log is damaged, and reporting a 404 for it would send
 * an operator to create a session that is already there.
 */
export interface SessionExistenceReader {
  replay(sessionId: string): unknown;
}

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface RepoMountServiceDeps {
  /** Open daemon database. Statements are prepared once, in the constructor. */
  readonly database: Database;
  /** The single seam through which repo/workspace lifecycle events are appended (T2.2). */
  readonly events: WorkspaceEventEmitter;
  /** Owner of the `workspaces` table (T2.4). Attach's default workspace is created through it. */
  readonly workspaces: WorkspaceService;
  /** Session-existence predicate. See {@link SessionExistenceReader}. */
  readonly sessions: SessionExistenceReader;
  /**
   * Canonical-root resolver (T1.5). Defaults to a stock `RepoRootResolver`.
   * Mutually exclusive with {@link gitExecutablePath} — see the header.
   */
  readonly resolver?: RepoRootResolver;
  /**
   * Absolute path to the `git` executable, forwarded to the default resolver.
   * REQUIRED on `win32` — and ENFORCED there, not merely documented: omitting
   * it while also omitting {@link resolver} is a construction-time `TypeError`.
   * The daemon-config surface supplies it.
   */
  readonly gitExecutablePath?: string;
  /**
   * Effective platform for the win32 `git`-pinning requirement. Defaults to
   * `process.platform`.
   *
   * Injected for the reason `./repo-root-resolver.js` gives for deriving
   * win32-ness from its injected `path` module: a guard keyed off the REAL
   * platform is exercised only on a Windows runner, so "the branch that matters
   * most on an ADR-019 V1 tier" would ship untested. The pty package takes the
   * same seam (`platform: partial.platform ?? process.platform`).
   *
   * Not a bypass: a caller who wants no pinning can already pass its own
   * {@link resolver}, which this guard deliberately accepts. The guard exists to
   * catch an OMISSION by the composition root, not to fence off a hostile
   * caller — so making its input injectable costs nothing it was protecting.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * Reachability probe for {@link RepoMountService.read}'s health projection.
   * Defaults to a composition of `DEFAULT_DIRECTORY_READABILITY_PROBE` with the
   * wall clock, reading the clock BEFORE the probe so `checkedAt` is never newer
   * than the observation it timestamps.
   */
  readonly probePath?: FilesystemPathProbeFn;
  /** ISO-8601 wall clock for `attached_at` / `updated_at`. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /**
   * Mount-id source. Defaults to `crypto.randomUUID()`. Injected ids still pass
   * through `RepoMountIdSchema` on the attach response, so a test source must
   * mint real UUIDs rather than counters.
   */
  readonly newRepoMountId?: () => string;
}

/** Inputs for {@link RepoMountService.attach}. */
export interface AttachRepoMountInput extends RepoAttachRequest {
  /** Envelope actor; defaults to the system actor. */
  readonly actor?: string | null;
  /** Envelope linkage, threaded onto `repo.attached` AND the default workspace's `workspace.ready`. */
  readonly correlationId?: string | null;
}

/** Inputs for {@link RepoMountService.detach}. */
export interface DetachRepoMountInput extends RepoDetachRequest {
  /** Envelope actor; defaults to the system actor. */
  readonly actor?: string | null;
  /** Envelope linkage, threaded onto `repo.detached` AND every cascaded `workspace.archived`. */
  readonly correlationId?: string | null;
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

// All four are `satisfies`-pinned to the contracts unions rather than left as
// inferred literals, matching `./workspace-service.js`'s constants. These
// strings are interpolated straight into SQL literals below, where a typo would
// otherwise produce a statement that silently matches nothing — a detach that
// archives zero rows rather than a compile error. The `satisfies` keeps the
// literal type (so the SQL text stays exact) while making the contracts union
// the authority on the vocabulary.

// The state every attach writes, and the sole legal predecessor of `detached`
// (`Spec-009 §Detach Semantics (V1 Definition)`).
const ATTACHED_MOUNT_STATE = "attached" satisfies RepoMountState;

// The terminal state a successful detach writes. There is no `detached ->
// attached` transition; re-attaching the same canonical root creates a NEW row,
// which the partial index permits precisely because it is scoped to `attached`.
const DETACHED_MOUNT_STATE = "detached" satisfies RepoMountState;

// The workspace state the detach cascade writes, and the one state that is
// already terminal — an `archived` dependent is skipped rather than re-archived,
// so one real transition produces one `workspace.archived` (I-009-9).
const ARCHIVED_WORKSPACE_STATE = "archived" satisfies WorkspaceState;

// The workspace state that REFUSES a detach outright: a run holds this
// workspace, and V1 has no force-detach
// (`Spec-009 §Detach Semantics (V1 Definition)`).
const BUSY_WORKSPACE_STATE = "busy" satisfies WorkspaceState;

// --------------------------------------------------------------------------
// RepoMountService
// --------------------------------------------------------------------------

/**
 * Owns every read and write of the `repo_mounts` table.
 *
 * The workspace half of every operation is delegated to {@link WorkspaceService}
 * where a primitive exists for it. The detach cascade is the one exception: its
 * dependent `SELECT` and archive `UPDATE` against `workspaces` live here,
 * because both MUST execute inside the same transaction as the mount flip, and
 * a `WorkspaceService.archive()` that opened its own append could not
 * participate in one. See {@link detach}.
 *
 * The sibling's class docstring carries the matching scope: it owns every
 * workspace LIFECYCLE transition and every statement against the table except
 * this cascade's, and it names this module as the exception.
 */
export class RepoMountService {
  readonly #events: WorkspaceEventEmitter;
  readonly #workspaces: WorkspaceService;
  readonly #sessions: SessionExistenceReader;
  readonly #resolver: RepoRootResolver;
  readonly #probePath: FilesystemPathProbeFn;
  readonly #now: () => string;
  readonly #newRepoMountId: () => string;

  readonly #insertMountStmt: Statement;
  readonly #selectMountStmt: Statement;
  readonly #selectActiveMountByRootStmt: Statement;
  readonly #selectDependentWorkspacesStmt: Statement;
  readonly #archiveWorkspaceStmt: Statement;
  readonly #detachMountStmt: Statement;

  constructor(deps: RepoMountServiceDeps) {
    if (deps.resolver !== undefined && deps.gitExecutablePath !== undefined) {
      // Loud rather than a precedence rule. See the header's Windows section:
      // the failure mode of quietly preferring one is a daemon that believes it
      // pinned an absolute `git` and did not.
      throw new TypeError(
        "RepoMountService: supply either a ready-made resolver or a gitExecutablePath, not both. " +
          "A gitExecutablePath is only honoured by the resolver this service constructs, so passing " +
          "both would silently drop the pinned executable path.",
      );
    }

    if (
      (deps.platform ?? process.platform) === "win32" &&
      deps.resolver === undefined &&
      deps.gitExecutablePath === undefined
    ) {
      // FAIL CLOSED. Constructing the stock resolver here would spawn bare
      // `git`, and libuv resolves a bare name against the CHILD's working
      // directory first on Windows — so a `git.exe` planted in an
      // operator-supplied repository would run. That is the whole hazard the
      // seam exists for, and defaulting past it silently is worse than not
      // having the seam: the daemon would believe it was pinned.
      throw new TypeError(
        "RepoMountService: on win32 you must supply either an absolute gitExecutablePath or a " +
          "ready-made resolver. Spawning bare `git` there lets a git.exe inside the attached " +
          "repository execute instead of the system one (Plan-009 §Notes, 2026-07-25).",
      );
    }

    this.#events = deps.events;
    this.#workspaces = deps.workspaces;
    this.#sessions = deps.sessions;
    this.#resolver =
      deps.resolver ??
      new RepoRootResolver(
        // Conditional spread rather than `{ gitExecutablePath: deps.… }`: under
        // `exactOptionalPropertyTypes` an explicit `undefined` is not the same
        // as an absent key, and the resolver's own default would be skipped.
        deps.gitExecutablePath === undefined ? {} : { gitExecutablePath: deps.gitExecutablePath },
      );
    this.#probePath = deps.probePath ?? createDefaultPathProbe();
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newRepoMountId = deps.newRepoMountId ?? ((): string => randomUUID());

    const database = deps.database;

    // `state` is a literal rather than a parameter: this is the only INSERT into
    // `repo_mounts`, and a mount is born `attached` or not at all. `metadata`
    // takes the DDL default, as T2.4's workspace INSERT does.
    this.#insertMountStmt = database.prepare(
      `INSERT INTO repo_mounts (
         id, session_id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at, metadata
       ) VALUES (
         @id, @session_id, @node_id, @local_path, @canonical_root, @vcs_type, '${ATTACHED_MOUNT_STATE}', @now, @now, '{}'
       )`,
    );

    // UNSCOPED by state, unlike T2.4's mount lookup. A read must answer for a
    // `detached` mount: `RepoMountReadResponse.state` composes the full 3-value
    // union, and `Spec-009 §Detach Semantics (V1 Definition)` keeps the durable
    // record precisely so a detached mount stays inspectable. Answering
    // `repo.not_found` for a row that exists would make the retained record
    // unreachable, which is the opposite of what the spec asks for.
    this.#selectMountStmt = database.prepare(
      `SELECT id, session_id, node_id, local_path, canonical_root, vcs_type, state, attached_at
         FROM repo_mounts
        WHERE id = @repo_mount_id`,
    );

    // The conflict lookup behind `repo.already_attached`. Its predicate is the
    // `idx_repo_mounts_active_root` key, column for column — if the two ever
    // diverge, the translation silently stops finding the row the index
    // refused, and the refusal degrades to an anonymous internal error.
    this.#selectActiveMountByRootStmt = database.prepare(
      `SELECT id
         FROM repo_mounts
        WHERE session_id = @session_id
          AND node_id = @node_id
          AND canonical_root = @canonical_root
          AND state = '${ATTACHED_MOUNT_STATE}'`,
    );

    // Read INSIDE the detach transaction — see the header's race section. Every
    // dependent regardless of state: the busy check needs `busy` rows, the
    // cascade needs the rest, and already-`archived` rows have to be VISIBLE to
    // be skipped rather than merely absent. `created_at, id` for the same
    // reason T2.4 orders its lists that way: attach writes a mount and its
    // workspace at one instant, so `created_at` alone ties.
    this.#selectDependentWorkspacesStmt = database.prepare(
      `SELECT id, state
         FROM workspaces
        WHERE repo_mount_id = @repo_mount_id
        ORDER BY created_at ASC, id ASC`,
    );

    // The one write this service makes to a table it does not own, and it lives
    // here because the mount flip and the archive must share a transaction (see
    // the class docstring). `state <> 'archived'` makes the skip a PREDICATE
    // rather than a branch: a re-archive matches zero rows even if the
    // caller-side filter is ever wrong, so the "no second `workspace.archived`"
    // guarantee does not rest on the loop above it.
    //
    // `metadata` is untouched. The only key that could be stale on an archived
    // row is `holdingRunId`, and it cannot be present: `markBusy` is its sole
    // writer, `busy` refuses the detach outright, and `busy` is not a legal
    // predecessor of any other state that keeps the hold. Reaching into another
    // module's metadata keys to clear a value that cannot be there would couple
    // the two for nothing.
    this.#archiveWorkspaceStmt = database.prepare(
      `UPDATE workspaces
          SET state = '${ARCHIVED_WORKSPACE_STATE}',
              updated_at = @now
        WHERE id = @workspace_id AND state <> '${ARCHIVED_WORKSPACE_STATE}'`,
    );

    // Compare-and-swap. `attached` in the predicate is both the legal-predecessor
    // rule and the mutual exclusion: two concurrent detaches produce exactly one
    // `changes === 1`.
    this.#detachMountStmt = database.prepare(
      `UPDATE repo_mounts
          SET state = '${DETACHED_MOUNT_STATE}',
              updated_at = @now
        WHERE id = @repo_mount_id AND state = '${ATTACHED_MOUNT_STATE}'`,
    );
  }

  // ------------------------------------------------------------------------
  // Attach
  // ------------------------------------------------------------------------

  /**
   * Attach a local path to a session: resolve its canonical root, persist the
   * mount, and create its default read-only workspace — `repo.attach`.
   *
   * The refusal order and the transaction shape are the header's subject; the
   * short version is that nothing is written until the session is known to exist
   * and the root is known, and then everything is written at once.
   *
   * A non-git directory is NOT a failure: it lands `vcs_type: 'none'` and gets
   * the same default workspace a git mount does (D-009-4's single funnel,
   * I-009-4's honest classification).
   *
   * @throws {SessionNotFoundError} when `sessionId` names no session.
   * @throws {RepoRootResolutionError} when the path resolves to no canonical
   *   root. Nothing is persisted and no event is appended (I-009-2).
   * @throws {RepoAlreadyAttachedError} when the resolved root is already
   *   actively attached to this session on this node (D-009-7).
   */
  async attach(input: AttachRepoMountInput): Promise<RepoAttachResponse> {
    const actor = input.actor ?? null;
    const correlationId = input.correlationId ?? null;

    // Step 1 — session existence, before the subprocess and before the writes.
    if (this.#sessions.replay(input.sessionId) === null) {
      throw new SessionNotFoundError(`session ${input.sessionId} does not exist`, {
        sessionId: input.sessionId,
      });
    }

    // Step 2 — canonicalize. Throws typed `repo.root_resolution_failed` on every
    // non-resolution; there is no fallback to the entered path (I-009-1/2).
    const resolution = await this.#resolver.resolveCanonicalRoot(input.localPath);

    // Step 3 — NO containment check. Attach IS envelope admission; see header.

    const repoMountId = this.#newRepoMountId();
    const attachedAt = this.#now();

    const creation = this.#workspaces.createDefaultWorkspace({
      repoMountId,
      sessionId: input.sessionId,
      canonicalRoot: resolution.canonicalRoot,
      actor,
      correlationId,
    });

    // Step 4 — project the response BEFORE the writes, so an identity the wire
    // shape cannot carry (a non-UUID id from an injected source, a
    // `canonicalRoot` past the wire cap) fails while nothing is durable. Doing
    // it after the commit would leave a mount that exists and cannot be
    // reported — and, because `attach` is how a caller LEARNS the mount id, one
    // it could not even name to detach.
    const response = this.#projectAttachResponse({
      repoMountId,
      canonicalRoot: resolution.canonicalRoot,
      vcsType: resolution.vcsType,
      defaultWorkspaceId: creation.workspaceId,
    });

    // Step 5 — mount row + workspace row + `repo.attached`, atomically.
    await this.#events.emitRepoAttached({
      sessionId: input.sessionId,
      repoMountId,
      actor,
      correlationId,
      transactionalPrelude: (): void => {
        this.#insertMountRow({
          repoMountId,
          sessionId: input.sessionId,
          nodeId: input.nodeId,
          // PROVENANCE: the path the operator typed, verbatim. Never the
          // resolved root, and never the other way round (I-009-5) — the two
          // differ whenever someone attaches from a subdirectory or through a
          // symlink, which is the case that makes both values worth keeping.
          localPath: input.localPath,
          canonicalRoot: resolution.canonicalRoot,
          vcsType: resolution.vcsType,
          attachedAt,
        });
        creation.insertRow();
      },
    });

    // Step 6 — announce the workspace. Deliberately after the commit: T2.4's
    // split puts the ROW in the transaction and the EVENT after it.
    await creation.emitReady();

    return response;
  }

  // ------------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------------

  /**
   * Read one mount with a freshly probed health verdict — `repo.mountRead`.
   *
   * Answers for mounts in EVERY state, not just `attached`. Two reasons, and
   * they point the same way: `Spec-009 §Detach Semantics (V1 Definition)`
   * transitions a detached mount "without deleting the durable record", which is
   * only useful if the record can be read; and `RepoMountReadResponse.state`
   * composes the full 3-value `RepoMountStateSchema` rather than narrowing to
   * `attached`, so the contract already types the answer this method gives. An
   * UNKNOWN id is the only miss, and it is `repo.not_found`.
   *
   * Health is the D-009-2 derived projection and is orthogonal to lifecycle
   * state: a `detached` mount whose root is still on disk reads `healthy`. The
   * projector's own docstring makes that call — folding lifecycle into health
   * "would invent a semantics neither the spec nor the ratified shape carries".
   *
   * The probe targets `canonical_root` VERBATIM, straight off the row. Not a
   * re-resolved, re-normalized, or otherwise "improved" spelling: T2.5's
   * `assertProbeTargets` compares the probed path to the row's path BYTE for
   * byte, and a normalization here would be indistinguishable from a probe of
   * some other path that merely normalizes alike.
   *
   * Takes the BRANDED `RepoMountId` because that is what
   * `RepoMountReadRequest.repoMountId` declares — `attach`/`detach` get theirs
   * from the request interfaces they extend, and this method is the one public
   * entry point that would otherwise widen to bare `string`. The private
   * `#requireMountRow` stays `string`: it is shared with `detach` and is a row
   * lookup, not a wire boundary.
   *
   * @throws {RepoMountNotFoundError} when no row carries this id.
   */
  async read(repoMountId: RepoMountId): Promise<RepoMountReadResponse> {
    const row = this.#requireMountRow(repoMountId);
    const probe = await this.#probePath(row.canonical_root);
    return this.#projectMountRead(row, probe);
  }

  // ------------------------------------------------------------------------
  // Detach
  // ------------------------------------------------------------------------

  /**
   * Detach a mount and archive its dependent workspaces — `repo.detach`.
   *
   * `Spec-009 §Detach Semantics (V1 Definition)`, in order: refuse while any
   * dependent workspace is `busy` (there is no force-detach in V1); otherwise
   * archive every dependent and transition the mount to the terminal `detached`,
   * emitting `repo.detached` plus one `workspace.archived` per workspace the
   * cascade actually moved.
   *
   * Detaching a mount that is ALREADY `detached` (or `archived`) is a no-op
   * success: the current state, an empty `archivedWorkspaceIds`, and no event.
   * Three things force that shape. There is no registered `repo.*` code for
   * "already detached", and minting one is banned; `repo.not_found` would be a
   * lie about a row that exists; and I-009-9 forbids an event for a transition
   * that did not happen. The response contract anticipates it — `state` carries
   * the full union and an empty `archivedWorkspaceIds` is explicitly valid.
   *
   * If a post-commit `workspace.archived` append FAILS, the remaining ones are
   * still attempted and the call then rejects with
   * `detach_notification_incomplete`. What the caller can conclude: the rows are
   * committed — every dependent is `archived` and the mount is `detached` — and
   * the log under-reports it. What the caller CANNOT do is recover the missing
   * events by calling again: a second detach finds the mount already `detached`
   * and takes the no-op path above, returning an empty `archivedWorkspaceIds`
   * without re-announcing anything. Re-announcing would be the worse bug, since
   * nothing here can distinguish "this event failed to append" from "this event
   * appended and I failed to observe it". The rows remain the source of truth,
   * and a projector rebuilding from them sees the correct end state.
   *
   * @throws {RepoMountNotFoundError} when no row carries this id.
   * @throws {RepoDetachConflictError} when a dependent workspace is `busy`.
   *   Nothing is archived, the mount does not move, and no event is appended.
   * @throws {RepoMountServiceInvariantError} (`detach_notification_incomplete`)
   *   when the transaction committed but a dependent announcement did not.
   */
  async detach(input: DetachRepoMountInput): Promise<RepoDetachResponse> {
    const actor = input.actor ?? null;
    const correlationId = input.correlationId ?? null;
    const repoMountId = input.repoMountId;

    const row = this.#requireMountRow(repoMountId);
    if (row.state !== ATTACHED_MOUNT_STATE) {
      return this.#projectDetachResponse(repoMountId, row.state, []);
    }

    const now = this.#now();
    // Filled by the prelude, read after the commit. The prelude cannot RETURN a
    // value — the append seam takes a `() => void` — and it must not, because a
    // returned value would be read even on the abort paths. Assigning into this
    // binding is safe for the opposite reason: every abort path throws, so the
    // only way execution reaches the read below is a committed transaction.
    let archivedWorkspaceIds: readonly string[] = [];

    try {
      await this.#events.emitRepoDetached({
        sessionId: row.session_id,
        repoMountId,
        actor,
        correlationId,
        transactionalPrelude: (): void => {
          archivedWorkspaceIds = this.#runDetachCascade(repoMountId, now);
        },
      });
    } catch (error) {
      if (!(error instanceof MountDetachRaceError)) {
        throw error;
      }
      // A concurrent detach won. Its transaction did the archiving and appended
      // the one `repo.detached` this transition gets; ours rolled back whole.
      // Re-read rather than assuming `detached`: the winner's outcome is the
      // honest answer, and `archivedWorkspaceIds` stays empty because THIS call
      // archived nothing.
      const current = this.#requireMountRow(repoMountId);
      return this.#projectDetachResponse(repoMountId, current.state, []);
    }

    // Post-commit. See the header for why these follow the mount event and what
    // crash window that accepts.
    //
    // EVERY append is attempted even after one fails. Returning early on the
    // first failure would strand every LATER workspace's event too, turning one
    // failed append into an arbitrarily large hole — and the events are
    // independent, so a failure to announce workspace A says nothing about
    // whether B can be announced. Failures are collected and rethrown below;
    // they are never swallowed.
    const failures: unknown[] = [];
    for (const workspaceId of archivedWorkspaceIds) {
      try {
        await this.#events.emitWorkspaceArchived({
          sessionId: row.session_id,
          workspaceId,
          // The archival is a detach cascade's dependent transition, which is
          // exactly when T2.2 asks for the mount id.
          repoMountId,
          actor,
          correlationId,
        });
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      // Cause-chained to the FIRST failure rather than collected into an
      // `AggregateError`: `cause` is the daemon's established chaining idiom
      // (`pty-host-selector.ts`, `session-service.ts`, and this module's other
      // carriers) and the daemon has no `AggregateError` precedent to match.
      //
      // Wrapped rather than rethrown bare, which loses the underlying error's
      // type. That is the deliberate trade: a bare append failure reads as
      // "detach failed, retry it", and the caller would retry a detach that
      // ALREADY COMMITTED. The wrapper's message is what says otherwise.
      throw new RepoMountServiceInvariantError(
        `repo mount "${repoMountId}" detached and archived ${archivedWorkspaceIds.length} ` +
          `workspace(s), but ${failures.length} workspace.archived append(s) failed; the rows are ` +
          `committed and the log under-reports them`,
        {
          kind: "detach_notification_incomplete",
          repoMountId,
          cause: failures[0],
        },
      );
    }

    return this.#projectDetachResponse(repoMountId, DETACHED_MOUNT_STATE, archivedWorkspaceIds);
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  /**
   * The whole detach write set, as one synchronous prelude body.
   *
   * Read → refuse → archive → flip, all inside the caller's transaction. The
   * read must be in here rather than in `detach`; the header explains what a
   * read outside this transaction lets a concurrent bind commit.
   *
   * Returns the ids it actually transitioned, so the caller emits one event per
   * real archival and none for a dependent that was already `archived`.
   */
  #runDetachCascade(repoMountId: string, now: string): readonly string[] {
    const dependents = this.#selectDependentWorkspacesStmt.all({
      repo_mount_id: repoMountId,
    }) as DependentWorkspaceRow[];

    const busyWorkspaceIds = dependents
      .filter((dependent) => dependent.state === BUSY_WORKSPACE_STATE)
      .map((dependent) => dependent.id);
    if (busyWorkspaceIds.length > 0) {
      // Throwing from the prelude aborts before the event INSERT, so the refusal
      // persists nothing at all — not the archives (none have run yet), not the
      // mount flip, not the `repo.detached` row.
      throw new RepoDetachConflictError(busyWorkspaceIds);
    }

    const archivedWorkspaceIds: string[] = [];
    for (const dependent of dependents) {
      if (dependent.state === ARCHIVED_WORKSPACE_STATE) {
        continue;
      }
      const result = this.#archiveWorkspaceStmt.run({ workspace_id: dependent.id, now });
      if (result.changes !== 1) {
        // Unreachable by concurrency: better-sqlite3 is synchronous, so nothing
        // can interleave between the read above and this write. Asserting it
        // anyway makes the atomicity claim testable instead of assumed, and
        // turns a silent under-archival into a loud abort.
        throw new RepoMountServiceInvariantError(
          `detach cascade read workspace "${dependent.id}" as ${dependent.state} but archived ${result.changes} rows`,
          { kind: "detach_cascade_diverged", repoMountId },
        );
      }
      archivedWorkspaceIds.push(dependent.id);
    }

    const flip = this.#detachMountStmt.run({ repo_mount_id: repoMountId, now });
    if (flip.changes !== 1) {
      throw new MountDetachRaceError(repoMountId);
    }

    return archivedWorkspaceIds;
  }

  /**
   * Insert the mount row, translating the active-root uniqueness failure into
   * `repo.already_attached`.
   *
   * Runs inside the attach transaction. A constraint failure leaves the
   * TRANSACTION usable (SQLite's default `ON CONFLICT ABORT` rolls back the
   * statement, not the transaction), which is what lets the lookup below run —
   * and the throw that follows is what rolls back the rest.
   */
  #insertMountRow(fields: {
    readonly repoMountId: string;
    readonly sessionId: string;
    readonly nodeId: string;
    readonly localPath: string;
    readonly canonicalRoot: string;
    readonly vcsType: string;
    readonly attachedAt: string;
  }): void {
    try {
      this.#insertMountStmt.run({
        id: fields.repoMountId,
        session_id: fields.sessionId,
        node_id: fields.nodeId,
        local_path: fields.localPath,
        canonical_root: fields.canonicalRoot,
        vcs_type: fields.vcsType,
        now: fields.attachedAt,
      });
    } catch (error) {
      if (!isConstraintViolation(error)) {
        throw error;
      }
      const conflict = this.#selectActiveMountByRootStmt.get({
        session_id: fields.sessionId,
        node_id: fields.nodeId,
        canonical_root: fields.canonicalRoot,
      }) as { readonly id: string } | undefined;
      if (conflict === undefined) {
        // Some OTHER constraint — a minted-id collision, a CHECK on an
        // out-of-vocabulary `vcs_type`. Rethrowing untranslated is the honest
        // answer: `repo.already_attached` names a specific conflict, and
        // claiming it for a different failure would send the caller to detach a
        // mount that does not exist.
        throw error;
      }
      throw new RepoAlreadyAttachedError(conflict.id);
    }
  }

  /** Fetch a mount row in any state, or refuse with `repo.not_found`. */
  #requireMountRow(repoMountId: string): RepoMountRow {
    const row = this.#selectMountStmt.get({ repo_mount_id: repoMountId }) as
      | RepoMountRow
      | undefined;
    if (row === undefined) {
      throw new RepoMountNotFoundError(repoMountId);
    }
    return row;
  }

  #projectAttachResponse(fields: {
    readonly repoMountId: string;
    readonly canonicalRoot: string;
    readonly vcsType: string;
    readonly defaultWorkspaceId: string;
  }): RepoAttachResponse {
    try {
      return RepoAttachResponseSchema.parse({
        repoMountId: fields.repoMountId,
        state: ATTACHED_MOUNT_STATE,
        vcsType: fields.vcsType,
        canonicalRoot: fields.canonicalRoot,
        defaultWorkspaceId: fields.defaultWorkspaceId,
      });
    } catch (error) {
      throw new RepoMountServiceInvariantError(
        `repo mount "${fields.repoMountId}" cannot be projected onto the attach response`,
        { kind: "repo_mount_row_unprojectable", repoMountId: fields.repoMountId, cause: error },
      );
    }
  }

  #projectMountRead(row: RepoMountRow, probe: FilesystemPathProbe): RepoMountReadResponse {
    try {
      return RepoMountReadResponseSchema.parse({
        // BARE `id` — the read projection's key name, per the contract's note.
        id: row.id,
        sessionId: row.session_id,
        nodeId: row.node_id,
        localPath: row.local_path,
        canonicalRoot: row.canonical_root,
        vcsType: row.vcs_type,
        state: row.state,
        // Throws on a mispaired probe, and that throw is attributed to this row
        // rather than swallowed: a health verdict measured against a different
        // path is a confident wrong answer no downstream surface can detect.
        health: computeRepoMountHealth({ canonicalRoot: row.canonical_root }, probe),
        attachedAt: row.attached_at,
      });
    } catch (error) {
      throw new RepoMountServiceInvariantError(
        `repo mount "${row.id}" cannot be projected onto the mount read response`,
        { kind: "repo_mount_row_unprojectable", repoMountId: row.id, cause: error },
      );
    }
  }

  #projectDetachResponse(
    repoMountId: string,
    state: string,
    archivedWorkspaceIds: readonly string[],
  ): RepoDetachResponse {
    try {
      return RepoDetachResponseSchema.parse({
        repoMountId,
        state,
        archivedWorkspaceIds: [...archivedWorkspaceIds],
      });
    } catch (error) {
      throw new RepoMountServiceInvariantError(
        `repo mount "${repoMountId}" cannot be projected onto the detach response`,
        { kind: "repo_mount_row_unprojectable", repoMountId, cause: error },
      );
    }
  }
}

// --------------------------------------------------------------------------
// Module-private helpers
// --------------------------------------------------------------------------

/**
 * Is this better-sqlite3 failure a constraint violation?
 *
 * Prefix-matched rather than compared to `SQLITE_CONSTRAINT_UNIQUE` exactly.
 * The extended code for a PARTIAL unique index is not something to hard-code
 * from memory, and widening the test costs nothing here: the caller's conflict
 * LOOKUP is the real discrimination, and a constraint failure with no
 * conflicting active mount is rethrown untranslated.
 */
function isConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code: unknown = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

/**
 * The production probe: read the clock, then measure.
 *
 * Clock first so `checkedAt` is never NEWER than the observation it stamps.
 * `probedPath` is the argument, unmodified — the byte-equality subject binding
 * T2.5's projector enforces. A deliberate twin of T2.4's identical helper: both
 * are module-private there and here, and hoisting one into a shared module is a
 * file neither task owns.
 */
function createDefaultPathProbe(): FilesystemPathProbeFn {
  return async (path: string): Promise<FilesystemPathProbe> => {
    const checkedAt = new Date().toISOString();
    let reachable = true;
    try {
      await readDirectory(path);
    } catch {
      reachable = false;
    }
    return { probedPath: path, reachable, checkedAt };
  };
}

// Indirection so the default probe binds the same readability primitive T1.5,
// T1.6 and T2.4 use — one implementation of "can the daemon open this
// directory?".
const readDirectory: DirectoryReadabilityProbe = DEFAULT_DIRECTORY_READABILITY_PROBE;
