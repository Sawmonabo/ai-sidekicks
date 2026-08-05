/**
 * Workspace lifecycle service — the daemon-side owner of the `workspaces`
 * table (Plan-009 Phase 2, T2.4).
 *
 * Spec coverage: `Spec-009 §Default Behavior` (a mount's default workspace is
 * read-only and rooted at the mount's canonical root),
 * `Spec-009 §Execution Mode Transitions` (the reprovision cycle and its
 * recorded failure detail), `Spec-009 §Required Behavior` (workspace binding is
 * explicit and resolves ONE concrete execution root before a run begins),
 * `Spec-009 §Local Trust Envelope (V1 Definition)` (traversal and out-of-
 * envelope binding are refused),
 * `Spec-009 §Repo Mount Health (V1 Definition)` (the on-read probe floor).
 *
 * Verifies invariant: I-009-3 (no execution root outside the trust envelope),
 * I-009-6 (a workspace id survives a mode switch), I-009-7 (a workspace whose
 * root vanished is observably `stale` and refuses writes), I-009-8 (no silent
 * mode substitution), I-009-9 (one lifecycle event per real transition,
 * committed with the row that caused it).
 *
 * Cross-plan obligations discharged here: CP-009-2 (the reprovision primitives
 * Plan-010 drives), CP-009-3 (`assertWritable`, the write gate), CP-009-7
 * (`markBusy` / `releaseBusy`, the run hold), CP-009-8 (`fs_root` is the root
 * Plan-012 scopes approvals against).
 *
 * ## Bind evaluates its refusals in a fixed order, and the order is the contract
 *
 * Two orderings are load-bearing and are pinned by tests rather than left to
 * reading order (`docs/plans/009-repo-attachment-and-workspace-binding.md`
 * §Notes, 2026-07-25, and the header of `./trust-envelope.js`):
 *
 * 1. **Reachability before containment.** The mount's canonical root is probed
 *    through T2.5's health projection BEFORE `validateExecutionRoot` runs. The
 *    validator `realpath`s its candidate, and `realpath` on a vanished root
 *    fails — so with the orders swapped, an unmounted volume or a deleted
 *    checkout reports `repo.outside_trust_envelope` (403, "you tried to escape
 *    the sandbox") for what is really `workspace.stale` (409, "the root is
 *    gone"). The 403 is both wrong and alarming: it accuses the caller of an
 *    escape attempt. Probing first lets the honest answer win, and it is the
 *    same on-read floor D-009-5 mandates for every health-reporting surface.
 * 2. **Mount identity before envelope construction.** The mount lookup is
 *    scoped to `state = 'attached'` and a miss refuses immediately with
 *    `repo.not_found`. The envelope-roots query is likewise scoped to
 *    `state = 'attached'`. A detached or unknown mount id must not fall
 *    through to envelope evaluation, where an empty root set makes every
 *    candidate "outside the envelope" and turns a stale bookmark into a 403.
 *
 * ## `list` propagates per-row failures; it never drops a row
 *
 * `list` folds every row through T2.5's `computeWorkspaceHealth`, and that fold
 * has four distinct throw sources. Naming them all, because the choice below
 * is only defensible against the whole set:
 *
 * 1. **Out-of-vocabulary `workspaces.state`** — the projector's positive
 *    membership check refuses a state in neither roster (a corrupt row; the
 *    column's CHECK constraint makes this reachable only through corruption or
 *    a schema change).
 * 2. **NULL `fs_root` under a probe-bearing state** — the projector's
 *    precondition throw. A `ready` or `busy` row with no execution root is a
 *    shape this service never writes.
 * 3. **Subject-binding mispairing** — the projector's `assertProbeTargets`
 *    guard, when the probe handed to it did not measure the row's own
 *    `fs_root`. In a correctly wired service this is a PROGRAMMING error in
 *    this module's probe pairing, not a data problem.
 * 4. **Unrepresentable identifiers** — `WorkspaceIdSchema` / `RepoMountIdSchema`
 *    / `ExecutionModeSchema` refusing a corrupt column value while the row is
 *    projected onto the wire shape. Same class as 1 and 2: a row the model
 *    does not produce.
 *
 * All four PROPAGATE, each wrapped in a {@link WorkspaceServiceInvariantError}
 * that names the offending workspace id and carries the original as `cause`.
 * The wrapper is the whole design: uncontained, any of the four surfaces as an
 * anonymous JSON-RPC `-32603` for the entire `repo.workspaceList` response with
 * no clue which row caused it; wrapped, the failure is still loud and still
 * whole-response, but the daemon log names the row to repair.
 *
 * Per-row containment was rejected, not overlooked. It has exactly two
 * implementations and both are worse: DROP the row, which silently shortens a
 * roster the operator is using to decide what to detach — the render-side
 * mirror of I-009-13's never-mask posture — or FABRICATE a substitute state,
 * which is unrepresentable for source 1 (no `WorkspaceState` fits) and an
 * outright lie for source 2 (reporting `ready` for a row with no root is the
 * exact claim the probe floor exists to prevent). Source 3 additionally wants
 * the loud throw: it is this module's own bug, and swallowing it converts a
 * systematic mispairing into a plausible wrong answer on every row.
 *
 * A fifth failure — the on-read floor's `markStale` write or its
 * `workspace.stale` append failing — also propagates, but under its OWN
 * discriminant (`stale_transition_durability_failure`). It is a durability
 * failure rather than a projection failure, and the distinction is operational,
 * not cosmetic: labelling a `SQLITE_BUSY` on the event append
 * `workspace_row_unprojectable` sends an operator to inspect a row that is
 * perfectly healthy. It must not be swallowed either — the list would otherwise
 * report `stale` for a row the database still calls `ready`, and I-009-7's
 * observability claim rests on the persisted row, not on one response. It
 * travels attributed to the same row, since it is raised from inside that row's
 * observation.
 *
 * `list` therefore writes rows and appends events while T3.2 registers
 * `repo.workspaceList` as a non-mutating query. The two are ratified
 * SEPARATELY — the on-read stale persistence by D-009-5's probe floor, the
 * `mutating: false` registration by the plan's Phase-3 T3.2 Note — and they do
 * not conflict: `mutating` classifies the CLIENT's request, and a daemon-derived
 * on-read stale transition is a side effect of observing the filesystem, not a
 * state change the caller asked for.
 *
 * ## `busy -> stale` is legal and IS persisted
 *
 * `Spec-009 §Repo Mount Health (V1 Definition)` states the stale transition
 * unconditionally on the current state, and T2.5 deliberately left the legality
 * call here. Refusing it while a run holds the workspace would make I-009-7
 * false for exactly the rows that are doing damage — a live run writing into a
 * root that no longer exists is the case the invariant is FOR. So a `busy` row
 * whose root vanished becomes `stale` and emits `workspace.stale` like any
 * other.
 *
 * The corollary is in {@link WorkspaceService.releaseBusy}: it clears the hold
 * only if the row is still `busy`. A workspace that went stale mid-run stays
 * stale — releasing must never auto-heal, mirroring `computeWorkspaceHealth`'s
 * refusal to promote `stale` back to `ready` on a successful probe. A release
 * against a non-`busy` row is a benign no-op rather than an error, because the
 * call site is a `finally` block: throwing there would mask the run's real
 * failure with a bookkeeping complaint.
 *
 * ## `fs_root` is an approval-scope boundary, not a convenience field
 *
 * CP-009-8 makes `fs_root` the root Plan-012 scopes tool approvals against, so
 * a non-canonical value written here silently widens an approval envelope.
 * There are exactly three write sites and each is guarded:
 * {@link WorkspaceService.createDefaultWorkspace} and
 * {@link WorkspaceService.bind} write a path T1.5's resolver or T1.6's
 * validator already canonicalised, and
 * {@link WorkspaceService.completeReprovision} — whose value comes from
 * Plan-010's provisioner and which the trust-envelope header explicitly
 * forbids re-validating — at minimum refuses a non-absolute path, since a
 * relative one would be completed against the daemon's working directory at
 * spawn time.
 *
 * ## Transactionality
 *
 * Every transition writes its row inside the emitter's `transactionalPrelude`,
 * so the row and its event commit together or not at all (I-009-9). The writes
 * are compare-and-swap `UPDATE`s (`WHERE id = ? AND state IN (...)`) whose
 * `changes` count is asserted inside the prelude: a row that moved between the
 * read and the write aborts the transaction rather than producing a state/event
 * pair that disagree. Deciding-inside-a-prelude is precedented by
 * `../node/node-capability-service.js`, which re-checks and throws in its own
 * prelude for the same reason; the prelude's "writes only" rule bars I/O and
 * async work, not a guard that aborts the write it wraps.
 *
 * ## Error carriers live in this module
 *
 * The four `workspace.*` domain errors below are modelled on T1.4's
 * `./repo-errors.js` and belong beside it. They are here because T2.4's target
 * paths do not include that file; the hoist into a shared `workspace-errors.ts`
 * is a mechanical move that rides the first Phase-3 task to consume these
 * carriers, per the record in
 * `docs/plans/009-repo-attachment-and-workspace-binding.md` §Notes. Every code
 * is quoted from `docs/architecture/contracts/error-contracts.md` §Workspace —
 * this module mints none.
 */

import { randomUUID } from "node:crypto";

