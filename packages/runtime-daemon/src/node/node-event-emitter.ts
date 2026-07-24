// RuntimeNodeEventEmitter — Plan-003 Phase 2 (T2.3).
//
// The single emission seam that routes every daemon-reachable
// `runtime_node.*` event through the canonical Plan-001 session-event
// append path (`SessionService.append`). T2.1's node-registry and T2.2's
// node-capability-service both import this standalone module rather than
// re-implementing event construction, so the two L2 producers cannot
// drift in how they shape, validate, or sequence runtime-node events
// (corrected 2026-06-02, PR #137: a standalone L1 module keeps this task's
// file disjoint from the L2 consumers that import it and the L3 tasks that
// extend them).
//
// What this module DOES:
//   * Builds each `runtime_node.*` event as an `AppendableEvent` and routes
//     it through `SessionService.append`.
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
//   * Allocates the per-session `sequence` via a deps-injected
//     `nextSequence(sessionId)` allocator (no parallel counter). The
//     Phase-2 default derives the next value from the durable log
//     (`readEvents`, last `sequence` + 1) — synchronous between the read and
//     the append, hence atomic in the single-threaded daemon, with
//     `append`'s `UNIQUE(session_id, sequence)` throw as the backstop. The
//     coordinated production allocator is a forward-dep on Plan-001 Phase 5;
//     Plan-003 deps-injects the seam rather than authoring an allocator onto
//     Plan-001-owned `SessionService` (ownership-respecting forward-dep,
//     parallel to CP-003-1's interim-opaque payload fields).
//
// What this module does NOT do (deferred — do not add here):
//   * Integrity columns. `SessionService.append` already zero-fills
//     `prev_hash` / `row_hash` / `daemon_signature` and writes the
//     caller-supplied `monotonic_ns` (CP-003-1). Plan-006 Tier 4 lands the
//     real BLAKE3 hash-chain + dual signatures + RFC 8785 JCS. This emitter
//     never computes or passes integrity bytes — it passes only the
//     `AppendableEvent` fields and the append path zero-fills the rest.
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
  RuntimeNodeCapabilityDeclaredPayloadSchema,
  RuntimeNodeCapabilityUpdatedPayloadSchema,
  RuntimeNodeOfflinePayloadSchema,
  RuntimeNodeOnlinePayloadSchema,
  RuntimeNodeRegisteredPayloadSchema,
  type EventCategory,
  type RuntimeNodeCapabilityDeclaredPayload,
  type RuntimeNodeCapabilityUpdatedPayload,
  type RuntimeNodeEventName,
  type RuntimeNodeOfflinePayload,
  type RuntimeNodeOnlinePayload,
  type RuntimeNodeRegisteredPayload,
} from "@ai-sidekicks/contracts";

import type { SessionService } from "../session/session-service.js";
import type { AppendableEvent } from "../session/types.js";

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
const RUNTIME_NODE_EVENT_VERSION: string = "1.0";

// --------------------------------------------------------------------------
// Injected dependencies
// --------------------------------------------------------------------------

export interface RuntimeNodeEventEmitterDeps {
  // Plan-001-owned durable storage. Type-only `Pick` of the two methods this
  // emitter needs — `append` to persist, `readEvents` for the log-derive
  // sequence default. Keeping it a `Pick` (not the full `SessionService`)
  // documents the exact surface consumed and lets tests pass a narrow fake
  // if they ever need one (the production path passes a real `SessionService`).
  readonly sessionEvents: Pick<SessionService, "append" | "readEvents">;

  // Per-session sequence allocator (forward-dep on Plan-001 Phase 5). When
  // omitted, defaults to a log-derive over `readEvents` (last `sequence` + 1,
  // or 0 for an empty log). Plan-001 Phase 5 later injects the coordinated
  // production allocator here without this module changing.
  readonly nextSequence?: (sessionId: string) => number;

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
  readonly capabilityDetails: Record<string, unknown>;
}

export interface EmitCapabilityUpdatedInput extends RuntimeNodeEmitBase {
  readonly capability: string;
  // Interim-opaque CapabilityDetails snapshots (NOT NodeState) — Plan-006
  // Tier 4 binds the canonical `CapabilityDetails`.
  readonly previousState: Record<string, unknown>;
  readonly newState: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// RuntimeNodeEventEmitter
// --------------------------------------------------------------------------

export class RuntimeNodeEventEmitter {
  readonly #sessionEvents: Pick<SessionService, "append" | "readEvents">;
  readonly #nextSequence: (sessionId: string) => number;
  readonly #monotonicNow: () => bigint;
  readonly #now: () => string;
  readonly #newEventId: () => string;

