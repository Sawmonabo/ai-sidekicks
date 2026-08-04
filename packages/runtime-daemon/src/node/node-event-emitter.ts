// RuntimeNodeEventEmitter — Plan-003 Phase 2 (T2.3).
//
// The single emission seam that routes every daemon-reachable
// `runtime_node.*` event through the injected durable session-event log
// (the `SessionEventLog` seam below). As shipped (PR #137) the seam was
// typed against Plan-001's `SessionService.append`; decoupled 2026-07-28
// per the `Plan-006 §T3.1 — Append-path service writing integrity columns + Plan-022 Path 1 shred callback` precondition, so the emitter names no
// concrete storage class. RE-POINTED by that same T3.1 leg onto
// `EventLogService.append`, the sole durable production writer — so the
// seam is now ASYNC-TRANSACTIONAL rather than synchronous-transactional
// (see `SessionEventLog` below for the full contract and both of its
// enforcement layers). T2.1's node-registry and T2.2's
// node-capability-service both import this standalone module rather than
// re-implementing event construction, so the two L2 producers cannot
// drift in how they shape, validate, or sequence runtime-node events
// (corrected 2026-06-02, PR #137: a standalone L1 module keeps this
// task's file disjoint from the L2 consumers that import it and the L3
// tasks that extend them).
//
// What this module DOES:
//   * Builds each `runtime_node.*` event as an `AppendableEvent` and routes
//     it through the injected `SessionEventLog.append`.
//   * Validates the payload at the emission boundary with the matching
//     T2.0 payload-shape schema's `.parse()` (the CP-003-1 validation seam,
//     in place of ad-hoc objects). The PARSED output — not the caller's
//     input object — is what gets persisted, so storage always reflects the
//     schema's normalized shape.
//   * Reconciles the two fields that appear in BOTH the envelope and the
//     payload (`sessionId`, `actor`): one input value populates both, so a
//     caller cannot make the envelope and payload disagree. `sessionId` is
//     REQUIRED at this boundary (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` — the daemon always populates
//     the session_id of the attachment a `runtime_node.*` event describes),
//     even though the payload schemas type it `.optional()` to mirror the
//     Spec-006 base.
//   * Threads the caller's `transactionalPrelude` through to the append,
//     so a producer's durable table write commits ATOMICALLY with the
//     event row (see `SessionEventLog` below).
//
// What this module NO LONGER does (moved by T3.1's re-point — do not
// reinstate here):
//   * Allocates the per-session `sequence`. Plan-003's log-derive
//     allocator (`readEvents`, last + 1) and the `nextSequence` injection
//     seam are BOTH gone, and their removal is the point rather than a
//     simplification. That allocator was atomic only because its read and
//     its append were separated by no `await`; the append path is async
//     now, so the same code would let two concurrent emits on one session
//     derive the same number and collide on `UNIQUE(session_id, sequence)`.
//     `EventLogService.append` reads the chain head and writes its
//     successor inside one lock hold, and RETURNS the number it assigned —
//     which is why the emit methods now resolve to a receipt.
//
// What this module does NOT do (deferred — do not add here):
//   * Integrity columns. The injected append path owns them:
//     `EventLogService` computes the real BLAKE3 hash-chain + Ed25519
//     signature over RFC 8785 JCS canonical bytes. This emitter never
//     computes or passes integrity bytes — it passes the envelope fields
//     and the append path owns the rest.
//   * `degraded` / `revoked` constructors. Their producers are server-derived
//     (heartbeat-loss, authority revocation): no V1 party can author them as
//     durable events, so their schemas are V1.1-gated on the node-identity
//     anchor (ADR-017). Phase 2 defines the 5 schema-backed shapes only.
//
// Refs: Plan-003 (Runtime Node Attach) §Phase 2 / T2.3, `Spec-003 §State And Data Implications`
// (capability/trust changes emitted as session events),
// `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` (per-event
// payload shapes), invariant I-003-4 (`monotonic_ns` is
// within-daemon debug data, not the replay key — the replay key is
// `sequence`).

import { randomUUID } from "node:crypto";

