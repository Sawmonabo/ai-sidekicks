// Worktree lifecycle event emission: the one seam every worktree state transition appends its
// event through. It owns five event types (`worktree.created`, `.ready`, `.dirty`, `.merged`,
// `.retired`) over a six-state `worktrees` row vocabulary.
//
//   * A transition emits its event exactly once (no retry, no fan-out), in the same transaction as
//     the row write, which rides down as `transactionalPrelude`.
//   * The `failed` transition emits no event; it surfaces through the owning workspace's
//     `workspace.stale`. No `emitFailed` exists.
//   * No sequence number, chain hash or signature is computed here; the receipt is returned as is.
//   * No caller-supplied `state`: each type names one post-transition state, so a
//     `worktree.retired` carrying `dirty` (which parses clean) and `failed` cannot reach the wire.

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
import { mintUuidV7 } from "../ids/uuid-v7.js";

// Event names come from indexed access on the contracts variants (contracts exports no union), so
// a rename there fails this compile.
type WorktreeEventName =
  | WorktreeCreatedEvent["type"]
  | WorktreeReadyEvent["type"]
  | WorktreeDirtyEvent["type"]
  | WorktreeMergedEvent["type"]
  | WorktreeRetiredEvent["type"];

// The row vocabulary minus `failed`, which no event carries.
type EventedWorktreeState = Exclude<WorktreeState, "failed">;

// Total over the event names and confined to evented states, so nothing maps to `failed`. The
// pairing matches `STANDALONE_WORKTREE_EVENT_SCHEMAS` in the contracts worktree test.
const WORKTREE_STATE_BY_EVENT_NAME = {
  "worktree.created": "creating",
  "worktree.ready": "ready",
  "worktree.dirty": "dirty",
  "worktree.merged": "merged",
  "worktree.retired": "retired",
} as const satisfies Record<WorktreeEventName, EventedWorktreeState>;

// Envelope version of these events, parsed at load so a bad literal throws at import. Declared
// apart from the workspace emitter's so the two need not change in lockstep.
const WORKTREE_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// Fails the compile if `WorktreeLifecyclePayload` stops being an object type alias (an `interface`
// has no implicit index signature), which the cast in `#appendWorktreeEvent` would not catch.
type _AssertExtends<A extends B, B> = A;
type _WorktreePayloadCarriesIndexSignature = _AssertExtends<
  WorktreeLifecyclePayload,
  Record<string, unknown>
>;

// The mapping must reach every evented state; totality alone misses a duplicate value.
type _EveryEventedStateIsReachable = _AssertExtends<
  EventedWorktreeState,
  (typeof WORKTREE_STATE_BY_EVENT_NAME)[WorktreeEventName]
>;

/**
 * The durable append seam, typed against the append path's own signature. A `worktrees` row write
 * that must commit atomically with the event is passed as `transactionalPrelude`, which the append
 * path runs in the same transaction as the INSERT.
 */
export interface WorktreeEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

/** Dependencies of {@link WorktreeEventEmitter}; the clock and id sources are injectable. */
export interface WorktreeEventEmitterDeps {
  readonly sessionEvents: WorktreeEventLog;
  /** Source for `monotonic_ns` (in-daemon ordering only); defaults to `process.hrtime.bigint()`. */
  readonly monotonicNow?: () => bigint;
  /** Source for `occurredAt` (ISO 8601). */
  readonly now?: () => string;
  /** Source for the `session_events.id` primary key; defaults to `mintUuidV7`. */
  readonly newEventId?: () => string;
}

/**
 * Input shared by the five worktree events. Discrete fields let `sessionId` and `actor` be written
 * into envelope and payload from one value, so the two cannot disagree.
 */