  constructor(deps: RuntimeNodeEventEmitterDeps) {
    this.#sessionEvents = deps.sessionEvents;
    this.#nextSequence = deps.nextSequence ?? ((sessionId) => this.#deriveNextSequence(sessionId));
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newEventId = deps.newEventId ?? (() => randomUUID());
  }

  /**
   * Emit `runtime_node.registered` (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`). Returns the persisted
   * `AppendableEvent` so the caller (T2.1 registry) can read the assigned
   * `sequence` / `id`.
   */
  emitRegistered(input: EmitRegisteredInput): AppendableEvent {
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
  emitOnline(input: EmitOnlineInput): AppendableEvent {
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
  emitOffline(input: EmitOfflineInput): AppendableEvent {
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
  emitCapabilityDeclared(input: EmitCapabilityDeclaredInput): AppendableEvent {
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
   * `previousState`/`newState` are interim-opaque CapabilityDetails
   * SNAPSHOTS (NOT NodeState) — Plan-006 Tier 4 binds the canonical
   * `CapabilityDetails`.
   */
  emitCapabilityUpdated(input: EmitCapabilityUpdatedInput): AppendableEvent {
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
   * Construct the `AppendableEvent` from the validated payload + the shared
   * envelope inputs, allocate the sequence, and route through
   * `SessionService.append`. The PARSED payload is persisted (not the
   * caller's input object), so storage reflects the schema's normalized
   * shape. Returns the constructed event so callers can read `sequence`/`id`.
   */
  #appendRuntimeNodeEvent(
    type: RuntimeNodeEventName,
    base: RuntimeNodeEmitBase,
    payload: RuntimeNodeEventPayload,
  ): AppendableEvent {
    const event: AppendableEvent = {
      id: this.#newEventId(),
      sessionId: base.sessionId,
      sequence: this.#nextSequence(base.sessionId),
      occurredAt: this.#now(),
      monotonicNs: this.#monotonicNow(),
      category: RUNTIME_NODE_EVENT_CATEGORY,
      type,
      actor: base.actor ?? null,
      // `AppendableEvent.payload` is `Record<string, unknown>` (Plan-001-owned
      // `types.ts`, read-only here). The validated payload IS a string-keyed
      // object at runtime, but a named interface does not auto-carry an index
      // signature, so a direct `as Record<string, unknown>` is rejected and the
      // `as unknown as` widening is required — same documented language-gap
      // bridge as `bootstrap/secure-defaults.ts:263-267`. This is a SAFE
      // specific→general widening (every field is assignable to `unknown`), not
      // a reinterpretation; it asserts nothing false. Single site by design —
      // the union-typed parameter above keeps the cast off every call site.
      payload: payload as unknown as Record<string, unknown>,
      correlationId: base.correlationId ?? null,
      causationId: base.causationId ?? null,
      version: RUNTIME_NODE_EVENT_VERSION,
    };
    this.#sessionEvents.append(event);
    return event;
  }

  /**
   * Phase-2 default sequence allocator: the next per-session `sequence` is
   * the last durable event's `sequence` + 1, or 0 for an empty log. Reading
   * and appending happen synchronously with no `await` between them, so the
   * read-then-append is atomic in the single-threaded daemon; `append`'s
   * `UNIQUE(session_id, sequence)` throw is the backstop if that assumption
   * is ever violated. Replaced by Plan-001 Phase 5's coordinated allocator
   * via the `nextSequence` dep.
   */
  #deriveNextSequence(sessionId: string): number {
    const events: ReadonlyArray<{ readonly sequence: number }> =
      this.#sessionEvents.readEvents(sessionId);
    if (events.length === 0) {
      return 0;
    }
    const lastEvent = events[events.length - 1];
    // `readEvents` returns sequence-ASC, so the final element carries the
    // highest sequence. The `undefined` guard is a type-narrowing formality
    // (the length check above guarantees presence) — TypeScript cannot infer
    // non-emptiness from `.length`.
    if (lastEvent === undefined) {
      return 0;
    }
    return lastEvent.sequence + 1;
  }
}