import {
  EventEnvelopeVersionSchema,
  RuntimeNodeCapabilityDeclaredPayloadSchema,
  RuntimeNodeCapabilityUpdatedPayloadSchema,
  RuntimeNodeOfflinePayloadSchema,
  RuntimeNodeOnlinePayloadSchema,
  RuntimeNodeRegisteredPayloadSchema,
  SessionIdSchema,
  type EventCategory,
  type EventEnvelopeVersion,
  type RuntimeNodeCapabilityDeclaredPayload,
  type RuntimeNodeCapabilityUpdatedPayload,
  type RuntimeNodeEventName,
  type RuntimeNodeOfflinePayload,
  type RuntimeNodeOnlinePayload,
  type RuntimeNodeRegisteredPayload,
} from "@ai-sidekicks/contracts";

import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../events/event-log-service.js";

// --------------------------------------------------------------------------
// Constants — type-bound to the contracts vocabulary so a future rename or
// removal in `@ai-sidekicks/contracts` fails THIS module's compile rather
// than silently drifting. The values widen losslessly into the
// `AppendableEvent.category` / `.type` `string` fields.
// --------------------------------------------------------------------------

// All 7 `runtime_node.*` names belong to this Plan-001-owned EventCategory
// (the `EventCategory` union + `EventCategorySchema` enum in event.ts).
// Referenced, not redefined.
const RUNTIME_NODE_EVENT_CATEGORY: EventCategory = "runtime_node_lifecycle";

// The EventEnvelope `version` for runtime-node events — semver MAJOR.MINOR
// per ADR-018 §Decision #1, matching Plan-001's existing event convention
// (session-service.test.ts fixtures all carry "1.0").
//
// Minted THROUGH the schema rather than cast, because `EventEnvelope.version`
// is the branded `EventEnvelopeVersion` and the brand is what the canonical
// bytes carry. Parsing at module load means a literal that stopped satisfying
// `EVENT_ENVELOPE_VERSION_PATTERN` throws at import — in every consumer, in
// every test run — rather than at the first emit against a real chain. The
// literal is handed to `parse` UNCAST: `parse` takes `unknown`, so a cast would
// suppress the type error that catches a wrong-typed input, not enable one.
const RUNTIME_NODE_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// --------------------------------------------------------------------------
// Injected dependencies
// --------------------------------------------------------------------------

// The durable session-event log this emitter appends to. Structural on
// purpose — it names no concrete class, per the `Plan-006 §T3.1 — Append-path service writing integrity columns + Plan-022 Path 1 shred callback`
// precondition ("Plan-003's shipped `RuntimeNodeEventEmitter` re-pointed
// off" `SessionService.append`): the two methods are the exact surface
// the emitter consumes, so any implementation satisfies it without a
// nominal dependency.
//
// ASYNC-TRANSACTIONAL BY CONTRACT — the T3.1 re-point INVERTED this seam,
// and the inversion is worth reading carefully because the old contract
// said the exact opposite.
//
// As shipped, the three L2 producers (NodeRegistry.register's dual-write,
// node-capability-service's and driver-capabilities-writer's guarded
// writes) invoked emits INSIDE their own better-sqlite3 transactions, and
// the seam had to be synchronous so a throwing append would roll the
// producer's table write back. That is no longer possible: the durable
// append path awaits a signing-key unseal and, on PII rows, an encrypt —
// and a better-sqlite3 transaction cannot span an `await`.
//
// The atomicity is RE-ESTABLISHED, not dropped, and it moved one level
// down. The producer no longer opens the transaction; it hands its
// durable write to `append` as `options.transactionalPrelude`, which
// `EventLogService` runs inside the SAME transaction as the event-row
// INSERT, immediately BEFORE it. Body order is preserved exactly (durable
// write FIRST, event row LAST), so a throwing INSERT still rolls the
// producer's write back — and a refusal BEFORE the transaction opens (the
// ingest-halt gate, a signing failure) means the prelude never runs at
// all, which is strictly stronger than rollback. The producer wraps its
// read-decide-write in `withSessionAppendLock`, and the nested `append`
// reuses that hold through owner-scoped reentrancy.
//
// Both enforcement layers survive the inversion, negated, and a third
// covers what neither reaches:
//   1. COMPILE TIME: `append` returns `Promise<EventLogAppendReceipt>`.
//      A synchronous implementation returning `undefined` is NOT
//      assignable to a Promise, so it fails at the wiring site instead of
//      silently skipping the await.
//   2. RUNTIME, PRE-AWAIT: `#appendRuntimeNodeEvent` refuses a NON-thenable
//      `append` result fail-closed — the mirror of the old thenable
//      tripwire, for wiring that reaches this seam past the compiler (plain
//      JS, `as unknown as` casts). A synchronous implementation slipping
//      through would report success before anything was durable AND would
//      never run the caller's prelude inside a transaction.
//   3. RUNTIME, POST-AWAIT: `narrowAppendReceipt` checks the RESOLVED
//      value's shape. Layer 2 proves only that something awaitable came
//      back; what it settles to is unconstrained for exactly the wiring
//      layer 1 never saw, and the members are the anchor cadence's inputs.
//
// The seam names no concrete class — it is the exact surface consumed,
// typed against T3.1's own parameter and return types so a signature
// change there fails THIS compile rather than drifting. `readEvents` is
// GONE: it existed only to feed the log-derive sequence allocator, which
// the append path now owns (see the header). Keeping a dead read on the
// seam would oblige every test fake to implement a method nothing calls.
export interface SessionEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

