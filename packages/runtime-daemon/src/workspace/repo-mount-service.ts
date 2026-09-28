/**
 * Repo-mount lifecycle service — the daemon-side owner of the `repo_mounts`
 * table.
 *
 * A mount belongs to the machine, not to a session: attach stamps the daemon's
 * own node id on the row, writes no workspace and appends no event, and a
 * session reaches the mount by binding a workspace to it.
 *
 * ## Attach refuses in a fixed order, and each position is load-bearing
 *
 * 1. **Canonical-root resolution.** The resolver throws typed
 *    `repo.root_resolution_failed` on every non-resolution, a path that is not
 *    a git repository included. Nothing has been written at this point, so the
 *    "persists nothing" half of that invariant is structural rather than a
 *    promise.
 * 2. **Response projection.** An identity the wire shape cannot carry fails
 *    before the write, while nothing is durable.
 * 3. **Active-root uniqueness.** Enforced by `idx_repo_mounts_active_root` on
 *    the INSERT itself, NOT by a read-then-insert check — see below.
 *
 * ## NO containment check fires at attach
 *
 * This is the one place where a path is accepted without being tested against
 * the trust envelope, and it is deliberate: the envelope IS the set of attached
 * mount roots on this machine, and "envelope admission is the explicit
 * `RepoAttach` action; no path enters the envelope implicitly". Validating an
 * attach against the envelope would make the first attach impossible (an empty
 * envelope contains nothing) and every later one a subdirectory-only
 * operation. Containment is the job at BIND time, against the roots this method
 * admitted.
 *
 * ## Duplicate detection is the index, not a pre-read
 *
 * A `SELECT`-then-`INSERT` uniqueness check would be a TOCTOU window: two
 * attaches of the same root interleaving at the resolver's `await` would both
 * read "free" and both insert, and the second would fail the index anyway —
 * with the failure surfacing as an anonymous internal error rather than
 * `repo.already_attached`. So the INSERT runs unguarded and its constraint
 * failure is translated by looking up the row that actually holds the root.
 * That lookup is also the discrimination: a constraint failure with no
 * conflicting active mount is some OTHER constraint (a minted-id collision,
 * say) and is rethrown untranslated. The INSERT is a single statement, so a
 * refused attach writes nothing.
 *
 * ## Detach reads its dependents inside the transaction that flips the mount
 *
 * The bind INSERT is conditional on `state = 'attached'`, which closes the
 * bind-vs-detach race from the BIND side: a bind that passes over an
 * about-to-detach mount writes zero rows and aborts. This module closes it from
 * the detach side, and the two halves only compose if the dependent-set read,
 * the archive writes, and the mount flip all happen in ONE transaction. Reading
 * the dependents outside it would let a bind commit a workspace between the
 * read and the flip: the bind's own guard would pass (the mount is still
 * `attached`), and the cascade would then archive a set computed before that
 * workspace existed, leaving a live execution root on a detached mount. The
 * transaction is `IMMEDIATE`, so it holds the write lock from its first read.
 *
 * The mount flip is a compare-and-swap on `state = 'attached'`. Zero rows
 * changed means a concurrent detach won; the transaction rolls back and the
 * loser returns the winner's outcome.
 *
 * ## Detach announces after the commit, and the window that accepts
 *
 * Each `workspace.archived` goes to its workspace's own session log AFTER the
 * cascade commits, one per workspace the cascade actually transitioned.
 * Appending them first would put events on the log before their rows moved, so
 * a crash mid-sequence would leave `workspace.archived` for workspaces still
 * live. Events describing transitions that never happened are a strictly worse
 * breach than events missing for transitions that did.
 *
 * The accepted window is therefore: all rows durable, some `workspace.archived`
 * events missing. A CRASH mid-loop is silent. A THROWING append is not: the
 * loop attempts every remaining announcement anyway — one bad append must not
 * strand the events after it, and independent appends carry no information
 * about each other — and the call then rejects with
 * `detach_notification_incomplete`.
 *
 * Neither is repairable by calling `detach` again. The mount is already
 * `detached`, so a second call takes the no-op path and announces nothing; and
 * re-announcing would require distinguishing "this append failed" from "this
 * append landed and I failed to observe it", which nothing here can do. The
 * `archived` rows are the truth, and a projector rebuilding from them reaches
 * the correct end state regardless of which announcements landed.
 *
 * Append receipts are never read here, so no event's id is available to name
 * as a cause. The caller's `correlationId` is threaded through every event of
 * the cascade instead, which is what makes them collatable.
 *
 * ## The Windows `git` seam
 *
 * libuv searches a bare executable name in the SPAWNING process's current
 * directory before `PATH` on Windows — so spawning bare `git` can execute a
 * `git.exe` sitting in the daemon's own working directory (the resolver passes
 * no `cwd`; its header carries the libuv `search_path` authority). The resolver
 * takes an injectable `gitExecutablePath` for exactly this, and this service
 * exposes it through {@link RepoMountServiceDeps.gitExecutablePath} so the
 * daemon-config surface can supply an ABSOLUTE path on `win32` without this
 * module having to know where the daemon keeps its configuration. Supplying
 * both a ready-made `resolver` and a `gitExecutablePath` is a construction-time
 * error rather than a silent precedence rule: silently ignoring an absolute git
 * path is the exact hazard the seam exists to prevent.
 */