import type { Database, Statement } from "better-sqlite3";

import {
  ExecutionModeSchema,
  JsonRpcErrorCode,
  RepoMountIdSchema,
  WorkspaceIdSchema,
  WORKSPACE_LAST_ERROR_MAX_LEN,
  type ExecutionMode,
  type VcsType,
  type WorkspaceBindRequest,
  type WorkspaceBindResponse,
  type WorkspaceListRequest,
  type WorkspaceListResponse,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

import { DaemonDomainError } from "../ipc/domain-error.js";

import { RepoMountNotFoundError } from "./repo-errors.js";
import {
  DEFAULT_DIRECTORY_READABILITY_PROBE,
  TrustEnvelopeValidator,
  type DirectoryReadabilityProbe,
} from "./trust-envelope.js";
import type { WorkspaceEventEmitter } from "./workspace-event-emitter.js";
import {
  computeExecutionModeCapabilities,
  computeRepoMountHealth,
  computeWorkspaceHealth,
  PROBE_BEARING_WORKSPACE_STATES,
  type FilesystemPathProbe,
  type WorkspaceHealthProjection,
} from "./workspace-projector.js";

// --------------------------------------------------------------------------
// Error codes and carriers
// --------------------------------------------------------------------------

/**
 * The workspace-scoped codes this module may raise, quoted from
 * `docs/architecture/contracts/error-contracts.md` §Workspace.
 *
 * A SUBSET of that section, deliberately: `workspace.provisioning_failed`,
 * `workspace.branch_mismatch`, `workspace.execution_root_unresolved` and
 * `workspace.branch_name_required` are Plan-010's provisioner surfaces, and
 * listing codes this module cannot raise would make the union useless as a
 * census of what a caller of THIS service must handle.
 */
export type WorkspaceServiceErrorCode =
  | "workspace.not_found"
  | "workspace.mode_unsupported"
  | "workspace.stale"
  | "workspace.busy";

/** Registered `workspace.*` codes raised by this service, in registry order. */
export const WORKSPACE_SERVICE_ERROR_CODES: readonly WorkspaceServiceErrorCode[] = [
  "workspace.not_found",
  "workspace.mode_unsupported",
  "workspace.stale",
  "workspace.busy",
];

/**
 * `workspace.not_found` — the named workspace does not exist
 * (`error-contracts.md §Workspace`, notional HTTP 404).
 *
 * The only carrier here that sets `jsonRpcCode`, for exactly the reason
 * `./repo-errors.js` sets it on exactly one of its five: `DaemonDomainError`
 * fixes the rule that "a not-found namespace error rides `-32602`, like
 * `session.not_found`", and BL-143 landed `repo.not_found` at `-32602` as the
 * worked example on both sides of the wire. The three below stay UNSET, taking
 * the mapper's documented `-32603` default with the dotted identifier in
 * `data.type` — no numeric is ratified for their rows, and selecting one here
 * would be this module inventing wire behaviour Phase 3 then has to honour.
 *
 * `this.name` is not assigned: the base sets it from `new.target.name`.
 */
export class WorkspaceNotFoundError extends DaemonDomainError {
  /** The workspace id that did not resolve. Projects to `data.fields.workspaceId`. */
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} does not exist`, {
      code: "workspace.not_found" satisfies WorkspaceServiceErrorCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 404,
      detail: { workspaceId },
    });
    this.workspaceId = workspaceId;
  }
}

/**
 * `workspace.mode_unsupported` — the requested execution mode is not available
 * on this mount (`error-contracts.md §Workspace`, notional HTTP 400).
 *
 * Carries the capability matrix's OWN reason string rather than a locally
 * composed sentence. I-009-8 forbids silently substituting a mode, and a
 * refusal that cannot say why invites the caller to guess and retry blind —
 * `availableModes` plus `reason` is the pairing D-009-5 already ratified for
 * the capabilities read, reused verbatim so the refusal and the read agree.
 *
 * The reason strings originate in T2.5's static matrix, which is why nothing
 * here re-bounds them against `EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN`:
 * they are the same daemon-authored constants that already satisfy it.
 *
 * Both the own field and the wire `detail` hold COPIES of `availableModes`,
 * matching `RepoDetachConflictError`'s discipline: a caller that keeps mutating
 * the array it passed cannot retroactively rewrite an error already thrown.
 */
export class WorkspaceModeUnsupportedError extends DaemonDomainError {
  /** The refused mode. Projects to `data.fields.executionMode`. */
  readonly executionMode: ExecutionMode;
  /** The modes that ARE available on the mount. Projects to `data.fields.availableModes`. */
  readonly availableModes: readonly ExecutionMode[];

  constructor(
    executionMode: ExecutionMode,
    availableModes: readonly ExecutionMode[],
    reason: string,
  ) {
    super(`execution mode ${executionMode} is unavailable on this repo mount: ${reason}`, {
      code: "workspace.mode_unsupported" satisfies WorkspaceServiceErrorCode,
      httpStatus: 400,
      detail: { executionMode, availableModes: [...availableModes], reason },
    });
    this.executionMode = executionMode;
    this.availableModes = [...availableModes];
  }
}

/**
 * `workspace.stale` — the execution root is gone, so writes are refused
 * (`error-contracts.md §Workspace`, notional HTTP 409). Carrier leg of I-009-7.
 *
 * Also the refusal {@link WorkspaceService.bind} raises when the MOUNT's
 * canonical root fails its pre-containment probe: the workspace being bound
 * would be stale the instant it existed, and this is the honest name for that.
 * That call has no workspace id yet, hence the nullable subject — `detail` is
 * left empty rather than carrying a placeholder, because a field naming no real
 * row is worse than an absent one.
 *
 * No path is echoed, by construction: there is no channel for one. The
 * `error-contracts.md §Repo` no-path ban names two `repo.*` codes rather than
 * this one, but a stale-root message is exactly the place a path would
 * otherwise get written, and T1.6's validator holds the same line.
 */
export class WorkspaceStaleError extends DaemonDomainError {
  /** The stale workspace, or `null` when the subject is a not-yet-created bind. */
  readonly workspaceId: string | null;

  constructor(workspaceId: string | null) {
    super(
      workspaceId === null
        ? "workspace binding refused: the repo mount's execution root is no longer reachable"
        : `workspace ${workspaceId} is stale: its execution root is no longer reachable`,
      {
        code: "workspace.stale" satisfies WorkspaceServiceErrorCode,
        httpStatus: 409,
        detail: workspaceId === null ? {} : { workspaceId },
      },
    );
    this.workspaceId = workspaceId;
  }
}

/**
 * `workspace.busy` — the workspace is already held by a run
 * (`error-contracts.md §Workspace`, notional HTTP 409; CP-009-7's one-holding-
 * run-at-a-time rule for V1).
 *
 * Names the holding run, which is the only repair affordance the caller has:
 * `repo.detach_conflict` reports WHICH workspaces block a detach and nothing
 * else reports WHO is holding them. `null` when the row carries no attribution
 * — a hold written before this field existed, or one a `markStale` released.
 */
export class WorkspaceBusyError extends DaemonDomainError {
  /** The busy workspace. Projects to `data.fields.workspaceId`. */
  readonly workspaceId: string;
  /** The run holding it, or `null` when the row carries no attribution. */
  readonly holdingRunId: string | null;

  constructor(workspaceId: string, holdingRunId: string | null) {
    super(
      holdingRunId === null
        ? `workspace ${workspaceId} is busy`
        : `workspace ${workspaceId} is busy: held by run ${holdingRunId}`,
      {
        code: "workspace.busy" satisfies WorkspaceServiceErrorCode,
        httpStatus: 409,
        detail: holdingRunId === null ? { workspaceId } : { workspaceId, holdingRunId },
      },
    );
    this.workspaceId = workspaceId;
    this.holdingRunId = holdingRunId;
  }
}

/**
 * Discriminants for {@link WorkspaceServiceInvariantError}.
 *
 * One error class with a `kind` rather than four classes: all four are the
 * same wire outcome (an anonymous internal error) and differ only in what a
 * daemon operator should go look at, which is exactly what a discriminant is
 * for. Splitting them into classes would imply callers branch on them; nothing
 * does, and nothing should.
 */
export type WorkspaceServiceInvariantKind =
  /**
   * A stored row cannot be projected onto the wire shape — the `list` fold's
   * four throw sources (see the module header): an out-of-vocabulary state, a
   * NULL `fs_root` under a probe-bearing state, a probe that measured some
   * other path, or an identifier the contracts schemas refuse. DB corruption
   * for three of them, a probe-pairing bug in this module for the third.
   *
   * The row is the thing to inspect. Contrast
   * `stale_transition_durability_failure`, where the row is fine.
   */
  | "workspace_row_unprojectable"
  /**
   * The on-read floor derived a stale transition but could not make it
   * durable — the `UPDATE` or its `workspace.stale` append failed (a locked
   * database, a full disk, a signing-key read that threw). The ROW is not the
   * defect here and inspecting it will show nothing wrong; the write path is.
   * Kept distinct from `workspace_row_unprojectable` for exactly that reason.
   */
  | "stale_transition_durability_failure"
  /**
   * A daemon-internal caller asked for a transition the lifecycle does not
   * admit (reprovisioning an `archived` workspace, asserting writability on a
   * `provisioning` one).
   */
  | "illegal_state_transition"
  /**
   * A caller offered an execution root that does not name one complete
   * location — see {@link assertAbsoluteExecutionRoot} for the three shapes
   * that qualify. Refused rather than completed, because "resolve it against
   * something the daemon happens to have" is precisely the approval-scope
   * widening CP-009-8 forbids.
   */
  | "non_absolute_execution_root";

/**
 * A daemon-internal failure with no registered wire code.
 *
 * Deliberately NOT a `DaemonDomainError`. Minting an unregistered `workspace.*`
 * code is banned by the error-contract registry, and borrowing a registered one
 * would misreport the cause — telling a caller a workspace is `stale` when the
 * truth is "this daemon asked for something impossible" sends them to repair
 * the wrong thing. Reaching the IPC boundary as an anonymous `-32603` is the
 * correct outcome: these are bugs and corruption, not conditions a client can
 * act on.
 */
export class WorkspaceServiceInvariantError extends Error {
  /** What broke. See {@link WorkspaceServiceInvariantKind}. */
  readonly kind: WorkspaceServiceInvariantKind;
  /** The row this failure attaches to, or `null` when no row is implicated. */
  readonly workspaceId: string | null;

  constructor(
    message: string,
    options: {
      readonly kind: WorkspaceServiceInvariantKind;
      readonly workspaceId?: string | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    // Mirrors `DaemonDomainError`: the class name comes from the constructor
    // that ran, not from a literal a subclass would have to remember to update.
    this.name = new.target.name;
    this.kind = options.kind;
    this.workspaceId = options.workspaceId ?? null;
  }
}

/**
 * Module-private abort signal for {@link WorkspaceService.markStale}'s
 * in-prelude compare-and-swap.
 *
 * The append path runs `prelude?.()` and then INSERTs the event row
 * unconditionally — only a THROW from the prelude rolls the transaction back
 * (`../events/event-log-service.js`, the writeTxn body). So a prelude that
 * merely RECORDS "my `UPDATE` matched no row" and returns still commits a
 * `workspace.stale` event for a transition that did not happen, which is
 * precisely the I-009-9 duplicate this method exists to avoid: the losing side
 * of a two-reader race would append a second `workspace.stale` behind the
 * winner's.
 *
 * Throwing is therefore the only way to say "abort, but this is not an error".
 * `markStale` catches EXACTLY this class and returns `false`; anything else
 * propagates. Modelled on `../node/node-capability-service.js`'s
 * `CapabilityRowDivergedError`, and not exported for the same reason: it never
 * escapes this module, and it names an internal concurrency event rather than
 * anything a caller did wrong.
 */
class StaleTransitionRaceError extends Error {
  constructor(workspaceId: string) {
    super(
      `WorkspaceService.markStale: workspace ${workspaceId} was staled by another reader ` +
        `between the read and the write transaction; aborting so no second ` +
        `workspace.stale event is appended for one transition.`,
    );
    this.name = "StaleTransitionRaceError";
  }
}

// --------------------------------------------------------------------------
// `metadata.lastError` normalisation — SCRUB, then TRUNCATE
// --------------------------------------------------------------------------

/**
 * Marker appended to a truncated detail. Counted INSIDE the cap, not added to
 * it: the cap is also the wire cap, so a marker that pushed the value one byte
 * over would make the list response the daemon just recorded unrepresentable.
 */
export const WORKSPACE_LAST_ERROR_TRUNCATION_MARKER = "...[truncated]";

// URL userinfo: `scheme://user:password@host`. The one credential shape with no
// recognisable token prefix — an opaque password here is invisible to every
// other pattern, which is why the ordering test uses it as its probe.
const URL_USERINFO_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g;

// Header-style credentials, including the `x-access-token` form git uses for
// GitHub App installation tokens.
const HEADER_CREDENTIAL_PATTERN =
  /((?:authorization|proxy-authorization|private-token|x-auth-token|x-access-token)\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s,;]+/gi;

// `key=value` / `key: value` credentials in captured subprocess output.
const KEY_VALUE_CREDENTIAL_PATTERN =
  /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\s*[:=]\s*)(["']?)[^\s"'&,;]+/gi;

// Vendor token shapes that carry their own prefix and so are recognisable with
// no surrounding context at all.
const KNOWN_TOKEN_PREFIX_PATTERN =
  /\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-|AKIA)[A-Za-z0-9_-]{8,}/g;

const CREDENTIAL_REDACTION = "***";

/**
 * Remove credential material from a captured failure detail.
 *
 * Exported so the ordering test can drive THIS function in both compositions
 * rather than reimplementing the patterns — a control that reimplements the
 * scrubber proves regexes work, not that this module scrubs before it cuts.
 *
 * Over-redaction is the accepted failure direction: `token: not found` becomes
 * `token: ***`, which costs a word of diagnostic detail, while under-redaction
 * writes a live credential into a database row that a list response then puts
 * on the wire.
 */
export function scrubCredentials(rawDetail: string): string {
  return rawDetail
    .replace(URL_USERINFO_PATTERN, `$1${CREDENTIAL_REDACTION}@`)
    .replace(HEADER_CREDENTIAL_PATTERN, `$1${CREDENTIAL_REDACTION}`)
    .replace(KEY_VALUE_CREDENTIAL_PATTERN, `$1$2${CREDENTIAL_REDACTION}`)
    .replace(KNOWN_TOKEN_PREFIX_PATTERN, CREDENTIAL_REDACTION);
}

/**
 * Cut a detail to `WORKSPACE_LAST_ERROR_MAX_LEN`, marking that it was cut.
 *
 * The bound is imported, never respelled: the persist-time cap and the wire cap
 * in `WorkspaceListResponseSchema` are ONE constant, and two spellings of 8192
 * drift the moment either moves.
 *
 * The cap counts UTF-16 code units, because Zod's `.max()` does. Splitting a
 * surrogate pair would leave a lone high surrogate, so the cut backs off one
 * unit when it lands mid-pair.
 */
export function truncateWorkspaceLastError(detail: string): string {
  if (detail.length <= WORKSPACE_LAST_ERROR_MAX_LEN) {
    return detail;
  }
  let cutAt = WORKSPACE_LAST_ERROR_MAX_LEN - WORKSPACE_LAST_ERROR_TRUNCATION_MARKER.length;
  const lastRetainedUnit = detail.charCodeAt(cutAt - 1);
  if (lastRetainedUnit >= 0xd800 && lastRetainedUnit <= 0xdbff) {
    cutAt -= 1;
  }
  return `${detail.slice(0, cutAt)}${WORKSPACE_LAST_ERROR_TRUNCATION_MARKER}`;
}

/**
 * Turn a raw failure detail into a value that is safe to persist AND legal on
 * the wire, or `null` when nothing publishable survives.
 *
 * The order is the obligation: NUL-strip, then SCRUB, then TRUNCATE. Scrubbing
 * after truncation is the bug this ordering exists to prevent — a cut that
 * lands mid-credential destroys the pattern's anchor (`https://user:pw@host`
 * becomes `https://user:pw`, which no longer matches the userinfo shape) and
 * the surviving prefix is still a live secret. NUL-stripping precedes scrubbing
 * so an embedded NUL cannot split a token past its own pattern.
 *
 * `null` for a detail with no non-whitespace content: `lastError`'s wire schema
 * is `wireFreeFormString`, which requires `.min(1)`, at least one `\S`, and no
 * NUL. Persisting an empty or whitespace-only value would make the very list
 * response that reports the failure unrepresentable — the asymmetry the cap
 * comment in `packages/contracts/src/repo.ts` is written against. Recording no
 * detail loses information; recording an illegal one loses the whole response.
 *
 * That emptiness test runs on the SCRUBBED value, before truncation, and the
 * placement is load-bearing: truncation appends
 * {@link WORKSPACE_LAST_ERROR_TRUNCATION_MARKER}, so an over-cap whitespace-only
 * detail tested afterwards would pass on the marker's own `\S` and persist
 * 8177 spaces plus `...[truncated]` as the failure an operator is meant to read.
 */
export function normalizeWorkspaceLastError(rawDetail: string): string | null {
  const nulFree = rawDetail.replace(/\0/g, "");
  const scrubbed = scrubCredentials(nulFree);
  if (!/\S/.test(scrubbed)) {
    return null;
  }
  return truncateWorkspaceLastError(scrubbed);
}

// --------------------------------------------------------------------------
// Dependencies and row shapes
// --------------------------------------------------------------------------

/**
 * Measure a path's reachability.
 *
 * The seam exists at PROBE granularity rather than at readability-callback
 * granularity so a test can hand back a `FilesystemPathProbe` this module did
 * not build — which is the only way to drive the projector's subject-binding
 * guard (`list` throw source 3), and the deterministic way to drive
 * `reachable: false` without racing a directory removal.
 *
 * Production's binding (see {@link WorkspaceServiceDeps.probePath}) sets
 * `probedPath` from its own argument and nothing else. That is the
 * verbatim-probe-subject obligation: the path read out of `workspaces.fs_root`
 * reaches the projector VERBATIM,
 * with no re-resolution in between. Re-canonicalising it would make every row
 * fail the subject-binding guard on any path whose stored spelling differs from
 * its resolved one — and would defeat the guard's purpose, which is to catch
 * exactly that substitution.
 */
export type FilesystemPathProbeFn = (path: string) => Promise<FilesystemPathProbe>;

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface WorkspaceServiceDeps {
  /**
   * Open daemon database. Statements are prepared once, in the constructor.
   *
   * MUST be the same connection the event log behind {@link events} appends
   * through. Every transition writes its row as a `transactionalPrelude`, and
   * a statement prepared on a different connection does not join the event
   * transaction — the row/event atomicity I-009-9 rests on would silently
   * vanish, with no exception anywhere. Nothing here can verify handle
   * identity (the event log sits behind the emitter seam), so the composition
   * root owns the constraint; the plan's Phase-3 wiring obligation records it.
   */
  readonly database: Database;
  /** The single seam through which workspace lifecycle events are appended (T2.2). */
  readonly events: WorkspaceEventEmitter;
  /** Containment validator (T1.6). Defaults to a stock `TrustEnvelopeValidator`. */
  readonly trustEnvelope?: TrustEnvelopeValidator;
  /**
   * Reachability probe. Defaults to a composition of
   * `DEFAULT_DIRECTORY_READABILITY_PROBE` with the wall clock, reading the
   * clock BEFORE the probe so `checkedAt` is never newer than the observation
   * it timestamps — a conservative freshness claim on a slow filesystem.
   */
  readonly probePath?: FilesystemPathProbeFn;
  /** ISO-8601 wall clock for `created_at` / `updated_at`. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /**
   * Workspace-id source. Defaults to `crypto.randomUUID()`. Injected ids are
   * still parsed through `WorkspaceIdSchema`, so a test source must mint real
   * UUIDs rather than counters.
   */
  readonly newWorkspaceId?: () => string;
}

/** The `repo_mounts` columns this service reads. */
interface MountRow {
  readonly id: string;
  readonly session_id: string;
  readonly canonical_root: string;
  readonly vcs_type: string;
}

/** The `workspaces` columns this service reads. */
interface WorkspaceRow {
  readonly id: string;
  readonly session_id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly state: string;
  readonly metadata: string;
}

/** Inputs for {@link WorkspaceService.createDefaultWorkspace}. */
export interface CreateDefaultWorkspaceInput {
  /** The mount being attached. */
  readonly repoMountId: string;
  /** The session the mount belongs to — the workspace inherits it, never a caller-supplied one. */
  readonly sessionId: string;
  /** The mount's canonical root, already absolute and `realpath`-ed by T1.5. */
  readonly canonicalRoot: string;
  /** Envelope actor; defaults to the system actor. */
  readonly actor?: string | null;
  /** Envelope linkage back to the causing `repo.attached`, when the caller has one. */
  readonly correlationId?: string | null;
}

/**
 * The two halves of a default-workspace creation, so T2.3's attach can commit
 * the workspace row inside the SAME transaction as the mount row.
 *
 * Attach composes them as:
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
 * The split is not cosmetic. Putting the workspace INSERT in the
 * `workspace.ready` append instead would leave a crash window in which a mount
 * exists with no default workspace — and D-009-7 makes `defaultWorkspaceId`
 * REQUIRED on the ATTACH response (`RepoMountReadResponse` has no such field,
 * so the read side is not what forces this). `packages/contracts/src/repo.ts`
 * gives the reason at `RepoAttachResponse.defaultWorkspaceId`: optionality
 * "would make 'attached, but no workspace' representable, and the persistence
 * model never produces it" — which is precisely what that crash window would
 * make durable. This split's window is the survivable one instead: both rows
 * are present and consistent, and only the `workspace.ready` event is missing.
 *
 * {@link WorkspaceService.createDefaultWorkspace} takes the mount's fields as
 * arguments rather than reading the mount row, because at call time that row is
 * not committed — a `SELECT` from inside the prelude would find nothing.
 */
export interface DefaultWorkspaceCreation {
  /** The minted id, available before either half runs (attach needs it for its response). */
  readonly workspaceId: string;
  /** Synchronous, prelude-safe INSERT. Throws if called twice. */
  insertRow(): void;
  /** Appends `workspace.ready`. Throws if {@link insertRow} has not run. */
  emitReady(): Promise<void>;
}

/** Inputs for {@link WorkspaceService.bind}. */
export interface BindWorkspaceInput extends WorkspaceBindRequest {
  /** Envelope actor; defaults to the system actor. */
  readonly actor?: string | null;
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

// The one workspace state a fresh binding may take without provisioning, and
// the DDL default (`Spec-009 §Default Behavior`).
const READ_ONLY_EXECUTION_MODE: ExecutionMode = "read-only";

// `metadata` keys. `lastError` is ratified by D-009-7; `holdingRunId` is
// daemon-internal (see `markBusy`) and never crosses the wire.
const LAST_ERROR_METADATA_PATH = "$.lastError";
const HOLDING_RUN_ID_METADATA_PATH = "$.holdingRunId";

// --------------------------------------------------------------------------
// WorkspaceService
// --------------------------------------------------------------------------

/**
 * Owns every workspace lifecycle transition, and every statement against the
 * `workspaces` table with one exception: the detach cascade's dependent read
 * and archive write live in `./repo-mount-service.js`, because they must share
 * the mount flip's transaction and an archive primitive here — which would
 * open its own event append — could not participate in one.
 *
 * Statement-per-transition rather than one composed writer: each `UPDATE`
 * carries its own legal-predecessor set in its `WHERE` clause, which puts the
 * transition table in the statements themselves instead of in a branch that can
 * drift from them.
 */
export class WorkspaceService {
  readonly #events: WorkspaceEventEmitter;
  readonly #trustEnvelope: TrustEnvelopeValidator;
  readonly #probePath: FilesystemPathProbeFn;
  readonly #now: () => string;
  readonly #newWorkspaceId: () => string;

  readonly #selectAttachedMountStmt: Statement;
  readonly #selectAttachedMountRootsStmt: Statement;
  readonly #selectWorkspaceStmt: Statement;
  readonly #listWorkspacesStmt: Statement;
  readonly #listWorkspacesByMountStmt: Statement;
  readonly #insertWorkspaceStmt: Statement;
  readonly #bindWorkspaceStmt: Statement;
  readonly #beginReprovisionStmt: Statement;
  readonly #completeReprovisionStmt: Statement;
  readonly #failReprovisionWithDetailStmt: Statement;
  readonly #failReprovisionWithoutDetailStmt: Statement;
  readonly #markStaleStmt: Statement;
  readonly #markBusyStmt: Statement;
  readonly #releaseBusyStmt: Statement;

  constructor(deps: WorkspaceServiceDeps) {
    this.#events = deps.events;
    this.#trustEnvelope = deps.trustEnvelope ?? new TrustEnvelopeValidator();
    this.#probePath = deps.probePath ?? createDefaultPathProbe();
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newWorkspaceId = deps.newWorkspaceId ?? ((): string => randomUUID());

    const database = deps.database;

    // Scoped to `state = 'attached'` — ordering obligation (ii). A detached
    // mount is not a bind target, and answering `repo.not_found` for one is
    // more honest than letting it reach containment evaluation.
    this.#selectAttachedMountStmt = database.prepare(
      `SELECT id, session_id, canonical_root, vcs_type
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    // The session's declared envelope: the canonical roots of its ACTIVE
    // mounts. A detached mount's root is no longer part of the envelope, so a
    // path under it must not validate.
    this.#selectAttachedMountRootsStmt = database.prepare(
      `SELECT canonical_root
         FROM repo_mounts
        WHERE session_id = @session_id AND state = 'attached'
        ORDER BY canonical_root ASC`,
    );

    this.#selectWorkspaceStmt = database.prepare(
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata
         FROM workspaces
        WHERE id = @workspace_id`,
    );

    // `created_at, id` rather than insertion order: `created_at` alone ties for
    // rows written inside one transaction (T2.3's attach writes a mount and its
    // default workspace at the same instant), and a list whose order depends on
    // the query planner is not testable.
    this.#listWorkspacesStmt = database.prepare(
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata
         FROM workspaces
        WHERE session_id = @session_id
        ORDER BY created_at ASC, id ASC`,
    );

    this.#listWorkspacesByMountStmt = database.prepare(
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata
         FROM workspaces
        WHERE session_id = @session_id AND repo_mount_id = @repo_mount_id
        ORDER BY created_at ASC, id ASC`,
    );

    // Unconditional INSERT, used ONLY by `createDefaultWorkspace`. It runs
    // inside T2.3's attach transaction, where the mount row is written by the
    // same prelude and is therefore not yet visible to a `SELECT` — a
    // mount-attachment predicate here would match nothing and fail every
    // attach. See {@link DefaultWorkspaceCreation}.
    this.#insertWorkspaceStmt = database.prepare(
      `INSERT INTO workspaces (
         id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata, created_at, updated_at
       ) VALUES (
         @id, @session_id, @repo_mount_id, @execution_mode, @fs_root, @state, '{}', @now, @now
       )`,
    );

    // `INSERT ... SELECT` rather than `VALUES`, so the mount's attachment is
    // re-tested INSIDE the write transaction. `bind` reads the mount, then
    // awaits a filesystem probe and the containment validator — during those
    // awaits a `repo.detach` cascade can archive this mount's workspaces and
    // flip it to `detached`, and it has already passed over the row this insert
    // is about to write. The foreign key would still be satisfied (the mount
    // ROW survives a detach; only its `state` moves), so without this predicate
    // the bind commits a `ready` workspace on a detached mount — a live
    // execution root outside the session's trust envelope (I-009-3) that
    // `assertWritable` then happily passes. Zero rows changed aborts the
    // prelude, which takes the `workspace.ready` event with it.
    this.#bindWorkspaceStmt = database.prepare(
      `INSERT INTO workspaces (
         id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata, created_at, updated_at
       )
       SELECT @id, @session_id, @repo_mount_id, @execution_mode, @fs_root, @state, '{}', @now, @now
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    // `ready` and `stale` are the legal predecessors. `stale` is not an
    // oversight: `Spec-009 §Execution Mode Transitions` allows the switch to be
    // RETRIED, and a failed switch left the row `stale` — refusing it here
    // would make the documented retry impossible.
    //
    // `fs_root = NULL` because the old execution root is released, and because
    // CP-009-8 makes a stale `fs_root` an approval-scope hazard: Plan-012 would
    // keep matching approvals against a root this workspace no longer owns.
    //
    // `execution_mode = @execution_mode` here rather than at completion is
    // forced, not chosen — `completeReprovision(workspaceId, fsRoot)` takes no
    // mode, so nothing downstream could persist it.
    //
    // `lastError` is cleared HERE as well as at completion, and the redundancy
    // is deliberate — do not delete either. `packages/contracts/src/repo.ts`
    // makes `lastError` "present iff the workspace went `stale` from a recorded
    // failure" an EMITTER obligation on this module, and the documented retry
    // path is `failReprovision -> beginReprovision`: without this clause the
    // `provisioning` row keeps advertising the PREVIOUS attempt's failure, and
    // a `markStale` from that state lands a `stale` row carrying a superseded
    // detail. Clearing only at completion fixes the success leg and leaves the
    // whole in-flight window wrong. See `#completeReprovisionStmt` for the
    // other end.
    //
    // NOT `holdingRunId`: `ready` rows never carry a hold, `markStale` clears
    // it on the way in, and `busy` is not a legal predecessor here — a second
    // `json_remove` would imply this statement doubts one of those three.
    this.#beginReprovisionStmt = database.prepare(
      `UPDATE workspaces
          SET execution_mode = @execution_mode,
              fs_root = NULL,
              state = 'provisioning',
              metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state IN ('ready', 'stale')`,
    );

    // The OTHER end of the deliberate pair described on `#beginReprovisionStmt`
    // — also redundant on the happy path, also load-bearing. A cycle can be
    // completed by a caller that never re-entered through `beginReprovision`
    // (Plan-010 drives these primitives independently), and a `ready` workspace
    // still advertising the error a later retry fixed reports a failure that is
    // no longer true.
    this.#completeReprovisionStmt = database.prepare(
      `UPDATE workspaces
          SET fs_root = @fs_root,
              state = 'ready',
              metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'provisioning'`,
    );

    // `json_set` rather than a whole-blob rewrite: `metadata` is a shared blob
    // and clobbering it would drop keys other writers own.
    this.#failReprovisionWithDetailStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'stale',
              metadata = json_set(metadata, '${LAST_ERROR_METADATA_PATH}', @last_error),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'provisioning'`,
    );

    this.#failReprovisionWithoutDetailStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'stale',
              metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'provisioning'`,
    );

    // `busy` IS a legal predecessor — see the module header. `stale` is absent
    // because re-staling is a no-op, and `archived` because it is terminal.
    // The hold is released in the same statement: a `stale` workspace is not
    // held by anyone, and leaving `holdingRunId` behind would let a later
    // `workspace.busy` name a run that is long gone.
    this.#markStaleStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'stale',
              metadata = json_remove(metadata, '${HOLDING_RUN_ID_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state IN ('provisioning', 'ready', 'busy')`,
    );

    // The compare-and-swap IS the mutual exclusion: two concurrent runs both
    // reading `ready` produce exactly one `changes === 1`.
    this.#markBusyStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'busy',
              metadata = json_set(metadata, '${HOLDING_RUN_ID_METADATA_PATH}', @run_id),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'ready'`,
    );

    // `state = 'busy'` in the predicate is the never-auto-heal rule in SQL: a
    // workspace that went stale mid-run is not restored by its holder letting
    // go.
    this.#releaseBusyStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'ready',
              metadata = json_remove(metadata, '${HOLDING_RUN_ID_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'busy'`,
    );
  }

  // ------------------------------------------------------------------------
  // Creation
  // ------------------------------------------------------------------------

  /**
   * Build the default workspace for a mount being attached: read-only, rooted
   * at the mount's canonical root, immediately `ready`
   * (`Spec-009 §Default Behavior`).
   *
   * Returns the two halves described on {@link DefaultWorkspaceCreation}; this
   * method itself touches neither the database nor the event log.
   *
   * No reachability probe: T1.5's resolver just proved the root readable to
   * produce `canonicalRoot`, and re-probing inside an attach that is already
   * mid-transaction would buy a window measured in microseconds.
   */
  createDefaultWorkspace(input: CreateDefaultWorkspaceInput): DefaultWorkspaceCreation {
    assertAbsoluteExecutionRoot(input.canonicalRoot, null);

    const workspaceId = this.#newWorkspaceId();
    const createdAt = this.#now();
    let rowInserted = false;
    let readinessAnnounced = false;

    return {
      workspaceId,
      insertRow: (): void => {
        if (rowInserted) {
          throw new WorkspaceServiceInvariantError(
            `default workspace "${workspaceId}" was already inserted; a creation is single-use`,
            { kind: "illegal_state_transition", workspaceId },
          );
        }
        this.#insertWorkspaceStmt.run({
          id: workspaceId,
          session_id: input.sessionId,
          repo_mount_id: input.repoMountId,
          execution_mode: READ_ONLY_EXECUTION_MODE,
          fs_root: input.canonicalRoot,
          state: "ready" satisfies WorkspaceState,
          now: createdAt,
        });
        rowInserted = true;
      },
      emitReady: async (): Promise<void> => {
        if (!rowInserted) {
          throw new WorkspaceServiceInvariantError(
            `default workspace "${workspaceId}" cannot announce readiness before its row is written`,
            { kind: "illegal_state_transition", workspaceId },
          );
        }
        // Single-use for the same reason `insertRow` is, and for a stronger
        // one: this half has no compare-and-swap to make a repeat harmless, so
        // a second call appends a second `workspace.ready` for one transition —
        // the I-009-9 duplicate. Flagged BEFORE the append, so a caller that
        // retries a failed append does not get a silent second event on the
        // second success either.
        if (readinessAnnounced) {
          throw new WorkspaceServiceInvariantError(
            `default workspace "${workspaceId}" already announced readiness; a creation is single-use`,
            { kind: "illegal_state_transition", workspaceId },
          );
        }
        readinessAnnounced = true;
        await this.#events.emitWorkspaceReady({
          sessionId: input.sessionId,
          workspaceId,
          repoMountId: input.repoMountId,
          actor: input.actor ?? null,
          correlationId: input.correlationId ?? null,
        });
      },
    };
  }

  /**
   * Bind a workspace to an attached mount (`repo.workspaceBind`).
   *
   * The refusal order is the contract; see the module header. Briefly:
   * mount identity → mode capability → root reachability → containment → write.
   *
   * A read-only bind lands `ready` with its resolved root. A writable bind
   * lands `provisioning` with `fs_root` NULL — Plan-010's provisioner supplies
   * the real root through {@link completeReprovision}. The validated root is
   * DISCARDED on that path rather than stored: a worktree's root is not the
   * requested directory, and persisting the requested one would hand Plan-012 an
   * approval scope the workspace never executes in. The validation still runs,
   * because refusing an out-of-envelope request before spawning a provisioner is
   * cheaper and safer than refusing after.
   */
  async bind(input: BindWorkspaceInput): Promise<WorkspaceBindResponse> {
    // (1) Mount identity, scoped to `attached` — ordering obligation (ii).
    const mountRow = this.#selectAttachedMountStmt.get({
      repo_mount_id: input.repoMountId,
    }) as MountRow | undefined;
    if (mountRow === undefined) {
      throw new RepoMountNotFoundError(input.repoMountId);
    }

    // `session_id` comes off the mount row. A caller-supplied session would let
    // a request attach a workspace to someone else's session by naming a mount
    // it does not own.
    const sessionId = mountRow.session_id;

    // (2) Mode capability, before any filesystem work — I-009-8: a mode this
    // mount cannot offer is refused by name, never substituted.
    const capabilities = computeExecutionModeCapabilities({
      vcsType: mountRow.vcs_type as VcsType,
    });
    if (!capabilities.availableModes.includes(input.executionMode)) {
      throw new WorkspaceModeUnsupportedError(
        input.executionMode,
        capabilities.availableModes,
        capabilities.restrictions?.[input.executionMode] ??
          "the mount's capability matrix does not offer this mode",
      );
    }

    // (3) Reachability BEFORE containment — ordering obligation (i).
    const mountRootProbe = await this.#probePath(mountRow.canonical_root);
    const mountHealth = computeRepoMountHealth(
      { canonicalRoot: mountRow.canonical_root },
      mountRootProbe,
    );
    if (mountHealth.status !== "healthy") {
      throw new WorkspaceStaleError(null);
    }

    // (4) Containment (I-009-3). The envelope is the session's ACTIVE mount
    // roots; `validateExecutionRoot` raises `TrustEnvelopeViolationError` for
    // anything that escapes, and guarantees the root it returns is a readable
    // directory.
    const envelopeRootRows = this.#selectAttachedMountRootsStmt.all({
      session_id: sessionId,
    }) as ReadonlyArray<{ readonly canonical_root: string }>;
    const envelopeRoots = envelopeRootRows.map((mountRootRow) => mountRootRow.canonical_root);
    const resolvedExecutionRoot = await this.#trustEnvelope.validateExecutionRoot({
      mountCanonicalRoot: mountRow.canonical_root,
      directory: input.directory,
      sessionEnvelopeRoots: envelopeRoots,
    });

    // (5) Write the row inside the event's transaction (I-009-9).
    const isReadOnly = input.executionMode === READ_ONLY_EXECUTION_MODE;
    const workspaceId = this.#newWorkspaceId();
    const createdAt = this.#now();
    const boundState: WorkspaceState = isReadOnly ? "ready" : "provisioning";
    const boundRoot = isReadOnly ? resolvedExecutionRoot : null;
    if (boundRoot !== null) {
      assertAbsoluteExecutionRoot(boundRoot, workspaceId);
    }

    // The mount's attachment is re-tested inside this write — see
    // `#bindWorkspaceStmt`. Zero rows means a detach cascade overtook the
    // awaits above, and aborting here rolls the event row back with it.
    const insertRow = (): void => {
      assertSingleRowChanged(
        this.#bindWorkspaceStmt.run({
          id: workspaceId,
          session_id: sessionId,
          repo_mount_id: mountRow.id,
          execution_mode: input.executionMode,
          fs_root: boundRoot,
          state: boundState,
          now: createdAt,
        }),
        workspaceId,
        "bind",
        "its repo mount",
      );
    };

    // `repoMountId` on the envelope because this event is the workspace's
    // BIRTH: it is the only point at which a timeline reader can learn the
    // workspace/mount association without reading a row. Later transitions omit
    // it — the association is already on the timeline by then.
    const emitInput = {
      sessionId,
      workspaceId,
      repoMountId: mountRow.id,
      actor: input.actor ?? null,
      transactionalPrelude: insertRow,
    };
    if (isReadOnly) {
      await this.#events.emitWorkspaceReady(emitInput);
    } else {
      await this.#events.emitWorkspaceProvisioning(emitInput);
    }

    return {
      workspaceId: WorkspaceIdSchema.parse(workspaceId),
      ...(boundRoot === null ? {} : { fsRoot: boundRoot }),
      executionMode: input.executionMode,
      state: boundState,
    };
  }

  // ------------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------------

  /**
   * List a session's workspaces, each enriched through T2.5's health
   * projection (`repo.workspaceList`).
   *
   * Every probe-bearing row is probed at read time (D-009-5's on-read floor),
   * and a derived stale transition is PERSISTED before the row is reported —
   * I-009-7's observability claim is about the row, not about one response.
   *
   * Per-row failures propagate, wrapped for attribution. See the module header
   * for the four sources and why containment was rejected.
   */
  async list(request: WorkspaceListRequest): Promise<WorkspaceListResponse> {
    // One binding assigned from two different prepared statements, rather than
    // a cast per branch: the mount-scoped and session-scoped queries select the
    // same columns and must project identically, and duplicating the row type
    // at two call sites is how those two drift.
    let rows: WorkspaceRow[];
    if (request.repoMountId === undefined) {
      rows = this.#listWorkspacesStmt.all({ session_id: request.sessionId }) as WorkspaceRow[];
    } else {
      rows = this.#listWorkspacesByMountStmt.all({
        session_id: request.sessionId,
        repo_mount_id: request.repoMountId,
      }) as WorkspaceRow[];
    }

    const workspaces: WorkspaceListResponse["workspaces"] = [];
    for (const row of rows) {
      workspaces.push(await this.#projectRow(row));
    }
    return { workspaces };
  }

  /**
   * The write gate (CP-009-3): refuse unless the workspace can accept a run's
   * writes right now.
   *
   * Probes first, so a root that vanished since the last read is caught here
   * and its stale transition persisted before the refusal — that persistence is
   * what makes the refusal observable to the next `list` rather than a private
   * verdict.
   *
   * Scope is deliberate and narrow. `ready` and `busy` pass; `stale` raises
   * `workspace.stale`; `provisioning` and `archived` raise a
   * {@link WorkspaceServiceInvariantError}, because no registered code names
   * them and inventing one is banned. `busy` passing is not a hole: the precise
   * `workspace.busy` refusal belongs to {@link markBusy}, which is the call that
   * actually contends for the hold, and duplicating it here would let a caller
   * that never takes a hold be refused for a reason that does not apply to it.
   * Plan-010 owns the remaining pre-run refusals
   * (`workspace.execution_root_unresolved`, `workspace.branch_mismatch`).
   *
   * CP-009-3's clause that "the same gate guards Plan-009's own writable-bind
   * path" is discharged by {@link bind}'s step (3), not by a call to this
   * method: at bind time there is no workspace row to assert against, so the
   * mount-root probe is the same refusal one step earlier.
   */
  async assertWritable(workspaceId: string): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);
    const observedState = await this.#observeState(row);

    switch (observedState) {
      case "ready":
      case "busy":
        return;
      case "stale":
        throw new WorkspaceStaleError(workspaceId);
      case "provisioning":
      case "archived":
        throw new WorkspaceServiceInvariantError(
          `workspace "${workspaceId}" cannot accept writes in state "${observedState}"`,
          { kind: "illegal_state_transition", workspaceId },
        );
      default: {
        const unreachable: never = observedState;
        throw new WorkspaceServiceInvariantError(
          `workspace "${workspaceId}" reported an unmodelled state "${String(unreachable)}"`,
          { kind: "workspace_row_unprojectable", workspaceId },
        );
      }
    }
  }

  // ------------------------------------------------------------------------
  // Execution-mode transitions (CP-009-2)
  // ------------------------------------------------------------------------

  /**
   * Enter the reprovision cycle: `ready | stale -> provisioning` (I-009-6 — the
   * id is untouched and no row is created or destroyed).
   *
   * Validates the TARGET mode against the mount's matrix, because a switch to a
   * mode the mount cannot offer must fail before a provisioner is spawned, and
   * because {@link completeReprovision} takes no mode and so cannot re-check it.
   *
   * Does not call {@link assertWritable}: `stale` is a legal predecessor here
   * (the documented retry path) and the gate refuses it.
   */
  async beginReprovision(
    workspaceId: string,
    targetMode: ExecutionMode,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);
    const mountRow = this.#requireMountRowFor(row);

    const capabilities = computeExecutionModeCapabilities({
      vcsType: mountRow.vcs_type as VcsType,
    });
    if (!capabilities.availableModes.includes(targetMode)) {
      throw new WorkspaceModeUnsupportedError(
        targetMode,
        capabilities.availableModes,
        capabilities.restrictions?.[targetMode] ??
          "the mount's capability matrix does not offer this mode",
      );
    }

    // Read-side refusals with the precise code, before the compare-and-swap —
    // the CAS can only report "the row was not in a legal predecessor state",
    // which is not an answer a caller can act on.
    this.#refuseIllegalPredecessor(row, ["ready", "stale"], "reprovision");

    const now = this.#now();
    await this.#events.emitWorkspaceProvisioning({
      sessionId: row.session_id,
      workspaceId,
      actor: options.actor ?? null,
      transactionalPrelude: () => {
        assertSingleRowChanged(
          this.#beginReprovisionStmt.run({
            workspace_id: workspaceId,
            execution_mode: targetMode,
            now,
          }),
          workspaceId,
          "reprovision",
        );
      },
    });
  }

  /**
   * Finish the cycle: `provisioning -> ready`, adopting the provisioner's
   * execution root and clearing any recorded failure.
   *
   * `fsRoot` is NOT re-validated for containment. That is deliberate and is
   * spelled out in `./trust-envelope.js`: a worktree or ephemeral clone lives
   * OUTSIDE the mount's canonical root by construction, so running the
   * containment validator here would reject every writable mode it exists to
   * support. The root's legitimacy comes from its provenance — Plan-010's
   * provisioner created it under daemon control.
   *
   * Absoluteness IS checked, because provenance does not make a relative path
   * safe: CP-009-8 hands this value to Plan-012 as an approval scope root, and a
   * relative one would be completed against whatever working directory the tool
   * process happens to have.
   */
  async completeReprovision(
    workspaceId: string,
    fsRoot: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    assertAbsoluteExecutionRoot(fsRoot, workspaceId);
    const row = this.#requireWorkspaceRow(workspaceId);
    this.#refuseIllegalPredecessor(row, ["provisioning"], "complete provisioning of");

    const now = this.#now();
    await this.#events.emitWorkspaceReady({
      sessionId: row.session_id,
      workspaceId,
      actor: options.actor ?? null,
      transactionalPrelude: () => {
        assertSingleRowChanged(
          this.#completeReprovisionStmt.run({ workspace_id: workspaceId, fs_root: fsRoot, now }),
          workspaceId,
          "complete provisioning of",
        );
      },
    });
  }

  /**
   * Abandon the cycle: `provisioning -> stale`, recording the failure detail in
   * `metadata.lastError` (`Spec-009 §Execution Mode Transitions`).
   *
   * `stale` rather than a dedicated failure state because the workspace's
   * observable condition IS stale — it has no usable execution root — and
   * because `stale` is the state the write gate already refuses.
   *
   * The detail is scrubbed and then truncated, in that order; see
   * {@link normalizeWorkspaceLastError}. A detail with nothing publishable left
   * records no `lastError` at all rather than an empty one the wire schema
   * would reject.
   */
  async failReprovision(
    workspaceId: string,
    failureDetail: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);
    this.#refuseIllegalPredecessor(row, ["provisioning"], "record a provisioning failure for");

    const lastError = normalizeWorkspaceLastError(failureDetail);
    const now = this.#now();
    await this.#events.emitWorkspaceStale({
      sessionId: row.session_id,
      workspaceId,
      actor: options.actor ?? null,
      transactionalPrelude: () => {
        const result =
          lastError === null
            ? this.#failReprovisionWithoutDetailStmt.run({ workspace_id: workspaceId, now })
            : this.#failReprovisionWithDetailStmt.run({
                workspace_id: workspaceId,
                last_error: lastError,
                now,
              });
        assertSingleRowChanged(result, workspaceId, "record a provisioning failure for");
      },
    });
  }

  // ------------------------------------------------------------------------
  // Health and holds
  // ------------------------------------------------------------------------

  /**
   * Persist the stale transition T2.5's projection derives — the persistence
   * half of I-009-7 — and announce it.
   *
   * Returns `true` when a transition was written, `false` when the row was
   * already `stale` or `archived`, vanished, or was staled by a concurrent
   * reader. Idempotent by design: it is called from every read path, and
   * re-announcing a transition that already happened would break I-009-9's
   * one-event-per-real-transition rule.
   *
   * `busy -> stale` is legal and is written; see the module header.
   */
  async markStale(
    workspaceId: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<boolean> {
    const row = this.#findWorkspaceRow(workspaceId);
    if (
      row === undefined ||
      row.state === ("stale" satisfies WorkspaceState) ||
      row.state === ("archived" satisfies WorkspaceState)
    ) {
      return false;
    }

    const now = this.#now();
    try {
      await this.#events.emitWorkspaceStale({
        sessionId: row.session_id,
        workspaceId,
        actor: options.actor ?? null,
        transactionalPrelude: () => {
          // Aborting is the ONLY way to decline the event. The append path runs
          // this prelude and then INSERTs unconditionally, so recording "no row
          // matched" in a flag and returning normally would still commit a
          // `workspace.stale` for a transition that did not happen — the losing
          // side of a two-reader race appending a duplicate behind the winner's
          // (I-009-9). A concurrent reader staling the same row is the EXPECTED
          // race on a path every read drives, not an error, which is why the
          // sentinel is caught below and turned into `false` rather than
          // propagated like `assertSingleRowChanged`'s refusal.
          const result = this.#markStaleStmt.run({ workspace_id: workspaceId, now });
          if (result.changes !== 1) {
            throw new StaleTransitionRaceError(workspaceId);
          }
        },
      });
    } catch (error) {
      // EXACTLY the sentinel. Anything else — a locked database, a failed
      // append — is a durability failure that must not be disguised as a lost
      // race, and `#observeState` gives it its own attributed discriminant.
      if (error instanceof StaleTransitionRaceError) {
        return false;
      }
      throw error;
    }
    return true;
  }

  /**
   * Take the run hold (CP-009-7): `ready -> busy`, recording the holding run.
   *
   * Emits NO event. The workspace event registry is closed at six types and
   * `busy` has none — CP-009-7 makes the run's own `run.*` events the hold's
   * timeline visibility, so minting a seventh here would put an unregistered
   * type on the wire.
   *
   * The `runId` is persisted to `metadata.holdingRunId`. It is not on the wire
   * and not in D-009-7's ratified key list, but the alternative is to accept a
   * parameter and drop it: with no `holding_run_id` column, nothing else in the
   * daemon can answer "which run is holding this workspace?" — the question an
   * operator asks after `repo.detach_conflict` names the blocking workspaces and
   * stops there. {@link WorkspaceBusyError} reads it straight back out.
   *
   * Probes before taking the hold. A hold on a vanished root is the exact
   * situation I-009-7 exists to prevent, and taking it and discovering the truth
   * mid-run is strictly worse than refusing now.
   */
  async markBusy(
    workspaceId: string,
    runId: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);

    // Contention is answered before the probe: a caller losing a race for the
    // hold does not need a filesystem verdict, it needs to know who won.
    if (row.state === ("busy" satisfies WorkspaceState)) {
      throw new WorkspaceBusyError(workspaceId, readHoldingRunId(row));
    }

    const observedState = await this.#observeState(row, options);
    if (observedState === "stale") {
      throw new WorkspaceStaleError(workspaceId);
    }
    if (observedState !== "ready") {
      throw new WorkspaceServiceInvariantError(
        `workspace "${workspaceId}" cannot be held in state "${observedState}"`,
        { kind: "illegal_state_transition", workspaceId },
      );
    }

    const changes = this.#markBusyStmt.run({
      workspace_id: workspaceId,
      run_id: runId,
      now: this.#now(),
    }).changes;
    if (changes !== 1) {
      // The compare-and-swap lost. Re-read to answer with the reason rather
      // than with the mechanism.
      const currentRow = this.#findWorkspaceRow(workspaceId);
      if (currentRow === undefined) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      if (currentRow.state === ("busy" satisfies WorkspaceState)) {
        throw new WorkspaceBusyError(workspaceId, readHoldingRunId(currentRow));
      }
      if (currentRow.state === ("stale" satisfies WorkspaceState)) {
        throw new WorkspaceStaleError(workspaceId);
      }
      throw new WorkspaceServiceInvariantError(
        `workspace "${workspaceId}" left state "ready" before the hold could be taken (now "${currentRow.state}")`,
        { kind: "illegal_state_transition", workspaceId },
      );
    }
  }

  /**
   * Release the run hold (CP-009-7): `busy -> ready`.
   *
   * Emits no event, for the same reason {@link markBusy} does not.
   *
   * Returns `true` when a hold was released. A non-`busy` row is a no-op, not
   * an error: this runs in a `finally`, where throwing would replace the run's
   * real failure with a bookkeeping complaint, and a workspace that went stale
   * mid-run must STAY stale — releasing is not a health verdict and must never
   * auto-heal.
   */
  releaseBusy(workspaceId: string): boolean {
    return this.#releaseBusyStmt.run({ workspace_id: workspaceId, now: this.#now() }).changes === 1;
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  /**
   * Probe a row if its state owes one, persist any derived stale transition,
   * and return the state to report.
   *
   * THE single place the on-read floor is implemented, so `list`,
   * `assertWritable` and `markBusy` cannot drift on what "current state" means.
   *
   * Attribution lives here rather than only in {@link #projectRow} for the same
   * reason: `assertWritable` and `markBusy` drive this floor too, and a
   * projector refusal escaping one of them anonymously would name no row at all.
   * The two failure classes stay distinct — see
   * {@link WorkspaceServiceInvariantKind}.
   */
  async #observeState(
    row: WorkspaceRow,
    options: { readonly actor?: string | null } = {},
  ): Promise<WorkspaceState> {
    const projection = await this.#deriveHealth(row);

    if (projection.staleTransitionRequired) {
      try {
        await this.markStale(row.id, options);
      } catch (error) {
        // A DIFFERENT defect: the row's health was derived fine, the write of
        // that derivation failed. Kept separate so an operator is not sent to
        // inspect a healthy row for a locked database.
        throw wrapRowFailure(error, row.id, "stale_transition_durability_failure");
      }
    }
    return projection.observedState;
  }

  /**
   * Probe the row if its state owes one and hand the pair to T2.5's projector,
   * attributing any refusal to the row.
   *
   * Split from {@link #observeState} so the two failure classes cannot borrow
   * each other's discriminant: everything in here is a PROJECTION failure, and
   * the caller's `markStale` is a DURABILITY one.
   */
  async #deriveHealth(row: WorkspaceRow): Promise<WorkspaceHealthProjection> {
    // Cast, not parse: an out-of-vocabulary value is exactly what
    // `computeWorkspaceHealth`'s membership check refuses, and pre-parsing here
    // would move that refusal out of the projector that owns it.
    const state = row.state as WorkspaceState;
    try {
      // `fs_root === null` under a probe-bearing state deliberately reaches the
      // projector with a `null` probe: its NULL-root precondition is checked
      // BEFORE its missing-probe precondition, so the throw names the real
      // defect.
      let probe: FilesystemPathProbe | null = null;
      if (PROBE_BEARING_WORKSPACE_STATES.has(state) && row.fs_root !== null) {
        // VERBATIM: the stored path is what the probe measures — the
        // verbatim-probe-subject obligation; no re-resolution stands between
        // the column and the projector.
        probe = await this.#probePath(row.fs_root);
      }
      return computeWorkspaceHealth({ state, fsRoot: row.fs_root }, probe);
    } catch (error) {
      throw wrapRowFailure(error, row.id, "workspace_row_unprojectable");
    }
  }

  /** Project one stored row onto the wire shape, attributing any failure to it. */
  async #projectRow(row: WorkspaceRow): Promise<WorkspaceListResponse["workspaces"][number]> {
    try {
      const observedState = await this.#observeState(row);
      // Identifier and mode parsing sit INSIDE the same wrapper as the
      // projection: a corrupt id is the same class of problem as a corrupt
      // state, and attributing them differently would suggest they need
      // different repairs.
      const projected: WorkspaceListResponse["workspaces"][number] = {
        id: WorkspaceIdSchema.parse(row.id),
        repoMountId: RepoMountIdSchema.parse(row.repo_mount_id),
        executionMode: ExecutionModeSchema.parse(row.execution_mode),
        state: observedState,
        ...(row.fs_root === null ? {} : { fsRoot: row.fs_root }),
      };
      const lastError = readLastError(row);
      return lastError === null ? projected : { ...projected, lastError };
    } catch (error) {
      // Covers what `#observeState` does not: the identifier and mode parses
      // above. Already-attributed failures pass through unchanged, so the
      // inner layer's discriminant survives.
      throw wrapRowFailure(error, row.id, "workspace_row_unprojectable");
    }
  }

  /** Read one workspace row, or `undefined` when the id names nothing. */
  #findWorkspaceRow(workspaceId: string): WorkspaceRow | undefined {
    return this.#selectWorkspaceStmt.get({
      workspace_id: workspaceId,
    }) as WorkspaceRow | undefined;
  }

  #requireWorkspaceRow(workspaceId: string): WorkspaceRow {
    const row = this.#findWorkspaceRow(workspaceId);
    if (row === undefined) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return row;
  }

  /**
   * Resolve a workspace's mount.
   *
   * A workspace whose mount is not `attached` cannot answer capability
   * questions, and `repo.not_found` for the mount is the honest report — the
   * workspace exists, its mount does not.
   */
  #requireMountRowFor(row: WorkspaceRow): MountRow {
    const mountRow = this.#selectAttachedMountStmt.get({
      repo_mount_id: row.repo_mount_id,
    }) as MountRow | undefined;
    if (mountRow === undefined) {
      throw new RepoMountNotFoundError(row.repo_mount_id);
    }
    return mountRow;
  }

  /** Refuse a transition whose predecessor is not in `legalPredecessors`. */
  #refuseIllegalPredecessor(
    row: WorkspaceRow,
    legalPredecessors: readonly WorkspaceState[],
    attemptedAction: string,
  ): void {
    if (legalPredecessors.includes(row.state as WorkspaceState)) {
      return;
    }
    if (row.state === ("busy" satisfies WorkspaceState)) {
      throw new WorkspaceBusyError(row.id, readHoldingRunId(row));
    }
    throw new WorkspaceServiceInvariantError(
      `cannot ${attemptedAction} workspace "${row.id}" in state "${row.state}"`,
      { kind: "illegal_state_transition", workspaceId: row.id },
    );
  }
}

