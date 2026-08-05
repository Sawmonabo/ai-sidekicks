// Repo-mount + workspace lifecycle event emission — the single seam every
// Plan-009 Phase-2 state transition appends its event through.
//
// Spec coverage:
//   • `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`
//     — the six event types this module owns: `repo.attached`,
//     `repo.detached`, `workspace.provisioning`, `workspace.ready`,
//     `workspace.stale`, `workspace.archived`. The same family's five
//     `worktree.*` members are Plan-010's and are deliberately absent here.
//   • `Spec-009 §State And Data Implications` — the repo-mount and workspace
//     rows whose transitions these events witness.
//   • `Spec-009 §Detach Semantics (V1 Definition)` — the detach cascade, the
//     one flow that emits a `workspace.archived` naming BOTH a workspace and
//     the repo mount whose detach caused it.
//
// Invariants carried here:
//   • I-009-9 — every repo-mount / workspace state transition appends its
//     matching `session_lifecycle` event exactly once. This module carries
//     the EMITTER-SIDE half: each method constructs one envelope and appends
//     exactly once (no retry, no fan-out), so "exactly once" is a property
//     of the call, not of a dedupe check somewhere downstream. The "every
//     transition" universal is the producers' half — T2.3/T2.4 are specified
//     to route each transition through this seam as its only entry point,
//     holding no envelope-construction code of their own, and T2.6's
//     integration pass is what closes that quantifier over code that exists.
//     Two states the payload vocabulary
//     admits have no emit method here, both deliberate: workspace `busy` is
//     carved out by CP-009-7 (the T2.4 busy/release transitions write the
//     state column with no dedicated event type, per the closed-registry
//     posture), and mount `archived` has no registered Spec-006 event type
//     and no Plan-009 task that drives the transition.
//
// Three things this module deliberately does NOT do:
//
//   • It never computes a sequence number, chain hash, or signature. The
//     Plan-006 append path owns every integrity primitive; this seam hands it
//     a sequence-free envelope and reads back the receipt it assigned. There
//     is no second write path to keep in step.
//
//   • It never accepts a `state` from its caller. Each of the six Spec-006
//     types names exactly ONE post-transition state, so the state is a
//     property of the method you call, resolved from the tables below. An
//     out-of-vocabulary state, or a state paired with the wrong type, is
//     therefore unrepresentable rather than merely rejected at parse time —
//     a strictly stronger position than validating a caller-supplied state,
//     because a `repo.attached` carrying `state: "detached"` would parse
//     clean (both are `RepoMountState` members) and persist a lying row.
//
//   • It never checks the RESOLVED append receipt's shape, only that the
//     seam returned something awaitable (see the tripwire in the shared
//     append below). Nothing here reads a field off the receipt or feeds it
//     to an integrity computation — it is returned unexamined — so the
//     compile-time `Promise<EventLogAppendReceipt>` on the seam plus the
//     thenable guard is the whole contract. A seam wired past the compiler
//     that resolves to a malformed receipt would surface at whoever reads
//     the receipt, not here.
//
// Refs: Plan-009 (repo attachment and workspace binding), Plan-006 (the
// append path and the type → category registry), CP-009-4 (the payload
// schema and the union registration this seam consumes).

import { randomUUID } from "node:crypto";

