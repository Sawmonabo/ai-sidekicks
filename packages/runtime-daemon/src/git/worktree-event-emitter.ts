// Worktree lifecycle event emission — the single seam every Plan-010 Phase-2
// worktree state transition appends its event through.
//
// Spec coverage:
//   • `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`
//     — the five event types this module owns: `worktree.created`,
//     `worktree.ready`, `worktree.dirty`, `worktree.merged`,
//     `worktree.retired`. The same family's six repo-mount / workspace members
//     are Plan-009's and are deliberately absent here (they live in
//     `workspace/workspace-event-emitter.ts`, the precedent this module
//     instantiates for the worktree domain).
//   • `Spec-010 §Resolved Questions and V1 Scope Decisions` — "worktree and
//     ephemeral-clone state transitions are not separately evented in V1
//     beyond the worktree lifecycle events already registered in the Spec-006
//     taxonomy; the `failed` transition and all ephemeral-clone transitions
//     surface through the owning workspace's lifecycle events
//     (`workspace.stale` carries the failure detail) … The Spec-006
//     event-type registry stays closed." That decision is the whole reason
//     this module exposes FIVE emit surfaces over a SIX-state row vocabulary,
//     and no ephemeral-clone surface at all.
//   • `Spec-010 §State And Data Implications` — the `worktrees` rows whose
//     transitions these events witness.
//
// Invariants carried here:
//   • I-010-13 — exactly-once events: each worktree transition emits its
//     D-010-12-mapped event exactly once, transactionally with the row write;
//     `failed` deliberately emits none; clone transitions emit none. This
//     module carries the EMITTER-SIDE half on all three counts: each method
//     constructs one envelope and appends exactly once (no retry, no fan-out),
//     the caller's row write rides down as `transactionalPrelude` so the append
//     path commits it inside the SAME transaction as the event row, and the
//     two no-event carve-outs are unrepresentable here rather than merely
//     unused — there is no `emitFailed` and no clone method to call. The
//     "every transition" universal is the producers' half: T2.2 routes each
//     worktree transition through this seam as its only entry point, holding
//     no envelope-construction code of its own, and T2.6's acceptance walk is
//     what closes that quantifier over code that exists.
//
// ---------------------------------------------------------------------------
// D-010-12 — the event-transition mapping, and D-010-11's carve-out
// ---------------------------------------------------------------------------
//
// Row creation → `worktree.created`; `creating -> ready` → `worktree.ready`;
// `-> dirty` → `worktree.dirty`; `-> merged` → `worktree.merged`;
// `-> retired` → `worktree.retired`; `-> failed` → NONE.
//
// The `-> failed` carve-out (D-010-11) is deliberate and is NOT an omission to
// be "completed" later: the failure incident is already evented as
// `workspace.stale` with `metadata.lastError` by the coupled `failReprovision`
// (single-incident-single-event), failed rows stay queryable through
// `repo.worktreeStatusRead`, and worktree rows are table-sourced rather than
// event-replayed — so nothing downstream reconstructs state from these events.
// `worktree.failed` is not a member of the Spec-006 census at all, so an emit
// surface for it could not produce a row the strict layer would interpret.
// Ephemeral-clone transitions emit nothing for the same reason.
//
// Three things this module deliberately does NOT do:
//
//   • It never computes a sequence number, chain hash, or signature. The
//     Plan-006 append path owns every integrity primitive; this seam hands it
//     a sequence-free envelope and reads back the receipt it assigned. There
//     is no second write path to keep in step.
//
//   • It never accepts a `state` from its caller. Each of the five types names
//     exactly ONE post-transition state, so the state is a property of the
//     method you call, resolved from the table below. A state paired with the
//     wrong type is therefore unrepresentable rather than merely rejected at
//     parse time — a strictly stronger position than validating a
//     caller-supplied state, because a `worktree.retired` carrying
//     `state: "dirty"` would parse clean (both are `WorktreeState` members)
//     and persist a lying row. It is also what keeps `failed` off the wire:
//     `failed` is a member of the ROW vocabulary this payload admits, and the
//     only reason no event can carry it is that no method resolves to it.
//
//   • It never checks the RESOLVED append receipt's shape, only that the seam
//     returned something awaitable (see the tripwire in the shared append
//     below). Nothing here reads a field off the receipt or feeds it to an
//     integrity computation — it is returned unexamined — so the compile-time
//     `Promise<EventLogAppendReceipt>` on the seam plus the thenable guard is
//     the whole contract.
//
// Refs: Plan-010 (worktree lifecycle and execution modes), Plan-009 (the
// emitter precedent and the family payload factory), Plan-006 (the append path
// and the type → category registry), CP-010-5 (the payload schema and the
// union registration this seam consumes), CP-010-7 (this Plan-010-owned
// `src/git/` subtree).

