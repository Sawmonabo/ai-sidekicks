// Worktree lifecycle event emission: the one seam every worktree state transition appends its
// event through. It owns five event types (`worktree.created`, `.ready`, `.dirty`, `.merged`,
// `.retired`) over a six-state `worktrees` row vocabulary, and the two session records a tree's
// life writes: a session swept back to the repository root, and a session's branch changed.
//
//   * A transition emits its event in the same transaction as the row write, which rides down as
//     `transactionalPrelude`. A tree recorded ready at once, a put-back's, emits `worktree.created`
//     and `worktree.ready` together in that one write.
//   * The `failed` transition emits no event; it surfaces through the owning workspace's
//     `workspace.stale`. No `emitFailed` exists.
//   * No caller-supplied `state`: each type names one post-transition state, so a
//     `worktree.retired` carrying `dirty` (which parses clean) and `failed` cannot reach the wire.

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import {
  RemovedWorktreeIdSchema,
  WorktreeIdSchema,
  WorktreeLifecyclePayloadSchema,
  type WorktreeLifecyclePayload,
  type WorktreeState,
} from "@ai-sidekicks/contracts/worktree/lifecycle";
import {
  SessionBranchChangedPayloadSchema,
  SessionSweptToRepoRootPayloadSchema,
  WorktreeCreatedPayloadSchema,
  WorktreeRetiredPayloadSchema,
  type SessionBranchChangedPayload,
  type SessionSweptToRepoRootPayload,
  type WorktreeCreatedPayload,
} from "@ai-sidekicks/contracts/worktree/events";
import type {
  WorktreeCreatedEvent,
  WorktreeDirtyEvent,
  WorktreeMergedEvent,
  WorktreeReadyEvent,
  WorktreeRetiredEvent,
} from "@ai-sidekicks/contracts/event/declared-variants";

import type { EventLogAppendReceipt } from "../../events/log-service.js";
import {
  SessionEventAppender,
  type SessionEventAppenderDeps,
  type SessionEventLinkage,
} from "../../events/session/appender.js";

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
export interface EmitWorktreeEventInput extends SessionEventLinkage {
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

/** `worktree.created`'s input: on a put-back, the kept copy the tree came from. */
export interface EmitWorktreeCreatedInput extends EmitWorktreeEventInput {
  readonly restoredFrom?: string;
}

/** `worktree.retired`'s input: on a discard, the kept copy it made. */
export interface EmitWorktreeRetiredInput extends EmitWorktreeEventInput {
  readonly removedWorktreeId?: string;
}

/** A session record's input: its payload whole, and the write it commits with. */
export interface EmitSessionRecordInput<Payload> extends SessionEventLinkage {
  readonly payload: Payload;
}

/**
 * Appends the five worktree lifecycle events and the two session records through the injected
 * append seam. Each method resolves to the receipt carrying the `sequence` the append path
 * assigned.
 */
export class WorktreeEventEmitter {
  readonly #appender: SessionEventAppender;

  constructor(deps: SessionEventAppenderDeps) {
    this.#appender = new SessionEventAppender(deps, WORKTREE_EVENT_VERSION);
  }

  /** Emit `worktree.created`: a `worktrees` row was written in state `creating`. */
  async emitWorktreeCreated(input: EmitWorktreeCreatedInput): Promise<EventLogAppendReceipt> {
    return this.#appender.append("worktree.created", this.#createdPayload(input), input);
  }

  /**
   * Emit `worktree.created` then `worktree.ready` in one write, for a row the prelude writes and
   * moves to `ready` together: neither event commits without the other.
   */
  async emitWorktreeCreatedAndReady(
    input: EmitWorktreeCreatedInput,
  ): Promise<EventLogAppendReceipt> {
    return this.#appender.append(
      "worktree.ready",
      this.#lifecyclePayload("worktree.ready", input),
      {
        ...input,
        precedingEvents: [{ type: "worktree.created", payload: this.#createdPayload(input) }],
      },
    );
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
  async emitWorktreeRetired(input: EmitWorktreeRetiredInput): Promise<EventLogAppendReceipt> {
    const payload = WorktreeRetiredPayloadSchema.parse({
      ...this.#lifecyclePayload("worktree.retired", input),
      ...(input.removedWorktreeId !== undefined
        ? { removedWorktreeId: RemovedWorktreeIdSchema.parse(input.removedWorktreeId) }
        : {}),
    });
    return this.#appender.append("worktree.retired", payload, input);
  }

  /**
   * Emit `session.swept_to_repo_root`: a removal moved the session back to the repository root,
   * or cleared its pending move into the removed tree.
   */
  async emitSessionSweptToRepoRoot(
    input: EmitSessionRecordInput<SessionSweptToRepoRootPayload>,
  ): Promise<EventLogAppendReceipt> {
    const payload = SessionSweptToRepoRootPayloadSchema.parse(input.payload);
    return this.#appender.append("session.swept_to_repo_root", payload, input);
  }

  /**
   * Emit `session.branch_changed`: the branch the session's folder is on changed outside the app,
   * written back to the session's record.
   */
  async emitBranchChanged(
    input: EmitSessionRecordInput<SessionBranchChangedPayload>,
  ): Promise<EventLogAppendReceipt> {
    const payload = SessionBranchChangedPayloadSchema.parse(input.payload);
    return this.#appender.append("session.branch_changed", payload, input);
  }

  #createdPayload(input: EmitWorktreeCreatedInput): WorktreeCreatedPayload {
    return WorktreeCreatedPayloadSchema.parse({
      ...this.#lifecyclePayload("worktree.created", input),
      ...(input.restoredFrom !== undefined
        ? { restoredFrom: RemovedWorktreeIdSchema.parse(input.restoredFrom) }
        : {}),
    });
  }

  async #appendWorktreeEvent(
    type: WorktreeEventName,
    input: EmitWorktreeEventInput,
  ): Promise<EventLogAppendReceipt> {
    return this.#appender.append(type, this.#lifecyclePayload(type, input), input);
  }

  #lifecyclePayload(
    type: WorktreeEventName,
    input: EmitWorktreeEventInput,
  ): WorktreeLifecyclePayload {
    return WorktreeLifecyclePayloadSchema.parse({
      sessionId: input.sessionId,
      // The lifecycle payload schema types `worktreeId` optional; this guarantees a subject.
      worktreeId: WorktreeIdSchema.parse(input.worktreeId),
      // Omitted, not passed as `undefined`.
      ...(input.repoMountId !== undefined ? { repoMountId: input.repoMountId } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      state: WORKTREE_STATE_BY_EVENT_NAME[type],
      actor: input.actor ?? null,
    });
  }
}