import {
  EventEnvelopeVersionSchema,
  RepoWorkspaceLifecyclePayloadSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  type EventCategory,
  type EventEnvelopeVersion,
  type RepoAttachedEvent,
  type RepoDetachedEvent,
  type RepoMountState,
  type RepoWorkspaceLifecyclePayload,
  type WorkspaceArchivedEvent,
  type WorkspaceProvisioningEvent,
  type WorkspaceReadyEvent,
  type WorkspaceStaleEvent,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../events/event-log-service.js";

// --------------------------------------------------------------------------
// Event names — type-bound to the contracts variants, never re-spelled as
// bare string literals in a type position.
// --------------------------------------------------------------------------
//
// Contracts exports no `RepoWorkspaceEventName` union (unlike runtime-node's
// `RuntimeNodeEventName`), so the names are recovered by indexed access on
// the six registered variant interfaces — the same idiom event-log-service.ts
// uses for `EventShreddedEvent["type"]`. A rename or removal in
// `@ai-sidekicks/contracts` fails THIS module's compile rather than silently
// leaving an emitter that writes a type the strict layer can no longer
// interpret. The literals widen losslessly into `EventEnvelope.type`, which
// is deliberately `string` (the version-tolerant carrier).

type RepoMountEventName = RepoAttachedEvent["type"] | RepoDetachedEvent["type"];

type WorkspaceEventName =
  | WorkspaceProvisioningEvent["type"]
  | WorkspaceReadyEvent["type"]
  | WorkspaceStaleEvent["type"]
  | WorkspaceArchivedEvent["type"];

type RepoWorkspaceEventName = RepoMountEventName | WorkspaceEventName;

// --------------------------------------------------------------------------
// Type → post-transition state. The pairing, in one place.
// --------------------------------------------------------------------------
//
// `Record<...EventName, ...State>` makes each table TOTAL over its half of
// the family (a name added to contracts and not paired here fails the build)
// and confines its values to that half's state vocabulary — a workspace event
// cannot be paired with `"attached"`, and a repo-mount event cannot be paired
// with `"provisioning"`, because neither is a member of the other's union.
// `RepoMountState` and `WorkspaceState` overlap only on `"archived"`, which
// both halves legitimately use.
//
// Splitting the family in two rather than keeping one table is what buys that
// second guarantee: a single `Record<RepoWorkspaceEventName, RepoMountState |
// WorkspaceState>` would accept `"workspace.ready": "detached"`.

const MOUNT_STATE_BY_EVENT_NAME = {
  "repo.attached": "attached",
  "repo.detached": "detached",
} as const satisfies Record<RepoMountEventName, RepoMountState>;

const WORKSPACE_STATE_BY_EVENT_NAME = {
  "workspace.provisioning": "provisioning",
  "workspace.ready": "ready",
  "workspace.stale": "stale",
  "workspace.archived": "archived",
} as const satisfies Record<WorkspaceEventName, WorkspaceState>;

// The `EventEnvelope` version for repo-mount / workspace lifecycle events —
// semver MAJOR.MINOR per ADR-018, matching the daemon's existing convention.
//
// Minted THROUGH the schema rather than cast, because `EventEnvelope.version`
// is the branded `EventEnvelopeVersion` and the brand is what the canonical
// bytes carry. Parsing at module load means a literal that stopped satisfying
// the version pattern throws at import — in every consumer, in every test run
// — rather than at the first emit against a real chain. Handed to `parse`
// UNCAST: `parse` takes `unknown`, so a cast would suppress the type error
// that catches a wrong-typed input, not enable one.
const REPO_WORKSPACE_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// Enforcement for the widening at `#appendLifecycleEvent` below, whose
// rationale rests on `RepoWorkspaceLifecyclePayload` being an object TYPE
// ALIAS (contracts declares it that way, and says so): TypeScript grants such
// an alias an implicit index signature and grants an `interface` none. A cast
// alone would NOT catch a regression — `as` requires only comparability, so a
// flip back to `interface` keeps the cast compiling and silently falsifies
// the comment there. Assignability is the discriminating check, so the flip
// turns this line red in the file that makes the claim. Same `_AssertExtends`
// idiom as node-event-emitter.ts and contracts' event-core.ts; the `_` prefix
// is what the root eslint config's `varsIgnorePattern` exempts from
// `no-unused-vars`.
type _AssertExtends<A extends B, B> = A;
type _LifecyclePayloadCarriesIndexSignature = _AssertExtends<
  RepoWorkspaceLifecyclePayload,
  Record<string, unknown>
>;

// --------------------------------------------------------------------------
// Injected dependencies
// --------------------------------------------------------------------------

/**
 * The durable session-event log this emitter appends to. Structural on
 * purpose — it names no concrete class, and it is typed against the append
 * path's OWN parameter and return types so a signature change there fails
 * THIS compile rather than drifting. Declared locally rather than imported
 * from the runtime-node emitter's identically-shaped seam: sharing that
 * export would create a Plan-003 → Plan-009 module edge no plan declares,
 * for a three-line interface.
 *
 * ASYNC-TRANSACTIONAL BY CONTRACT. The append path awaits a signing-key
 * unseal, and a better-sqlite3 transaction cannot span an `await` — so a
 * producer that must commit a table write ATOMICALLY with its event row does
 * not open its own transaction. It hands that write down as
 * `transactionalPrelude`, which the append path runs inside the SAME
 * transaction as the event-row INSERT, immediately before it. That is the
 * mechanism I-009-9 rests on for the Plan-009 producers: a throwing INSERT
 * rolls the row write back, and a refusal before the transaction opens means
 * the prelude never runs at all.
 */
export interface WorkspaceEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

export interface WorkspaceEventEmitterDeps {
  // The durable append seam — see `WorkspaceEventLog` above. The narrow
  // structural type documents the exact surface consumed and lets tests pass
  // a plain fake.
  readonly sessionEvents: WorkspaceEventLog;

  // Monotonic clock for `monotonic_ns` (within-daemon ordering only; the
  // replay key is `sequence`). Injectable so tests can drive values THROUGH
  // this emitter without reaching past it. Defaults to
  // `process.hrtime.bigint()`.
  readonly monotonicNow?: () => bigint;

  // Wall-clock source for `occurredAt` (ISO 8601; display + audit).
  // Injectable for deterministic tests. Defaults to
  // `new Date().toISOString()`.
  readonly now?: () => string;

  // Event-id source for the `session_events.id` primary key, which carries no
  // format constraint. `crypto.randomUUID()` is the established daemon id
  // idiom and the production default; injectable so deterministic tests can
  // supply a counter (a CONSTANT id would collide on the primary key across
  // successive emits).
  readonly newEventId?: () => string;
}

// --------------------------------------------------------------------------
// Per-method inputs — bespoke typed shapes, NOT the contract payload object.
// --------------------------------------------------------------------------
//
// Taking discrete fields rather than the payload object is what lets this
// seam RECONCILE the fields the envelope and the payload both carry. The
// caller supplies `sessionId` and `actor` once; the emitter fans each into
// both places from that single value, so the two cannot disagree — an
// asymmetry no amount of payload validation would catch, since a payload
// naming one session inside an envelope naming another is well-formed on
// both sides.
//
// Two shapes rather than six: the six events divide cleanly by SUBJECT, and
// which optional id a payload carries is what identifies that subject
// (`Spec-009 §State And Data Implications`). Six aliases over two shapes
// would name the same distinction twice.

// Shared envelope-level inputs every emit method carries.
interface WorkspaceEventEmitBase {
  // REQUIRED here even though the payload schema types the field optional —
  // the daemon always populates it, and it is the append path's
  // sequence-allocation partition key. Plain `string`: the branded
  // `SessionId` is assignable to it, and the payload schema below does the
  // branding, so producers holding either form pass uncast.
  readonly sessionId: string;
  // Envelope free-form actor (`participant_id | agent_id | null`). Optional;
  // defaults to `null` (system actor). This seam encodes no actor policy —
  // the producers decide whether a transition is participant-, agent-, or
  // system-driven.
  readonly actor?: string | null;
  // Optional envelope linkage fields. The detach cascade uses them to tie
  // each dependent `workspace.archived` back to the `repo.detached` that
  // caused it (`Spec-009 §Detach Semantics (V1 Definition)`).
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  // A SYNCHRONOUS durable write to commit ATOMICALLY with this event row,
  // threaded straight through to the append path — which runs it inside the
  // same transaction as the INSERT, immediately before it. The constraints on
  // what may go in one (synchronous, same connection, writes only) are
  // documented on `EventLogAppendOptions.transactionalPrelude`; this seam
  // only forwards it.
  readonly transactionalPrelude?: () => void;
}

/** Input for the two repo-mount lifecycle events. */
export interface EmitRepoMountEventInput extends WorkspaceEventEmitBase {
  // The mount this event describes. Required: a repo-mount event whose
  // subject is unidentified is not interpretable.
  readonly repoMountId: string;
}

/** Input for the four workspace lifecycle events. */
export interface EmitWorkspaceEventInput extends WorkspaceEventEmitBase {
  // The workspace this event describes. Required, for the same reason.
  readonly workspaceId: string;
  // The mount this workspace binds to. Optional, and populated by the detach
  // cascade: a `workspace.archived` caused by a `repo.detached` legitimately
  // names both ids, and a reader that only knows the mount would otherwise
  // have no way to attribute the archival.
  readonly repoMountId?: string;
}

// --------------------------------------------------------------------------
// Seam guard
// --------------------------------------------------------------------------

/**
 * Structural thenable test for the fail-closed guard in the shared append.
 * Deliberately shape-based rather than `instanceof Promise`: a conforming
 * implementation may return any thenable, and the failure this catches is a
 * SYNCHRONOUS one.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
}

// --------------------------------------------------------------------------
// WorkspaceEventEmitter
// --------------------------------------------------------------------------

export class WorkspaceEventEmitter {
  readonly #sessionEvents: WorkspaceEventLog;
  readonly #monotonicNow: () => bigint;
  readonly #now: () => string;
  readonly #newEventId: () => string;

  constructor(deps: WorkspaceEventEmitterDeps) {
    this.#sessionEvents = deps.sessionEvents;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newEventId = deps.newEventId ?? (() => randomUUID());
  }

  /**
   * Emit `repo.attached` — a local path was admitted as a durable repo mount
   * (`Spec-009 §Required Behavior`). Resolves to the append receipt so the
   * producer can read the `sequence` the append path ASSIGNED rather than one
   * this emitter guessed.
   */
  async emitRepoAttached(input: EmitRepoMountEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendRepoMountEvent("repo.attached", input);
  }

  /**
   * Emit `repo.detached` — the mount left the session's active set. The
   * cascade's dependent `workspace.archived` events are separate emits the
   * producer makes explicitly; this method appends one event and only one.
   */
  async emitRepoDetached(input: EmitRepoMountEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendRepoMountEvent("repo.detached", input);
  }

  /** Emit `workspace.provisioning` — the workspace's materialization began. */
  async emitWorkspaceProvisioning(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.provisioning", input);
  }

  /** Emit `workspace.ready` — the workspace is usable for execution. */
  async emitWorkspaceReady(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.ready", input);
  }

  /**
   * Emit `workspace.stale` — the workspace no longer reflects its mount and
   * needs reprovisioning before further use.
   */
  async emitWorkspaceStale(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.stale", input);
  }

  /**
   * Emit `workspace.archived` — the workspace reached its terminal state.
   * Pass `repoMountId` when the archival is a detach cascade's dependent
   * transition (`Spec-009 §Detach Semantics (V1 Definition)`).
   */
  async emitWorkspaceArchived(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.archived", input);
  }

  // ------------------------------------------------------------------------
  // Internal — payload construction per subject half
  // ------------------------------------------------------------------------

  async #appendRepoMountEvent(
    type: RepoMountEventName,
    input: EmitRepoMountEventInput,
  ): Promise<EventLogAppendReceipt> {
    const payload: RepoWorkspaceLifecyclePayload = RepoWorkspaceLifecyclePayloadSchema.parse({
      sessionId: input.sessionId,
      repoMountId: input.repoMountId,
      state: MOUNT_STATE_BY_EVENT_NAME[type],
      actor: input.actor ?? null,
    });
    return this.#appendLifecycleEvent(type, input, payload);
  }

  async #appendWorkspaceEvent(
    type: WorkspaceEventName,
    input: EmitWorkspaceEventInput,
  ): Promise<EventLogAppendReceipt> {
    const payload: RepoWorkspaceLifecyclePayload = RepoWorkspaceLifecyclePayloadSchema.parse({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      // Omitted outright when the caller supplies none, rather than passed as
      // an explicit `undefined`: today every serializer downstream of the
      // append seam drops present-undefined members anyway (the canonicalizer
      // and the payload column's JSON.stringify alike), so the two shapes are
      // byte-identical in storage — omission is the one that stays correct if
      // that treatment ever changes, and it reads unambiguously as "this
      // event names no mount".
      ...(input.repoMountId !== undefined ? { repoMountId: input.repoMountId } : {}),
      state: WORKSPACE_STATE_BY_EVENT_NAME[type],
      actor: input.actor ?? null,
    });
    return this.#appendLifecycleEvent(type, input, payload);
  }

  // ------------------------------------------------------------------------
  // Internal — shared envelope construction + append
  // ------------------------------------------------------------------------

  /**
   * Construct the envelope from the VALIDATED payload plus the shared
   * envelope inputs, and route it through the injected append seam. The
   * parsed payload is what persists — not the caller's input object — so
   * storage reflects the schema's normalized shape, and the envelope's
   * `sessionId` and `actor` are read back off that same parsed object rather
   * than re-derived from the input, which is what makes the reconciliation
   * structural instead of a convention two call sites must both honor.
   */
  async #appendLifecycleEvent(
    type: RepoWorkspaceEventName,
    base: WorkspaceEventEmitBase,
    payload: RepoWorkspaceLifecyclePayload,
  ): Promise<EventLogAppendReceipt> {
    // Looked up, never spelled as a literal. The registry is the one place
    // the type → category bijection is asserted (I-006-1-01), and the strict
    // layer refuses an envelope whose category disagrees with its type — so a
    // hardcoded `"session_lifecycle"` here would be a second, unchecked copy
    // of a fact that already has an owner.
    const category: EventCategory | undefined = SESSION_EVENT_CATEGORY_BY_TYPE.get(type);
    if (category === undefined) {
      throw new Error(
        `No category is registered for event type "${type}": the repo-mount / workspace ` +
          "lifecycle types must be present in SESSION_EVENT_CATEGORY_BY_TYPE for the strict " +
          "layer to interpret what this emitter writes.",
      );
    }
    const envelope: UnsequencedEventEnvelope = {
      id: this.#newEventId(),
      // Taken from the PARSED payload, which is where the branding happened.
      // A second `SessionIdSchema.parse` of the raw input would be a second
      // chance to disagree; reading the parsed value cannot.
      sessionId: payload.sessionId,
      occurredAt: this.#now(),
      category,
      type,
      // Same reconciliation: the payload's actor already went through the
      // schema's normalization, so envelope and payload carry one value.
      actor: payload.actor ?? null,
      // Safe specific→general widening — every field is assignable to
      // `unknown` — and ENFORCED, not narrated, by the
      // `_LifecyclePayloadCarriesIndexSignature` pin above.
      payload: payload as Record<string, unknown>,
      // Absent, not null: `EventEnvelope` types the correlation pair
      // `?: string | undefined` — optional and NOT nullable — because absent
      // is that pair's only no-value wire state (`actor` alone carries the
      // null-for-system convention). Under `exactOptionalPropertyTypes` an
      // explicit `undefined` is not assignable either, so the key is omitted
      // outright when the caller supplies none.
      ...(base.correlationId != null ? { correlationId: base.correlationId } : {}),
      ...(base.causationId != null ? { causationId: base.causationId } : {}),
      version: REPO_WORKSPACE_EVENT_VERSION,
    };
    const appendResult: Promise<EventLogAppendReceipt> = this.#sessionEvents.append(envelope, {
      monotonicNs: this.#monotonicNow(),
      // Forwarded only when supplied. `EventLogAppendOptions` declares it
      // optional under `exactOptionalPropertyTypes`, so an explicit
      // `transactionalPrelude: undefined` would not type-check.
      ...(base.transactionalPrelude !== undefined
        ? { transactionalPrelude: base.transactionalPrelude }
        : {}),
    });
    // Fail-closed SYNCHRONOUS-append tripwire, backstopping the seam's
    // compile-time `Promise` return for wiring the compiler never saw (plain
    // JS, `as unknown as` casts). A synchronous `append` reaching here means
    // the write did not run under the per-session lock, its failure cannot be
    // awaited, and — the part no compile-time check would catch — the
    // producer's `transactionalPrelude` never ran inside a transaction with
    // the event row, silently undoing the attach/detach dual-write atomicity
    // I-009-9 depends on. A tripwire, not a recovery path: by the time we
    // look, the implementation's work has already happened. It exists to make
    // such wiring LOUD on the first emit any test exercises, rather than
    // report success over a half-written pair. No cast: `isThenable` already
    // takes `unknown`, and a runtime check reads whatever value the seam
    // actually returned — the variable's declared `Promise` type is exactly
    // the claim this guard exists to distrust, not a reason to delete it.
    if (!isThenable(appendResult)) {
      throw new Error(
        "WorkspaceEventLog.append did not return a promise: this seam is async-transactional " +
          "(the Plan-006 append path serializes on the per-session append lock and runs the " +
          "caller's transactionalPrelude inside the same transaction as the event row). A " +
          "synchronous append reports success before the write is durable and never commits " +
          "the prelude atomically with the row.",
      );
    }
    const receipt: EventLogAppendReceipt = await appendResult;
    return receipt;
  }
}