// --------------------------------------------------------------------------
// Module-private helpers
// --------------------------------------------------------------------------

/**
 * The production probe: read the clock, then measure.
 *
 * Clock first so `checkedAt` is never NEWER than the observation it stamps — on
 * a hung network mount the probe can take seconds, and a timestamp taken
 * afterwards would overstate the verdict's freshness in the one case where
 * freshness matters.
 *
 * `probedPath` is the argument, unmodified — the verbatim-probe-subject
 * obligation.
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

// Indirection so the default probe binds the same readability primitive T1.5
// and T1.6 use — one implementation of "can the daemon open this directory?"
const readDirectory: DirectoryReadabilityProbe = DEFAULT_DIRECTORY_READABILITY_PROBE;

/**
 * The two failure classes `#observeState` and `#projectRow` attribute to a row.
 * `Extract` rather than a fresh union, so renaming a member of the parent union
 * breaks here instead of silently narrowing to nothing.
 */
type RowAttributedInvariantKind = Extract<
  WorkspaceServiceInvariantKind,
  "workspace_row_unprojectable" | "stale_transition_durability_failure"
>;

/**
 * Fixed message per attributed failure class. A total `Record` over the union
 * (the `ROOT_RESOLUTION_MESSAGES` discipline in `./repo-errors.js`), so a class
 * added without a message is a compile error rather than an `undefined` one.
 */