export interface RuntimeNodeEventEmitterDeps {
  // The durable append seam — see `SessionEventLog` above. The narrow
  // structural type documents the exact surface consumed and lets tests
  // pass a plain fake.
  readonly sessionEvents: SessionEventLog;

  // Monotonic clock for `monotonic_ns` (within-daemon ordering only, I-003-4).
  // Injectable so T2.6's D6 can drive non-monotonic values THROUGH this
  // emitter without reaching past it. Defaults to `process.hrtime.bigint()`.
  readonly monotonicNow?: () => bigint;

  // Wall-clock source for `occurredAt` (RFC 3339 UTC; display + audit).
  // Injectable for deterministic tests. Defaults to `new Date().toISOString()`.
  readonly now?: () => string;

  // Event-id source for the `session_events.id` primary key. The column is
  // `TEXT PRIMARY KEY -- ULID or UUID` (0001-initial.ts:68) with NO format
  // constraint, so `crypto.randomUUID()` — the established daemon id idiom
  // (pty/node-pty-host.ts, ipc/streaming-primitive.ts) and a Node builtin —
  // is the production default. Injectable so deterministic tests can supply a
  // counter (a CONSTANT id would collide on the `TEXT PRIMARY KEY` across
  // successive emits). Defaults to `crypto.randomUUID()`.
  readonly newEventId?: () => string;
}

// The union of the 5 daemon-reachable validated payload shapes. Module-local
// (no consumer imports it — T2.1/T2.2 call via the `EmitXInput` types). Used
// to tighten the internal append helper's `payload` parameter from
// `Record<string, unknown>` to "a payload that has already cleared a T2.0
// schema's `.parse()`", so the helper cannot be called with an unvalidated
// object.
type RuntimeNodeEventPayload =
  | RuntimeNodeRegisteredPayload
  | RuntimeNodeOnlinePayload
  | RuntimeNodeOfflinePayload
  | RuntimeNodeCapabilityDeclaredPayload
  | RuntimeNodeCapabilityUpdatedPayload;

// Enforcement for the widening at `#appendRuntimeNodeEvent` below, whose
// rationale rests on every arm being an object TYPE ALIAS (contracts declares
// all five that way): TypeScript grants such an alias an implicit index
// signature and grants an `interface` none. A cast alone would NOT catch a
// regression — `as` requires only comparability, so an arm flipped back to
// `interface` keeps the cast compiling and silently falsifies the comment
// there. Assignability is the discriminating check: a union is assignable to
// `Record<string, unknown>` only if EVERY member is, so one interface arm
// turns this line red in the file that makes the claim. Same `_AssertExtends`
// idiom as contracts' `event-core.ts`; the `_` prefix is what the root eslint
// config's `varsIgnorePattern` exempts from `no-unused-vars`.
type _AssertExtends<A extends B, B> = A;
type _RuntimeNodePayloadsCarryIndexSignature = _AssertExtends<
  RuntimeNodeEventPayload,
  Record<string, unknown>
