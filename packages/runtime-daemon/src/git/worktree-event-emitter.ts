// Worktree lifecycle event emission: the one seam every worktree state transition appends its
// event through. It owns five event types (`worktree.created`, `.ready`, `.dirty`, `.merged`,
// `.retired`) over a six-state `worktrees` row vocabulary.
//
//   * A transition emits its event in the same transaction as the row write, which rides down as
//     `transactionalPrelude`.
//   * The `failed` transition emits no event; it surfaces through the owning workspace's
//     `workspace.stale`. No `emitFailed` exists.
//   * No caller-supplied `state`: each type names one post-transition state, so a
//     `worktree.retired` carrying `dirty` (which parses clean) and `failed` cannot reach the wire.

import {
  EventEnvelopeVersionSchema,
  WorktreeIdSchema,
  WorktreeLifecyclePayloadSchema,
  type EventEnvelopeVersion,
  type WorktreeCreatedEvent,
  type WorktreeDirtyEvent,
  type WorktreeMergedEvent,
  type WorktreeReadyEvent,
  type WorktreeRetiredEvent,
  type WorktreeState,
} from "@ai-sidekicks/contracts";

import type { EventLogAppendReceipt } from "../events/event-log-service.js";
import {
  LifecycleEventAppender,
  type LifecycleEventEmitterDeps,
  type LifecycleEventLinkage,
} from "../workspace/lifecycle-event-appender.js";

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

// The mapping must reach every evented state; totality alone misses a duplicate value.
type _AssertExtends<A extends B, B> = A;
type _EveryEventedStateIsReachable = _AssertExtends<
  EventedWorktreeState,
  (typeof WORKTREE_STATE_BY_EVENT_NAME)[WorktreeEventName]
>;

// Envelope version of these events, parsed at load so a bad literal throws at import. Declared
// apart from the workspace emitter's so the two need not change in lockstep.
const WORKTREE_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

/**
 * Input shared by the five worktree events. Discrete fields let `sessionId` and `actor` be written
 * into envelope and payload from one value, so the two cannot disagree.
 */
export interface EmitWorktreeEventInput extends LifecycleEventLinkage {
  /** The append path's sequence partition key. */
  readonly sessionId: string;
  // Required at runtime by `WorktreeIdSchema.parse` in `#appendWorktreeEvent`; the lifecycle
  // payload schema leaves it optional.
  readonly worktreeId: string;
  readonly repoMountId?: string;
  // Optional because the worktree service's `create` takes no workspace id.
  readonly workspaceId?: string;
  /** Envelope actor (`user_id | agent_id | null`); defaults to `null` (system). */
  readonly actor?: string | null;
}

/**
 * Appends the five worktree lifecycle events through the injected append seam. Each method
 * resolves to the receipt carrying the `sequence` the append path assigned.
 */
export class WorktreeEventEmitter {
  readonly #appender: LifecycleEventAppender;

  constructor(deps: LifecycleEventEmitterDeps) {
    this.#appender = new LifecycleEventAppender(deps, WORKTREE_EVENT_VERSION);
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
    const payload = WorktreeLifecyclePayloadSchema.parse({
      sessionId: input.sessionId,
      // The lifecycle payload schema types `worktreeId` optional; this guarantees a subject.
      worktreeId: WorktreeIdSchema.parse(input.worktreeId),
      // Omitted, not passed as `undefined`.
      ...(input.repoMountId !== undefined ? { repoMountId: input.repoMountId } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      state: WORKTREE_STATE_BY_EVENT_NAME[type],
      actor: input.actor ?? null,
    });
    return this.#appender.append(type, payload, input);
  }
}