const ROW_FAILURE_MESSAGES: Record<RowAttributedInvariantKind, string> = {
  workspace_row_unprojectable: "cannot be projected onto the workspace list response",
  stale_transition_durability_failure: "derived a stale transition that could not be made durable",
};

/**
 * Attribute a per-row failure to its workspace, leaving an already-attributed
 * one alone.
 *
 * The pass-through is what keeps the discriminant honest: `#observeState` labels
 * a failed stale write `stale_transition_durability_failure`, and a second wrap
 * one layer out would relabel it `workspace_row_unprojectable` — sending an
 * operator to inspect the very row the inner layer just found healthy.
 */
function wrapRowFailure(
  error: unknown,
  workspaceId: string,
  kind: RowAttributedInvariantKind,
): WorkspaceServiceInvariantError {
  if (error instanceof WorkspaceServiceInvariantError) {
    return error;
  }
  return new WorkspaceServiceInvariantError(
    `workspace "${workspaceId}" ${ROW_FAILURE_MESSAGES[kind]}`,
    { kind, workspaceId, cause: error },
  );
}

/**
 * Refuse an execution root that does not name ONE COMPLETE LOCATION (CP-009-8).
 *
 * The vocabulary is `./repo-errors.js`'s `not_absolute`, and so is the rule:
 * what disqualifies a candidate is needing a piece of the daemon's own context
 * to become concrete. A relative path wants a working directory; `~` wants a
 * home directory; a driveless Windows root such as `\repos\app` wants a drive.
 *
 * That last case is why this is NOT `node:path.isAbsolute` semantics —
 * `path.win32.isAbsolute("\\repos\\app")` reports `true`, and adopting it would
 * admit a root that Plan-012 would then scope approvals against on whichever
 * drive the tool process happened to be running from. Drive-absolute (`C:\`,
 * `C:/`) and UNC (`\\server\share`) forms ARE complete and are accepted.
 */