export interface EmitWorktreeEventInput {
  // Required although the payload schema types it optional: it is the append path's sequence
  // partition key.
  readonly sessionId: string;
  // Required at runtime by `WorktreeIdSchema.parse` in `#appendWorktreeEvent`; the family schema
  // leaves it optional.
  readonly worktreeId: string;
  readonly repoMountId?: string;
  // Optional because the worktree service's `create` takes no workspace id.
  readonly workspaceId?: string;
  /** Envelope actor (`user_id | agent_id | null`); defaults to `null` (system). */
  readonly actor?: string | null;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  // Forwarded to the append path (see `EventLogAppendOptions.transactionalPrelude`).
  readonly transactionalPrelude?: () => void;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
}

/**
 * Appends the five worktree lifecycle events through the injected append seam. Each method
 * resolves to the receipt carrying the `sequence` the append path assigned.
 */
export class WorktreeEventEmitter {
  readonly #sessionEvents: WorktreeEventLog;
  readonly #monotonicNow: () => bigint;
  readonly #now: () => string;
  readonly #newEventId: () => string;

  constructor(deps: WorktreeEventEmitterDeps) {
    this.#sessionEvents = deps.sessionEvents;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newEventId = deps.newEventId ?? mintUuidV7;
  }

  /** Emit `worktree.created`: a `worktrees` row was written in state `creating`. */
  async emitWorktreeCreated(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.created", input);
  }

  /** Emit `worktree.ready`: the checkout is materialized and bindable as an execution root. */
  async emitWorktreeReady(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.ready", input);
  }

  /** Emit `worktree.dirty`: uncommitted work was observed in the checkout. */
  async emitWorktreeDirty(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.dirty", input);
  }

  /** Emit `worktree.merged`: the worktree's branch has merged back. */
  async emitWorktreeMerged(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.merged", input);
  }

  /**
   * Emit `worktree.retired`: the terminal state. It is evented before any disk mutation (cleanup
   * stamps `cleaned_at` later), so it does not mean the root is gone.
   */
  async emitWorktreeRetired(input: EmitWorktreeEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorktreeEvent("worktree.retired", input);
  }

  async #appendWorktreeEvent(
    type: WorktreeEventName,
    input: EmitWorktreeEventInput,
  ): Promise<EventLogAppendReceipt> {
    const payload: WorktreeLifecyclePayload = WorktreeLifecyclePayloadSchema.parse({
      sessionId: input.sessionId,
      // The family schema types `worktreeId` optional; this guarantees a subject.
      worktreeId: WorktreeIdSchema.parse(input.worktreeId),
      // Omitted, not passed as `undefined`.
      ...(input.repoMountId !== undefined ? { repoMountId: input.repoMountId } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      state: WORKTREE_STATE_BY_EVENT_NAME[type],
      actor: input.actor ?? null,
    });

    // Looked up from the registry: the strict layer refuses a category that disagrees with type.
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
      // Read back from the parsed payload so envelope and payload cannot disagree.
      sessionId: payload.sessionId,
      occurredAt: this.#now(),
      category,
      type,
      actor: payload.actor ?? null,
      // Widening is safe; `_WorktreePayloadCarriesIndexSignature` enforces it.
      payload: payload as Record<string, unknown>,
      // Absent, not null: the correlation pair is optional and not nullable on the envelope.
      ...(input.correlationId != null ? { correlationId: input.correlationId } : {}),
      ...(input.causationId != null ? { causationId: input.causationId } : {}),
      version: WORKTREE_EVENT_VERSION,
    };

    const appendResult: Promise<EventLogAppendReceipt> = this.#sessionEvents.append(envelope, {
      monotonicNs: this.#monotonicNow(),
      // Spread, because `exactOptionalPropertyTypes` rejects an explicit `undefined`.
      ...(input.transactionalPrelude !== undefined
        ? { transactionalPrelude: input.transactionalPrelude }
        : {}),
    });

    // Catches a synchronous `append` wired past the compiler (plain JS, casts): it would skip the
    // per-session lock and the prelude's shared transaction, breaking atomicity. The declared
    // `Promise` type is the claim being distrusted, so it does not make this dead.
    if (!isThenable(appendResult)) {
      throw new Error(
        "WorktreeEventLog.append did not return a promise: this seam is async-transactional " +
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