>;

// --------------------------------------------------------------------------
// Per-method inputs — bespoke typed shapes, NOT the contract payload objects.
// --------------------------------------------------------------------------
//
// Taking discrete fields (rather than the `*Payload` object) is deliberate:
// the payload schemas type `sessionId` as `.optional()` (Spec-006 base), but
// the envelope REQUIRES it as the per-session partition/sequence key — so a
// payload-object input would reintroduce that ambiguity at every call site.
// The emitter takes `sessionId` (required) + `actor` (optional, default null)
// as first-class envelope inputs and fans each into the payload it builds, so
// the envelope and payload can never diverge on those two fields.

// Shared envelope-level inputs every emit method carries.
interface RuntimeNodeEmitBase {
  // REQUIRED here even though the payload schema types it optional — the
  // daemon always populates the session_id (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`). Also the
  // sequence-allocation partition key.
  readonly sessionId: string;
  // EventEnvelope free-form actor (`participant_id | agent_id | null`).
  // Optional; defaults to `null` (system actor). This L1 routing wrapper does
  // not encode actor policy — the L2 producers (T2.1/T2.2/T2.4/T2.5) decide
  // whether the actor is a participant, an agent, or system-null.
  readonly actor?: string | null;
  // The node this event describes.
  readonly nodeId: string;
  // Correlation/causation are optional envelope linkage fields (default null).
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  // A SYNCHRONOUS durable write to commit ATOMICALLY with this event row,
  // threaded straight through to `EventLogService.append` — which runs it
  // inside the same transaction as the INSERT, immediately before it. This is
  // how the L2 producers keep their dual-write atomic now that they no longer
  // own the transaction (see the `SessionEventLog` seam contract above). The
  // constraints on what may go in one — synchronous, same connection, writes
  // only — are documented on `EventLogAppendOptions.transactionalPrelude`;
  // this seam only forwards it.
  readonly transactionalPrelude?: () => void;
}

export interface EmitRegisteredInput extends RuntimeNodeEmitBase {
  readonly previousState?: RuntimeNodeRegisteredPayload["previousState"];
  readonly newState: RuntimeNodeRegisteredPayload["newState"];
  readonly capabilities: Record<string, unknown>;
  readonly nodeVersion: string;
  readonly platform: string;
}

export interface EmitOnlineInput extends RuntimeNodeEmitBase {
  readonly previousState?: RuntimeNodeOnlinePayload["previousState"];
  readonly newState: RuntimeNodeOnlinePayload["newState"];
}

export interface EmitOfflineInput extends RuntimeNodeEmitBase {
  readonly previousState?: RuntimeNodeOfflinePayload["previousState"];
  readonly newState: RuntimeNodeOfflinePayload["newState"];
  readonly lastHeartbeatAt: string;
  // Phase 2's T2.5 detach producer passes `explicit_shutdown`; the full enum
  // is honored at the schema so Phase 3 adds producers, not a shape change.
  readonly reason: RuntimeNodeOfflinePayload["reason"];
}

export interface EmitCapabilityDeclaredInput extends RuntimeNodeEmitBase {
  readonly capability: string;
  readonly capabilityDetails: RuntimeNodeCapabilityDeclaredPayload["capabilityDetails"];
}

export interface EmitCapabilityUpdatedInput extends RuntimeNodeEmitBase {
  readonly capability: string;
  // `CapabilityDetails` snapshots (NOT NodeState). Indexed access into the
  // contracts payload type, whose canonical-first tolerant union
  // (Plan-006 T1.4) admits both producers uncast: the typed
  // driver-capabilities-writer snapshot (`CapabilityDetails`) and
  // node-capability-service's JSON-round-tripped records.
  readonly previousState: RuntimeNodeCapabilityUpdatedPayload["previousState"];
  readonly newState: RuntimeNodeCapabilityUpdatedPayload["newState"];
}