import type { Database, Statement, Transaction } from "better-sqlite3";

import {
  RepoAttachResponseSchema,
  RepoDetachResponseSchema,
  RepoMountReadResponseSchema,
  type NodeId,
  type RepoAttachRequest,
  type RepoAttachResponse,
  type RepoDetachRequest,
  type RepoDetachResponse,
  type RepoMountId,
  type RepoMountReadResponse,
  type RepoMountState,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

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
import type { FilesystemPathProbeFn } from "./workspace-service.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";

// --------------------------------------------------------------------------
// Error carriers
// --------------------------------------------------------------------------

/**
 * The daemon-internal failure classes this module can raise.
 *
 * One error class with a discriminant rather than several classes, mirroring
 * `WorkspaceServiceInvariantError`: all are the same wire outcome (an anonymous
 * internal error) and differ only in what an operator should go inspect.
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
 * Module-private abort signal for the compare-and-swap mount flip inside
 * {@link RepoMountService.detach}'s transaction.
 *
 * The archives have already run inside that transaction by the time the flip
 * matches no row, and only a throw rolls them back. `detach` catches it and
 * reports the winner's state; it never escapes this module.
 */
class MountDetachRaceError extends Error {
  constructor(repoMountId: string) {
    super(
      `RepoMountService.detach: repo mount ${repoMountId} left the attached state between the ` +
        `read and the detach transaction; rolling back the archives this transaction wrote.`,
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
  readonly session_id: string;
  readonly state: string;
}

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface RepoMountServiceDeps {
  /**
   * Open daemon database. Statements are prepared once, in the constructor.
   * Every write here commits in its own statement or transaction, so this
   * handle need not be the one the event log appends through.
   */
  readonly database: Database;
  /** The seam through which the detach cascade's `workspace.archived` events are appended. */
  readonly events: WorkspaceEventEmitter;
  /** The daemon's own node id, stamped on every mount it attaches. */
  readonly nodeId: NodeId;
  /**
   * Defaults to a stock `RepoRootResolver`. Mutually exclusive with {@link
   * gitExecutablePath} — see the header.
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
   * platform is exercised only on a Windows runner, so the branch that matters
   * most on Windows would ship untested.
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
  /**
   * ISO-8601 wall clock for `attached_at` / `updated_at`. Defaults to
   * `new Date().toISOString()`.
   */
  readonly now?: () => string;
  /**
   * Mount-id source. Defaults to the daemon-wide `mintUuidV7`
   * (`ids/uuid-v7.ts`). Injected ids still pass through `RepoMountIdSchema` on
   * the attach response, so a test source must mint real UUIDs rather than
   * counters.
   */
  readonly newRepoMountId?: () => string;
}

/** Inputs for {@link RepoMountService.detach}. */
export interface DetachRepoMountInput extends RepoDetachRequest {
  /** Envelope actor; defaults to the system actor. */
  readonly actor?: string | null;
  /** Envelope linkage, threaded onto every cascaded `workspace.archived`. */
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

// The state every attach writes, and the sole legal predecessor of
// `detached`.
const ATTACHED_MOUNT_STATE = "attached" satisfies RepoMountState;

// The terminal state a successful detach writes. There is no `detached ->
// attached` transition; re-attaching the same canonical root creates a NEW row,
// which the partial index permits precisely because it is scoped to `attached`.
const DETACHED_MOUNT_STATE = "detached" satisfies RepoMountState;

// The workspace state the detach cascade writes, and the one state that is
// already terminal — an `archived` dependent is skipped rather than re-archived,
// so one real transition produces one `workspace.archived`.
const ARCHIVED_WORKSPACE_STATE = "archived" satisfies WorkspaceState;

// The workspace state that REFUSES a detach outright: a run holds this
// workspace, and V1 has no force-detach.
const BUSY_WORKSPACE_STATE = "busy" satisfies WorkspaceState;

// --------------------------------------------------------------------------
// RepoMountService
// --------------------------------------------------------------------------

/**
 * Owns every read and write of the `repo_mounts` table.
 *
 * The detach cascade also reads and archives the mount's `workspaces` rows here,
 * because both MUST execute inside the same transaction as the mount flip, and a
 * `WorkspaceService.archive()` that opened its own append could not participate
 * in one. `WorkspaceService` names this cascade as the one exception to its
 * ownership of that table. See {@link detach}.
 */
export class RepoMountService {
  readonly #events: WorkspaceEventEmitter;
  readonly #nodeId: NodeId;
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
  readonly #detachCascade: Transaction<
    (repoMountId: string, now: string) => readonly DependentWorkspaceRow[]
  >;

  constructor(deps: RepoMountServiceDeps) {
    if (deps.resolver !== undefined && deps.gitExecutablePath !== undefined) {
      // Loud rather than a precedence rule. See the header's Windows section:
      // the failure mode of quietly preferring one is a daemon that believes it
      // pinned an absolute `git` and did not.
      throw new TypeError(
        "RepoMountService: supply either a ready-made resolver or a gitExecutablePath, not both. " +
          "A gitExecutablePath is only honored by the resolver this service constructs, so " +
          "passing both would silently drop the pinned executable path.",
      );
    }

    if (
      (deps.platform ?? process.platform) === "win32" &&
      deps.resolver === undefined &&
      deps.gitExecutablePath === undefined
    ) {
      // FAIL CLOSED. Constructing the stock resolver here would spawn bare
      // `git`, and libuv searches a bare name in the spawning process's
      // current directory before `PATH` on Windows — so a `git.exe` planted
      // in the daemon's own working directory would run. That is the whole
      // hazard the seam exists for, and defaulting past it silently is worse
      // than not having the seam: the daemon would believe it was pinned.
      throw new TypeError(
        "RepoMountService: on win32 you must supply either an absolute gitExecutablePath or a " +
          "ready-made resolver. Spawning bare `git` there lets a git.exe in the daemon's own " +
          "working directory execute instead of the system one.",
      );
    }

    this.#events = deps.events;
    this.#nodeId = deps.nodeId;
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
    this.#newRepoMountId = deps.newRepoMountId ?? mintUuidV7;

    const database = deps.database;

    // `state` is a literal rather than a parameter: this is the only INSERT into
    // `repo_mounts`, and a mount is born `attached` or not at all. `metadata`
    // takes the DDL default, as the workspace INSERT does.
    this.#insertMountStmt = database.prepare(
      `INSERT INTO repo_mounts (
         id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at,
         metadata
       ) VALUES (
         @id, @node_id, @local_path, @canonical_root, @vcs_type, '${ATTACHED_MOUNT_STATE}', @now,
         @now, '{}'
       )`,
    );

    // UNSCOPED by state, unlike the mount lookup. A read must answer for a
    // `detached` mount: `RepoMountReadResponse.state` composes the full 3-value
    // union, and keeps the durable record precisely so a detached mount stays
    // inspectable.
    this.#selectMountStmt = database.prepare(
      `SELECT id, node_id, local_path, canonical_root, vcs_type, state, attached_at
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
        WHERE node_id = @node_id
          AND canonical_root = @canonical_root
          AND state = '${ATTACHED_MOUNT_STATE}'`,
    );

    // Read INSIDE the detach transaction — see the header's race section. Every
    // dependent regardless of state: the busy check needs `busy` rows, the
    // cascade needs the rest, and already-`archived` rows have to be VISIBLE to
    // be skipped rather than merely absent. `id` breaks ties between workspaces
    // created in the same clock tick, so the order is stable.
    this.#selectDependentWorkspacesStmt = database.prepare(
      `SELECT id, session_id, state
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

    this.#detachCascade = database.transaction(
      (repoMountId: string, now: string): readonly DependentWorkspaceRow[] =>
        this.#runDetachCascade(repoMountId, now),
    );
  }

  // ------------------------------------------------------------------------
  // Attach
  // ------------------------------------------------------------------------

  /**
   * Attach a local path to this machine: resolve its canonical root and persist
   * the mount — `repo.attach`. No workspace is created and no event appended.
   *
   * @throws {RepoRootResolutionError} when the path resolves to no canonical
   *   root, including a path that is not a git repository. Nothing is
   *   persisted.
   * @throws {RepoAlreadyAttachedError} when the resolved root is already
   *   actively attached on this node.
   */
  async attach(input: RepoAttachRequest): Promise<RepoAttachResponse> {
    // Throws typed `repo.root_resolution_failed` on every non-resolution; there
    // is no fallback to the entered path.
    const resolution = await this.#resolver.resolveCanonicalRoot(input.localPath);

    // NO containment check. Attach IS envelope admission; see header.

    const repoMountId = this.#newRepoMountId();
    const attachedAt = this.#now();

    // Project the response BEFORE the write, so an identity the wire shape
    // cannot carry (a non-UUID id from an injected source, a `canonicalRoot`
    // past the wire cap) fails while nothing is durable. Doing it after the
    // commit would leave a mount that exists and cannot be reported — and,
    // because `attach` is how a caller LEARNS the mount id, one it could not even
    // name to detach.
    const response = this.#projectAttachResponse({
      repoMountId,
      canonicalRoot: resolution.canonicalRoot,
      vcsType: resolution.vcsType,
    });

    this.#insertMountRow({
      repoMountId,
      // PROVENANCE: the path the operator typed, verbatim. Never the resolved
      // root, and never the other way round — the two differ whenever someone
      // attaches from a subdirectory or through a symlink, which is the case
      // that makes both values worth keeping.
      localPath: input.localPath,
      canonicalRoot: resolution.canonicalRoot,
      vcsType: resolution.vcsType,
      attachedAt,
    });

    return response;
  }

  // ------------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------------

  /**
   * Read one mount with a freshly probed health verdict — `repo.mountRead`.
   *
   * Answers for mounts in EVERY state, not just `attached`. An UNKNOWN id is the
   * only miss, and it is `repo.not_found`.
   *
   * The projector's own docstring makes that call — folding lifecycle into
   * health "would invent a semantics neither the spec nor the ratified shape
   * carries".
   *
   * The probe targets `canonical_root` VERBATIM, straight off the row. Not a
   * re-resolved, re-normalized, or otherwise "improved" spelling: the
   * `assertProbeTargets` compares the probed path to the row's path BYTE for
   * byte, and a normalization here would be indistinguishable from a probe of
   * some other path that merely normalizes alike.
   *
   * Takes the BRANDED `RepoMountId` because that is what
   * `RepoMountReadRequest.repoMountId` declares — `detach` gets its id from the
   * request interface it extends, and this method is the one public entry point
   * that would otherwise widen to bare `string`. The private `#requireMountRow`
   * stays `string`: it is shared with `detach` and is a row lookup, not a wire
   * boundary.
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
   * In order: refuse while any dependent workspace is `busy` (there is no
   * force-detach in V1); otherwise archive every dependent and transition the
   * mount to the terminal `detached` in one transaction, then append one
   * `workspace.archived` to each archived workspace's own session.
   *
   * Detaching a mount that is ALREADY `detached` (or `archived`) is a no-op
   * success: the current state, an empty `archivedWorkspaceIds`, and no event.
   * The response contract anticipates it — `state` carries the full union and an
   * empty `archivedWorkspaceIds` is explicitly valid.
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
    let archivedWorkspaces: readonly DependentWorkspaceRow[];
    try {
      archivedWorkspaces = this.#detachCascade.immediate(repoMountId, now);
    } catch (error) {
      if (!(error instanceof MountDetachRaceError)) {
        throw error;
      }
      // A concurrent detach won, and ours rolled back whole. Re-read rather
      // than assuming `detached`: the winner's outcome is the honest answer,
      // and `archivedWorkspaceIds` stays empty because THIS call archived
      // nothing.
      const current = this.#requireMountRow(repoMountId);
      return this.#projectDetachResponse(repoMountId, current.state, []);
    }

    // Post-commit. See the header for why these follow the commit and what
    // crash window that accepts.
    //
    // EVERY append is attempted even after one fails. Returning early on the
    // first failure would strand every LATER workspace's event too, turning one
    // failed append into an arbitrarily large hole — and the events are
    // independent, so a failure to announce workspace A says nothing about
    // whether B can be announced. Failures are collected and rethrown below;
    // they are never swallowed.
    const failures: unknown[] = [];
    for (const workspace of archivedWorkspaces) {
      try {
        await this.#events.emitWorkspaceArchived({
          sessionId: workspace.session_id,
          workspaceId: workspace.id,
          // Names the mount whose detach caused the archival.
          repoMountId,
          actor,
          correlationId,
        });
      } catch (error) {
        failures.push(error);
      }
    }

    const archivedWorkspaceIds = archivedWorkspaces.map((workspace) => workspace.id);
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
          `workspace(s), but ${failures.length} workspace.archived append(s) failed; the rows ` +
          `are committed and the log under-reports them`,
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
   * The whole detach write set, run as the body of the detach transaction.
   *
   * Read → refuse → archive → flip. The read must be in here rather than in
   * `detach`; the header explains what a read outside this transaction lets a
   * concurrent bind commit.
   *
   * Returns the dependents it actually transitioned, so the caller emits one
   * event per real archival, to that workspace's own session, and none for a
   * dependent that was already `archived`.
   */
  #runDetachCascade(repoMountId: string, now: string): readonly DependentWorkspaceRow[] {
    const dependents = this.#selectDependentWorkspacesStmt.all({
      repo_mount_id: repoMountId,
    }) as DependentWorkspaceRow[];

    const busyWorkspaceIds = dependents
      .filter((dependent) => dependent.state === BUSY_WORKSPACE_STATE)
      .map((dependent) => dependent.id);
    if (busyWorkspaceIds.length > 0) {
      // Thrown before any write, so the refusal persists nothing at all — not
      // the archives, not the mount flip.
      throw new RepoDetachConflictError(busyWorkspaceIds);
    }

    const archivedWorkspaces: DependentWorkspaceRow[] = [];
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
          `detach cascade read workspace "${dependent.id}" as ${dependent.state} but archived ` +
            `${result.changes} rows`,
          { kind: "detach_cascade_diverged", repoMountId },
        );
      }
      archivedWorkspaces.push(dependent);
    }

    const flip = this.#detachMountStmt.run({ repo_mount_id: repoMountId, now });
    if (flip.changes !== 1) {
      throw new MountDetachRaceError(repoMountId);
    }

    return archivedWorkspaces;
  }

  /**
   * Insert the mount row, translating the active-root uniqueness failure into
   * `repo.already_attached`.
   *
   * SQLite's default `ON CONFLICT ABORT` undoes only the failed statement, so
   * the conflict lookup below reads the database exactly as it stood before the
   * INSERT.
   */
  #insertMountRow(fields: {
    readonly repoMountId: string;
    readonly localPath: string;
    readonly canonicalRoot: string;
    readonly vcsType: string;
    readonly attachedAt: string;
  }): void {
    try {
      this.#insertMountStmt.run({
        id: fields.repoMountId,
        node_id: this.#nodeId,
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
        node_id: this.#nodeId,
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
  }): RepoAttachResponse {
    try {
      return RepoAttachResponseSchema.parse({
        repoMountId: fields.repoMountId,
        state: ATTACHED_MOUNT_STATE,
        vcsType: fields.vcsType,
        canonicalRoot: fields.canonicalRoot,
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
 * the projector enforces. A deliberate twin of the identical helper: both are
 * module-private there and here, and hoisting one into a shared module is a
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

// Indirection so the default probe binds the same readability primitive use —
// one implementation of "can the daemon open this directory?".
const readDirectory: DirectoryReadabilityProbe = DEFAULT_DIRECTORY_READABILITY_PROBE;
