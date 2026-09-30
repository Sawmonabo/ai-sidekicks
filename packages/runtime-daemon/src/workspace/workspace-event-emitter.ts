// Workspace lifecycle event emission: the one seam every workspace state transition appends its
// event through. It owns `workspace.preparing`, `workspace.ready`, `workspace.stale` and
// `workspace.archived` (which also carries the repo mount whose detach caused it). A mount's
// attach and detach are project changes, not session events, so nothing here records them.
//
// Each method builds one envelope and appends exactly once (no retry, no fan-out). Workspace `busy`
// has no emit method.
//
//   * No sequence number, chain hash or signature: the append path owns them.
//   * No caller-supplied `state`: each type names exactly one post-transition state, so a
//     `workspace.ready` carrying `state: "archived"` (which parses clean) cannot be written.
//   * The append receipt is returned as is, not examined.

import {
  EventEnvelopeVersionSchema,
  RepoWorkspaceLifecyclePayloadSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  type EventCategory,
  type EventEnvelopeVersion,
  type RepoWorkspaceLifecyclePayload,
  type WorkspaceArchivedEvent,
  type WorkspacePreparingEvent,
  type WorkspaceReadyEvent,
  type WorkspaceStaleEvent,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../events/event-log-service.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";

// Event names come from indexed access on the registered contracts variants (contracts exports no
// union), so a rename there fails this compile.
type WorkspaceEventName =
  | WorkspacePreparingEvent["type"]
  | WorkspaceReadyEvent["type"]
  | WorkspaceStaleEvent["type"]
  | WorkspaceArchivedEvent["type"];

const WORKSPACE_STATE_BY_EVENT_NAME = {
  "workspace.preparing": "preparing",
  "workspace.ready": "ready",
  "workspace.stale": "stale",
  "workspace.archived": "archived",
} as const satisfies Record<WorkspaceEventName, WorkspaceState>;

// Envelope version (MAJOR.MINOR) of these events. Parsed at load so a bad literal throws at import,
// not at the first emit.
const REPO_WORKSPACE_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// Fails the compile if `RepoWorkspaceLifecyclePayload` stops being an object type alias (an
// `interface` has no implicit index signature), which the `as Record<string, unknown>` cast in
// `#appendLifecycleEvent` would not catch.
type _AssertExtends<A extends B, B> = A;
type _LifecyclePayloadCarriesIndexSignature = _AssertExtends<
  RepoWorkspaceLifecyclePayload,
  Record<string, unknown>
>;

/**
 * The durable append seam, typed against the append path's own signature. A table write that must
 * commit atomically with the event row is passed as `transactionalPrelude`, which the append path
 * runs in the same transaction, just before the INSERT.
 */
export interface WorkspaceEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

/** Dependencies of `WorkspaceEventEmitter`; every member but `sessionEvents` has a default. */
export interface WorkspaceEventEmitterDeps {
  readonly sessionEvents: WorkspaceEventLog;

  // Monotonic clock for `monotonic_ns` (in-daemon ordering only; replay orders by `sequence`).
  readonly monotonicNow?: () => bigint;

  // Wall-clock source for `occurredAt` (ISO 8601).
  readonly now?: () => string;

  // Source for the `session_events.id` primary key; defaults to `mintUuidV7`.
  readonly newEventId?: () => string;
}

// Methods take discrete fields so `sessionId` and `actor` are written into both envelope and
// payload from one value; validation alone would not catch the two disagreeing.
interface WorkspaceEventEmitBase {
  // Required although the payload schema types it optional: it is the append path's
  // sequence-allocation partition key.
  readonly sessionId: string;
  // Envelope actor (`user_id | agent_id | null`); defaults to `null` (system).
  readonly actor?: string | null;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  // Forwarded to the append path (see `EventLogAppendOptions.transactionalPrelude`).
  readonly transactionalPrelude?: () => void;
}

/** Input for the four workspace lifecycle events. */
export interface EmitWorkspaceEventInput extends WorkspaceEventEmitBase {
  readonly workspaceId: string;
  // Set on `workspace.preparing` (the pairing's first appearance) and on the detach cascade's
  // `workspace.archived`, so a reader knowing only the mount can attribute the archival.
  readonly repoMountId?: string;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
}

/**
 * Appends workspace lifecycle events, one envelope per call. Each method resolves
 * to the append receipt, so a producer reads the `sequence` the append path assigned.
 */
export class WorkspaceEventEmitter {
  readonly #sessionEvents: WorkspaceEventLog;
  readonly #monotonicNow: () => bigint;
  readonly #now: () => string;
  readonly #newEventId: () => string;

  constructor(deps: WorkspaceEventEmitterDeps) {
    this.#sessionEvents = deps.sessionEvents;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newEventId = deps.newEventId ?? mintUuidV7;
  }

  /** Emit `workspace.preparing` — the workspace's materialization began. */
  async emitWorkspacePreparing(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.preparing", input);
  }

  /** Emit `workspace.ready` — the workspace is usable for execution. */
  async emitWorkspaceReady(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.ready", input);
  }

  /**
   * Emit `workspace.stale`: the workspace no longer reflects its mount and needs reprovisioning
   * before further use.
   */
  async emitWorkspaceStale(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.stale", input);
  }

  /**
   * Emit `workspace.archived`: the workspace reached its terminal state. Pass `repoMountId` when
   * the archival is a detach cascade's dependent transition.
   */
  async emitWorkspaceArchived(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.archived", input);
  }

  async #appendWorkspaceEvent(
    type: WorkspaceEventName,
    input: EmitWorkspaceEventInput,
  ): Promise<EventLogAppendReceipt> {
    const payload: RepoWorkspaceLifecyclePayload = RepoWorkspaceLifecyclePayloadSchema.parse({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      // Omitted, not passed as `undefined`, when the event names no mount.
      ...(input.repoMountId !== undefined ? { repoMountId: input.repoMountId } : {}),
      state: WORKSPACE_STATE_BY_EVENT_NAME[type],
      actor: input.actor ?? null,
    });
    return this.#appendLifecycleEvent(type, input, payload);
  }

  async #appendLifecycleEvent(
    type: WorkspaceEventName,
    base: WorkspaceEventEmitBase,
    payload: RepoWorkspaceLifecyclePayload,
  ): Promise<EventLogAppendReceipt> {
    // Looked up from the registry: the strict layer refuses an envelope whose category disagrees
    // with its type.
    const category: EventCategory | undefined = SESSION_EVENT_CATEGORY_BY_TYPE.get(type);
    if (category === undefined) {
      throw new Error(
        `No category is registered for event type "${type}": the workspace ` +
          "lifecycle types must be present in SESSION_EVENT_CATEGORY_BY_TYPE for the strict " +
          "layer to interpret what this emitter writes.",
      );
    }
    const envelope: UnsequencedEventEnvelope = {
      id: this.#newEventId(),
      // Read back from the parsed payload so envelope and payload cannot disagree.
      sessionId: payload.sessionId,
      occurredAt: this.#now(),
      category,
      type,
      actor: payload.actor ?? null,
      // Widening is safe; `_LifecyclePayloadCarriesIndexSignature` enforces it.
      payload: payload as Record<string, unknown>,
      // Absent, not null: the correlation pair is optional and not nullable on the envelope.
      ...(base.correlationId != null ? { correlationId: base.correlationId } : {}),
      ...(base.causationId != null ? { causationId: base.causationId } : {}),
      version: REPO_WORKSPACE_EVENT_VERSION,
    };
    const appendResult: Promise<EventLogAppendReceipt> = this.#sessionEvents.append(envelope, {
      monotonicNs: this.#monotonicNow(),
      // Spread, because `exactOptionalPropertyTypes` rejects an explicit `undefined`.
      ...(base.transactionalPrelude !== undefined
        ? { transactionalPrelude: base.transactionalPrelude }
        : {}),
    });
    // Catches a synchronous `append` wired past the compiler (plain JS, casts): it would skip the
    // per-session lock and the prelude's shared transaction, breaking dual-write atomicity. The
    // declared `Promise` type is the claim being distrusted, so it does not make this dead.
    if (!isThenable(appendResult)) {
      throw new Error(
        "WorkspaceEventLog.append did not return a promise: this seam is async-transactional " +
          "(append path serializes on the per-session append lock and runs the" +
          "caller's transactionalPrelude inside the same transaction as the event row). A " +
          "synchronous append reports success before the write is durable and never commits " +
          "the prelude atomically with the row.",
      );
    }
    const receipt: EventLogAppendReceipt = await appendResult;
    return receipt;
  }
}