import { randomUUID } from "node:crypto";

import {
  EventEnvelopeVersionSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  WorktreeIdSchema,
  WorktreeLifecyclePayloadSchema,
  type EventCategory,
  type EventEnvelopeVersion,
  type WorktreeCreatedEvent,
  type WorktreeDirtyEvent,
  type WorktreeLifecyclePayload,
  type WorktreeMergedEvent,
  type WorktreeReadyEvent,
  type WorktreeRetiredEvent,
  type WorktreeState,
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
// Contracts exports no `WorktreeEventName` union, so the names are recovered
// by indexed access on the five registered variant interfaces — the same idiom
// workspace-event-emitter.ts uses for its own six. A rename or removal in
// `@ai-sidekicks/contracts` fails THIS module's compile rather than silently
// leaving an emitter that writes a type the strict layer can no longer
// interpret. The literals widen losslessly into `EventEnvelope.type`, which is
// deliberately `string` (the version-tolerant carrier).

type WorktreeEventName =
  | WorktreeCreatedEvent["type"]
  | WorktreeReadyEvent["type"]
  | WorktreeDirtyEvent["type"]
  | WorktreeMergedEvent["type"]
  | WorktreeRetiredEvent["type"];

/**
 * The five states a `worktree.*` event can carry — the row vocabulary MINUS
 * `failed`, derived rather than re-spelled so it stays bound to the contract
 * enum (drop a member from `WorktreeState` and the table below stops
 * compiling). Module-private: nothing downstream consumes an "evented states"
 * name, and exporting one would pre-commit every importer to a symbol neither
 * the plan nor the spec asked for.
 */
type EventedWorktreeState = Exclude<WorktreeState, "failed">;

// --------------------------------------------------------------------------
// Type → post-transition state. The D-010-12 mapping, in one place.
// --------------------------------------------------------------------------
//
// `Record<WorktreeEventName, EventedWorktreeState>` makes the table TOTAL over
// the family (a name added to contracts and not paired here fails the build)
// and — the part that carries D-010-11 at COMPILE time — confines its values
// to the five evented states. Annotating the values `WorktreeState` would have
// admitted `"worktree.retired": "failed"`; the `Exclude` is what turns "no
// worktree event carries `failed`" from a test-only claim into a property of
// the table.
//
// The pairing agrees with the fixtures contracts already ships
// (`STANDALONE_WORKTREE_EVENT_SCHEMAS` in
// `packages/contracts/src/__tests__/worktree.test.ts` pairs the same five, and
// its union arms reject a `worktree.created` carrying a Plan-009 state), so
// this is a mapping two surfaces hold rather than a local convention.
const WORKTREE_STATE_BY_EVENT_NAME = {
  "worktree.created": "creating",
  "worktree.ready": "ready",
  "worktree.dirty": "dirty",
  "worktree.merged": "merged",
  "worktree.retired": "retired",
} as const satisfies Record<WorktreeEventName, EventedWorktreeState>;

// The `EventEnvelope` version for worktree lifecycle events — semver
// MAJOR.MINOR per ADR-018, matching the daemon's existing convention and the
// `1.0` the sibling repo/workspace emitter writes for the same family.
//
// Minted THROUGH the schema rather than cast, because `EventEnvelope.version`
// is the branded `EventEnvelopeVersion` and the brand is what the canonical
// bytes carry. Parsing at module load means a literal that stopped satisfying
// the version pattern throws at import — in every consumer, in every test run
// — rather than at the first emit against a real chain. Handed to `parse`
// UNCAST: `parse` takes `unknown`, so a cast would suppress the type error
// that catches a wrong-typed input, not enable one.
//
// Minted LOCALLY rather than imported from workspace-event-emitter.ts (which
// holds an identical constant): that module is Plan-009's, T2.1's declared
// consumes are `EventLogService` + contracts only, and a shared version
// constant would assert a lockstep neither plan owes the other — the same
// reasoning the precedent gives for declaring its own append-seam interface
// instead of importing runtime-node's identically-shaped one.
const WORKTREE_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// Enforcement for the widening at `#appendWorktreeEvent` below, whose
// rationale rests on `WorktreeLifecyclePayload` being an object TYPE ALIAS
// (contracts declares it that way, and says so): TypeScript grants such an
// alias an implicit index signature and grants an `interface` none. A cast
// alone would NOT catch a regression — `as` requires only comparability, so a
// flip back to `interface` keeps the cast compiling and silently falsifies the
// comment there. Assignability is the discriminating check, so the flip turns
// this line red in the file that makes the claim. Same `_AssertExtends` idiom
// as workspace-event-emitter.ts and contracts' event-core.ts; the `_` prefix is
// what the root eslint config's `varsIgnorePattern` exempts from
// `no-unused-vars`.
type _AssertExtends<A extends B, B> = A;
type _WorktreePayloadCarriesIndexSignature = _AssertExtends<
  WorktreeLifecyclePayload,
  Record<string, unknown>
>;

// The mapping is also SURJECTIVE onto the evented states: every one of the
// five is produced by some method. Totality alone would not catch a mis-keyed
// duplicate — a table pairing both `worktree.dirty` and `worktree.merged` with
// `"dirty"` stays total and stops any producer from ever emitting `merged`.
// This line is what fails on that edit.
type _EveryEventedStateIsReachable = _AssertExtends<
  EventedWorktreeState,
  (typeof WORKTREE_STATE_BY_EVENT_NAME)[WorktreeEventName]
>;

// --------------------------------------------------------------------------
// Injected dependencies
// --------------------------------------------------------------------------

/**
 * The durable session-event log this emitter appends to. Structural on
 * purpose — it names no concrete class, and it is typed against the append
 * path's OWN parameter and return types so a signature change there fails THIS
 * compile rather than drifting. Declared locally rather than imported from the
 * Plan-009 emitter's identically-shaped seam: sharing that export would create
 * a module edge T2.1's declared consumes do not carry, for a three-line
 * interface.
 *
 * ASYNC-TRANSACTIONAL BY CONTRACT. The append path awaits a signing-key
 * unseal, and a better-sqlite3 transaction cannot span an `await` — so a
 * producer that must commit a `worktrees` row write ATOMICALLY with its event
 * row does not open its own transaction. It hands that write down as
 * `transactionalPrelude`, which the append path runs inside the SAME
 * transaction as the event-row INSERT, immediately before it. That is the
 * mechanism I-010-13's "transactionally with the row write" rests on: a
 * throwing INSERT rolls the row write back, and a refusal before the
 * transaction opens means the prelude never runs at all.
 */
export interface WorktreeEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

export interface WorktreeEventEmitterDeps {
  // The durable append seam — see `WorktreeEventLog` above. The narrow
  // structural type documents the exact surface consumed and lets tests pass a
  // plain fake.
  readonly sessionEvents: WorktreeEventLog;

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
// Per-method input — one bespoke typed shape, NOT the contract payload object.
// --------------------------------------------------------------------------

/**
 * Input for all five worktree lifecycle events.
 *
 * ONE shape, not five aliases: the five events share a single SUBJECT (the
 * worktree), so the two-shape split the Plan-009 precedent needed — where the
 * six events divide by subject between mounts and workspaces — collapses here.
 *
 * Taking discrete fields rather than the payload object is what lets this seam
 * RECONCILE the fields the envelope and the payload both carry. The caller
 * supplies `sessionId` and `actor` once; the emitter fans each into both places
 * from that single value, so the two cannot disagree — an asymmetry no amount
 * of payload validation would catch, since a payload naming one session inside
 * an envelope naming another is well-formed on both sides.
 */
export interface EmitWorktreeEventInput {
  // REQUIRED even though the payload schema types the field optional — the
  // daemon always populates it, and it is the append path's
  // sequence-allocation partition key. Plain `string`: the branded `SessionId`
  // is assignable to it, and the payload schema below does the branding, so
  // producers holding either form pass uncast.
  readonly sessionId: string;
  // The worktree this event describes. REQUIRED on every one of the five —
  // D-010-12's emitter obligation, restated in `WorktreeLifecyclePayload`'s own
  // doc comment: `worktreeId` is populated on every `worktree.*` emission. The
  // family schema leaves it optional because subject-id presence is per-type
  // emitter discipline enforced at the `.parse()` boundary, not a family shape
  // rule — this interface is where that discipline is declared, and the
  // `WorktreeIdSchema.parse` in `#appendWorktreeEvent` is where it is ENFORCED
  // at runtime, so a producer wired past the compiler cannot persist a
  // subjectless row either. Plain `string` for the same reason as `sessionId`:
  // the branded `WorktreeId` is assignable, and both parse the same canonical
  // UUID.
  readonly worktreeId: string;
  // The mount this worktree is a checkout OF. Optional, and populated whenever
  // the emitting producer carries the association — the worktree service holds
  // it (`worktrees.repo_mount_id` is NOT NULL), so its emissions name it. NOT
  // required: what every emission guarantees is the `worktreeId` + `sessionId`
  // floor, and a producer that does not hold the mount must not be forced to
  // re-read one just to event.
  readonly repoMountId?: string;
  // The workspace whose execution root this worktree serves. Optional for the
  // same reason and with a sharper case: the worktree service's `create` seam
  // takes no `workspaceId` at all — the workspace association lives one layer
  // up, in the execution-root orchestrator — so a required field here would be
  // unsatisfiable by this seam's first producer.
  readonly workspaceId?: string;
  // Envelope free-form actor (`participant_id | agent_id | null`). Optional;
  // defaults to `null` (system actor). This seam encodes no actor policy — the
  // producers decide whether a transition is participant-, agent-, or
  // system-driven.
  readonly actor?: string | null;
  // Optional envelope linkage fields, for tying an emission back to the
  // event that caused it.
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  // A SYNCHRONOUS durable write to commit ATOMICALLY with this event row,
  // threaded straight through to the append path — which runs it inside the
  // same transaction as the INSERT, immediately before it. This is how
  // I-010-13's "transactionally with the row write" is discharged: the
  // `worktrees` INSERT/UPDATE rides down here rather than running in a
  // transaction of the producer's own. The constraints on what may go in one
  // (synchronous, same connection, writes only) are documented on
  // `EventLogAppendOptions.transactionalPrelude`; this seam only forwards it.
  readonly transactionalPrelude?: () => void;
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
// WorktreeEventEmitter
// --------------------------------------------------------------------------

export class WorktreeEventEmitter {
  readonly #sessionEvents: WorktreeEventLog;
  readonly #monotonicNow: () => bigint;
  readonly #now: () => string;
  readonly #newEventId: () => string;

  constructor(deps: WorktreeEventEmitterDeps) {
    this.#sessionEvents = deps.sessionEvents;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newEventId = deps.newEventId ?? (() => randomUUID());
  }

  /**
   * Emit `worktree.created` — a `worktrees` row was written in state
   * `creating` (D-010-12; `Spec-010 §State And Data Implications`). Resolves to
   * the append receipt so the producer can read the `sequence` the append path
   * ASSIGNED rather than one this emitter guessed.
   */
  async emitWorktreeCreated(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.created", input);
  }

  /**
   * Emit `worktree.ready` — the `creating -> ready` transition: the provisioned
   * checkout is materialized and bindable as an execution root.
   */
  async emitWorktreeReady(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.ready", input);
  }

  /** Emit `worktree.dirty` — uncommitted work was observed in the checkout. */
  async emitWorktreeDirty(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.dirty", input);
  }

  /** Emit `worktree.merged` — the worktree's branch has merged back. */
  async emitWorktreeMerged(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.merged", input);
  }

  /**
   * Emit `worktree.retired` — the worktree reached its terminal state.
   * Recorded and evented BEFORE any disk mutation; cleanup is asynchronous and
   * stamps `cleaned_at` afterwards (I-010-9), so a `retired` event never
   * implies the root is gone.
   */
  async emitWorktreeRetired(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.retired", input);
  }

  // There is deliberately NO `emitFailed` / `emitWorktreeFailed`, and no
  // ephemeral-clone method (D-010-11 / I-010-13). See the header: the failure
  // incident is evented as `workspace.stale` by the coupled `failReprovision`,
  // and `worktree.failed` is not a Spec-006 census member. A producer reaching
  // for one has a `-> failed` transition to record on the ROW, not an event to
  // emit.

  // ------------------------------------------------------------------------
  // Internal — payload construction, envelope construction, append
  // ------------------------------------------------------------------------

  /**
   * Validate the payload at the emission boundary, construct the envelope from
   * the VALIDATED payload, and route it through the injected append seam.
   *
   * The parsed payload is what persists — not the caller's input object — so
   * storage reflects the schema's normalized shape, and the envelope's
   * `sessionId` and `actor` are read back off that same parsed object rather
   * than re-derived from the input, which is what makes the reconciliation
   * structural instead of a convention two call sites must both honor.
   */
  async #appendWorktreeEvent(
    type: WorktreeEventName,
    input: EmitWorktreeEventInput,
  ): Promise<EventLogAppendReceipt> {
    const payload: WorktreeLifecyclePayload = WorktreeLifecyclePayloadSchema.parse({
      sessionId: input.sessionId,
      // Brand-parsed HERE rather than left to the family schema below, which
      // types `worktreeId` OPTIONAL (subject-id presence is per-type emitter
      // discipline, not a family shape rule — worktree.ts). Without this line
      // the field's requiredness would be a COMPILE-time fact only, so a
      // producer wired past the compiler — plain JS, or an `as unknown as`
      // cast — would parse clean and persist a SUBJECTLESS `worktree.*` row,
      // an event no reader could attribute. This gives `worktreeId` the same
      // loud, well-located runtime rejection `sessionId` already gets from the
      // family schema's own required field. The branded output flows into the
      // parse below unchanged: both accept exactly `z.string().uuid()` and
      // neither transforms the value.
      worktreeId: WorktreeIdSchema.parse(input.worktreeId),
      // The two optional associations are OMITTED outright when the caller
      // supplies none, rather than passed as an explicit `undefined`: today
      // every serializer downstream of the append seam drops present-undefined
      // members anyway (the canonicalizer and the payload column's
      // JSON.stringify alike), so the two shapes are byte-identical in storage
      // — omission is the one that stays correct if that treatment ever
      // changes, and it reads unambiguously as "this event names no mount /
      // no workspace".
      ...(input.repoMountId !== undefined ? { repoMountId: input.repoMountId } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      // Resolved from the METHOD, never from the caller — see the header's
      // second "deliberately does NOT do".
      state: WORKTREE_STATE_BY_EVENT_NAME[type],
      actor: input.actor ?? null,
    });

    // Looked up, never spelled as a literal. The registry is the one place the
    // type → category bijection is asserted (I-006-1-01), and the strict layer
    // refuses an envelope whose category disagrees with its type — so a
    // hardcoded `"session_lifecycle"` here would be a second, unchecked copy of
    // a fact that already has an owner.
    const category: EventCategory | undefined = SESSION_EVENT_CATEGORY_BY_TYPE.get(type);
    if (category === undefined) {
      throw new Error(
        `No category is registered for event type "${type}": the worktree lifecycle types must ` +
          "be present in SESSION_EVENT_CATEGORY_BY_TYPE for the strict layer to interpret what " +
          "this emitter writes.",
      );
    }

    const envelope: UnsequencedEventEnvelope = {
      id: this.#newEventId(),
      // Taken from the PARSED payload, which is where the branding happened. A
      // second `SessionIdSchema.parse` of the raw input would be a second
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
      // `_WorktreePayloadCarriesIndexSignature` pin above.
      payload: payload as Record<string, unknown>,
      // Absent, not null: `EventEnvelope` types the correlation pair
      // `?: string | undefined` — optional and NOT nullable — because absent is
      // that pair's only no-value wire state (`actor` alone carries the
      // null-for-system convention). The declared `| undefined` means an
      // explicit `undefined` key would still type-check, so the omission is
      // enforced by the conditional spread below, not by the compiler.
      ...(input.correlationId != null ? { correlationId: input.correlationId } : {}),
      ...(input.causationId != null ? { causationId: input.causationId } : {}),
      version: WORKTREE_EVENT_VERSION,
    };

    const appendResult: Promise<EventLogAppendReceipt> = this.#sessionEvents.append(envelope, {
      monotonicNs: this.#monotonicNow(),
      // Forwarded only when supplied. `EventLogAppendOptions` declares it
      // optional under `exactOptionalPropertyTypes`, so an explicit
      // `transactionalPrelude: undefined` would not type-check.
      ...(input.transactionalPrelude !== undefined
        ? { transactionalPrelude: input.transactionalPrelude }
        : {}),
    });

    // Fail-closed SYNCHRONOUS-append tripwire, backstopping the seam's
    // compile-time `Promise` return for wiring the compiler never saw (plain
    // JS, `as unknown as` casts). A synchronous `append` reaching here means
    // the write did not run under the per-session lock, its failure cannot be
    // awaited, and — the part no compile-time check would catch — the
    // producer's `transactionalPrelude` never ran inside a transaction with the
    // event row, silently undoing the row/event atomicity I-010-13 depends on.
    // A tripwire, not a recovery path: by the time we look, the
    // implementation's work has already happened. It exists to make such wiring
    // LOUD on the first emit any test exercises, rather than report success
    // over a half-written pair. No cast: `isThenable` already takes `unknown`,
    // and a runtime check reads whatever value the seam actually returned — the
    // variable's declared `Promise` type is exactly the claim this guard exists
    // to distrust, not a reason to delete it.
    if (!isThenable(appendResult)) {
      throw new Error(
        "WorktreeEventLog.append did not return a promise: this seam is async-transactional " +
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