/**
 * A thenable by the Promises/A+ duck test (`typeof then === "function"` on an
 * object or function) — the same shape `await` would latch onto. Used by the
 * `#appendRuntimeNodeEvent` guard to refuse SYNCHRONOUS `SessionEventLog.append`
 * implementations fail-closed. The predicate is unchanged from the pre-re-point
 * seam; what inverted is the SENSE of the guard that consumes it (see the seam
 * contract above): the old contract refused a thenable, this one requires it.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
}

/**
 * The `row_hash` width `signer.ts` enforces, re-spelled here for the receipt
 * guard rather than imported — `signer.ts` keeps its own `CHAIN_HASH_LENGTH`
 * module-private and `pii-indirection.ts` re-spells it for the same reason.
 * Drift is one-directional and loud: this value can only cause a false refusal
 * of a receipt, never admit a wrong-width hash into a chain (the append path
 * checks the value it writes).
 */
const RECEIPT_ROW_HASH_LENGTH = 32;

/**
 * The RESOLVED value of a `SessionEventLog.append`, checked rather than
 * asserted — layer 3 of the seam contract, and the one the thenable tripwire
 * above cannot supply. That guard proves only that the seam returned SOMETHING
 * awaitable; the value it settles to is whatever the implementation chose, and
 * a bare `as EventLogAppendReceipt` on it would let `undefined` — or an object
 * with a string `rowHash` — reach the callers that consume this receipt.
 *
 * WHAT THAT COSTS, and why it is worth a runtime check at an async boundary:
 * `sequence` and `rowHash` are the anchor cadence's inputs
 * (`AnchorCadenceTrigger`), so a malformed pair does not fail here — it fails
 * later, inside a Merkle root computed over a leaf that is not a chain hash,
 * with nothing in the diagnostic pointing back at this seam.
 *
 * SEQUENCE ZERO IS VALID and the guard must admit it: it is the sequence of a
 * session's FIRST row. Only a negative or non-integer value is refused.
 *
 * Returns a freshly built receipt rather than the input, so what callers get is
 * exactly what was validated.
 */
function narrowAppendReceipt(value: unknown): EventLogAppendReceipt {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `SessionEventLog.append resolved to ${value === null ? "null" : `a value of type ${typeof value}`} instead of an EventLogAppendReceipt: this seam is Plan-006 T3.1's EventLogService.append, whose receipt carries the id, sequence and 32-byte row hash the append committed.`,
    );
  }
  const { id, sequence, rowHash } = value as {
    id?: unknown;
    sequence?: unknown;
    rowHash?: unknown;
  };
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `SessionEventLog.append resolved to a receipt whose id is not a non-empty string (type ${typeof id}); the id is the session_events PRIMARY KEY the append committed.`,
    );
  }
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0) {
    throw new Error(
      `SessionEventLog.append resolved to a receipt whose sequence is not a non-negative integer (received ${String(sequence)}); the anchor cadence keys ranges off this value, and 0 — a session's first row — is the only boundary case it may take.`,
    );
  }
  if (!(rowHash instanceof Uint8Array) || rowHash.length !== RECEIPT_ROW_HASH_LENGTH) {
    throw new Error(
      `SessionEventLog.append resolved to a receipt whose rowHash is not a ${RECEIPT_ROW_HASH_LENGTH}-byte Uint8Array (got ${rowHash instanceof Uint8Array ? `${rowHash.length} bytes` : `a value of type ${typeof rowHash}`}); this hash is the committed chain head and becomes a Merkle leaf.`,
    );
  }
  return { id, sequence, rowHash };
}

// --------------------------------------------------------------------------
// RuntimeNodeEventEmitter
// --------------------------------------------------------------------------

export class RuntimeNodeEventEmitter {
  readonly #sessionEvents: SessionEventLog;
  readonly #monotonicNow: () => bigint;
  readonly #now: () => string;
  readonly #newEventId: () => string;

  constructor(deps: RuntimeNodeEventEmitterDeps) {
    this.#sessionEvents = deps.sessionEvents;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newEventId = deps.newEventId ?? (() => randomUUID());
  }