function assertAbsoluteExecutionRoot(candidate: string, workspaceId: string | null): void {
  if (namesOneCompleteLocation(candidate)) {
    return;
  }
  // The candidate is NOT echoed. The IPC sanitizer redacts only the
  // absolute-form path shapes — exactly the forms this guard accepts — so a
  // rejected relative or `~` candidate would survive redaction verbatim,
  // against this module's no-path-echo posture. The structured detail already
  // attributes the refusal.
  throw new WorkspaceServiceInvariantError(
    "execution root does not name one complete location; the daemon would have to supply the missing piece from its own context",
    { kind: "non_absolute_execution_root", workspaceId },
  );
}

// The three complete forms, and only those: POSIX absolute (`/repos/app`),
// Windows drive-absolute (`C:\repos\app`, `C:/repos/app`), and UNC
// (`\\server\share`). A single leading backslash is deliberately absent — that
// is the driveless root the doc above refuses.
//
// Spelled out rather than imported from `node:path` for two reasons: that
// module's `isAbsolute` is the wrong predicate (see above), and its behaviour
// is platform-dependent, so a POSIX-format root stored by one machine would
// stop being recognised when the same database is read on another. The daemon's
// database is portable even when its filesystem is not.
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

function namesOneCompleteLocation(candidate: string): boolean {
  return ABSOLUTE_PATH_PATTERN.test(candidate);
}