  /**
   * Emit `runtime_node.registered` (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`). Returns the persisted
   * `AppendableEvent` so the caller (T2.1 registry) can read the assigned
   * `sequence` / `id`.
   */
  async emitRegistered(input: EmitRegisteredInput): Promise<EventLogAppendReceipt> {
    const payload: RuntimeNodeRegisteredPayload = RuntimeNodeRegisteredPayloadSchema.parse({
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      previousState: input.previousState,
      newState: input.newState,
      actor: input.actor ?? null,
      capabilities: input.capabilities,
      nodeVersion: input.nodeVersion,
      platform: input.platform,
    });
    return this.#appendRuntimeNodeEvent("runtime_node.registered", input, payload);
  }

  /**
   * Emit `runtime_node.online` (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`). The T2.4 ordering gate only
   * calls this AFTER a successful `runtime_node.capability_declared`
   * (I-003-2) — the gate lives in the producer, not here.
   */
  async emitOnline(input: EmitOnlineInput): Promise<EventLogAppendReceipt> {
    const payload: RuntimeNodeOnlinePayload = RuntimeNodeOnlinePayloadSchema.parse({
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      previousState: input.previousState,
      newState: input.newState,
      actor: input.actor ?? null,
    });
    return this.#appendRuntimeNodeEvent("runtime_node.online", input, payload);
  }

  /**
   * Emit `runtime_node.offline` (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`). Phase 2's T2.5 detach
   * producer passes `reason: "explicit_shutdown"`; the heartbeat-driven
   * reasons are Phase 3.
   */
  async emitOffline(input: EmitOfflineInput): Promise<EventLogAppendReceipt> {
    const payload: RuntimeNodeOfflinePayload = RuntimeNodeOfflinePayloadSchema.parse({
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      previousState: input.previousState,
      newState: input.newState,
      actor: input.actor ?? null,
      lastHeartbeatAt: input.lastHeartbeatAt,
      reason: input.reason,
    });
    return this.#appendRuntimeNodeEvent("runtime_node.offline", input, payload);
  }

  /**
   * Emit `runtime_node.capability_declared` (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`). Reduced base +
   * `{capability, capabilityDetails}` — capability events are NOT NodeState
   * transitions, so they carry no `previousState`/`newState: NodeState`.
   */
  async emitCapabilityDeclared(input: EmitCapabilityDeclaredInput): Promise<EventLogAppendReceipt> {
    const payload: RuntimeNodeCapabilityDeclaredPayload =
      RuntimeNodeCapabilityDeclaredPayloadSchema.parse({
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        actor: input.actor ?? null,
        capability: input.capability,
        capabilityDetails: input.capabilityDetails,
      });
    return this.#appendRuntimeNodeEvent("runtime_node.capability_declared", input, payload);
  }

  /**
   * Emit `runtime_node.capability_updated` (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`). Here
   * `previousState`/`newState` are `CapabilityDetails` SNAPSHOTS (NOT
   * NodeState); the contracts payload schemas bind the canonical
   * `CapabilityDetails` canonical-first over a tolerant record arm
   * (Plan-006 T1.4), and the input seam carries that same union via
   * indexed access, so typed snapshots arrive uncast.
   */
  async emitCapabilityUpdated(input: EmitCapabilityUpdatedInput): Promise<EventLogAppendReceipt> {
    const payload: RuntimeNodeCapabilityUpdatedPayload =
      RuntimeNodeCapabilityUpdatedPayloadSchema.parse({
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        actor: input.actor ?? null,
        capability: input.capability,
        previousState: input.previousState,
        newState: input.newState,
      });
    return this.#appendRuntimeNodeEvent("runtime_node.capability_updated", input, payload);
  }

  // ------------------------------------------------------------------------
  // Internal — shared envelope construction + append
  // ------------------------------------------------------------------------

  /**
   * Construct the envelope from the validated payload + the shared envelope
   * inputs and route it through the injected `SessionEventLog.append`. The
   * PARSED payload is persisted (not the caller's input object), so storage
   * reflects the schema's normalized shape. Resolves to the append receipt, so
   * callers read the `sequence` the append path ASSIGNED rather than one this
   * emitter guessed.
   */
  async #appendRuntimeNodeEvent(
    type: RuntimeNodeEventName,
    base: RuntimeNodeEmitBase,
    payload: RuntimeNodeEventPayload,
  ): Promise<EventLogAppendReceipt> {
    const envelope: UnsequencedEventEnvelope = {
      id: this.#newEventId(),
      // BRANDED HERE, at the emission boundary. `EventEnvelope.sessionId` is
      // the branded `SessionId` while this emitter's inputs (and the L2
      // producers behind them) carry plain strings. The parse is the honest
      // conversion — this seam already `.parse()`s every payload, so it is the
      // natural validation boundary, and branding here rather than tightening
      // the producers' input types keeps the change off ~74 call sites that
      // gain nothing from it. The payload schema above validated the SAME value
      // through `SessionIdSchema`, so this cannot reject anything that reached
      // it. Handed to `parse` UNCAST — `parse` takes `unknown`, and a cast
      // would only suppress the type error that catches a wrong-typed input.
      sessionId: SessionIdSchema.parse(base.sessionId),
      occurredAt: this.#now(),
      category: RUNTIME_NODE_EVENT_CATEGORY,
      type,
      actor: base.actor ?? null,
      // `EventEnvelope.payload` is `Record<string, unknown>`. Every arm of
      // `RuntimeNodeEventPayload` is
      // declared as an object TYPE ALIAS in contracts, and TypeScript grants a
      // type alias of an object type an implicit index signature (it grants an
      // interface none) — so the direct `as Record<string, unknown>` holds and
      // no `as unknown as` double-widening is needed — and that is ENFORCED,
      // not narrated: the `_RuntimeNodePayloadsCarryIndexSignature` pin beside
      // the union declaration above fails the build if any arm regresses to an
      // `interface`, so this comment cannot quietly go false. This is a SAFE
      // specific→general widening (every field is assignable to `unknown`), not
      // a reinterpretation; it asserts nothing false. Single site by design —
      // the union-typed parameter above keeps the cast off every call site.
      payload: payload as Record<string, unknown>,
      // Absent, not null: `EventEnvelope` types the correlation pair
      // `?: string | undefined` — optional and NOT nullable — because absent is
      // that pair's only no-value wire state (`actor` alone carries the
      // null-for-system convention). Under `exactOptionalPropertyTypes` an
      // explicit `undefined` is not assignable either, so the key is omitted
      // outright when the caller supplies none.
      ...(base.correlationId != null ? { correlationId: base.correlationId } : {}),
      ...(base.causationId != null ? { causationId: base.causationId } : {}),
      version: RUNTIME_NODE_EVENT_VERSION,
    };
    const appendResult: unknown = this.#sessionEvents.append(envelope, {
      monotonicNs: this.#monotonicNow(),
      // Forwarded only when supplied. `EventLogAppendOptions` declares it
      // optional under `exactOptionalPropertyTypes`, so an explicit
      // `transactionalPrelude: undefined` would not type-check.
      ...(base.transactionalPrelude !== undefined
        ? { transactionalPrelude: base.transactionalPrelude }
        : {}),
    });
    // Fail-closed SYNCHRONOUS-append guard — layer 2 of the `SessionEventLog`
    // seam contract above, backstopping the Promise-return compile-time layer
    // for wiring the compiler never saw (plain JS, `as unknown as` casts).
    //
    // This is the MIRROR of the pre-re-point tripwire, which refused a thenable
    // because the seam was then synchronous by contract. The direction flipped
    // with the seam: a synchronous `append` reaching here means the durable
    // write did not run under the per-session lock, its failure cannot be
    // awaited, and — the part no compile-time check would catch — the caller's
    // `transactionalPrelude` never ran inside a transaction with the event row,
    // silently un-doing the producers' dual-write atomicity. A tripwire, not a
    // recovery path: the implementation's work has already happened by the time
    // we look. It exists to make such wiring LOUD on the first emit any test
    // exercises, instead of reporting success over a half-written pair.
    if (!isThenable(appendResult)) {
      throw new Error(
        "SessionEventLog.append did not return a promise: this seam is async-transactional " +
          "(Plan-006 T3.1's EventLogService.append serializes on withSessionAppendLock and " +
          "runs the caller's transactionalPrelude inside the same transaction as the event " +
          "row). A synchronous append reports success before the write is durable and never " +
          "commits the prelude atomically with the row.",
      );
    }
    return narrowAppendReceipt(await appendResult);
  }
}