/**
 * Assert a compare-and-swap moved exactly one row.
 *
 * Called from inside a `transactionalPrelude`, where a throw aborts the
 * transaction and takes the event row with it — which is the point. A row that
 * moved between the read and the write must not produce a state/event pair that
 * disagree (I-009-9). Precedent: `../node/node-capability-service.js` re-checks
 * and throws in its own prelude for the same reason.
 *
 * `movedSubject` names WHICH row failed the predicate, because it is not always
 * the workspace: `bind`'s conditional insert is guarded on the repo mount's
 * attachment, and a message blaming the workspace for that would send a reader
 * to a row that does not exist yet.
 */
function assertSingleRowChanged(
  result: { readonly changes: number },
  workspaceId: string,
  attemptedAction: string,
  movedSubject: string = "it",
): void {
  if (result.changes !== 1) {
    throw new WorkspaceServiceInvariantError(
      `cannot ${attemptedAction} workspace "${workspaceId}": ${movedSubject} left its expected state before the write committed`,
      { kind: "illegal_state_transition", workspaceId },
    );
  }
}

/**
 * Read one string key out of a row's `metadata` blob.
 *
 * Non-string values and unparseable blobs read as `null` rather than throwing —
 * for `holdingRunId` this degrades a diagnostic, and the `lastError` path is
 * already inside `list`'s per-row wrapper where the corruption surfaces with
 * attribution if the value is unrepresentable.
 */
function readMetadataString(row: WorkspaceRow, key: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readLastError(row: WorkspaceRow): string | null {
  return readMetadataString(row, "lastError");
}

function readHoldingRunId(row: WorkspaceRow): string | null {
  return readMetadataString(row, "holdingRunId");
}
