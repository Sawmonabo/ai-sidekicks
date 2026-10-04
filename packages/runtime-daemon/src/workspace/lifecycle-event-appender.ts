// The envelope build and single append the workspace and worktree lifecycle emitters share. Each
// emitter parses its own payload and passes it here; this module owns the envelope fields.
//
//   * One append per call: no retry, no fan-out.
//   * No sequence number, chain hash or signature: the append path owns them.
//   * The append receipt is returned as is, not examined.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event";
import type { EventCategory, EventEnvelopeVersion } from "@ai-sidekicks/contracts/event-envelope";
import type { RepoWorkspaceLifecyclePayloadOf } from "@ai-sidekicks/contracts/repo";
import type { SessionEventType } from "@ai-sidekicks/contracts/event-registry";

import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../events/event-log-service.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";

/**
 * The durable append seam, typed against the append path's own signature. A table write that must
 * commit atomically with the event row is passed as `transactionalPrelude`, which the append path
 * runs in the same transaction, just before the INSERT.
 */
export interface LifecycleEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

/** Dependencies of a lifecycle emitter; every member but `sessionEvents` has a default. */
export interface LifecycleEventEmitterDeps {
  readonly sessionEvents: LifecycleEventLog;
  /** Source for `monotonic_ns` (in-daemon ordering only; replay orders by `sequence`). */
  readonly monotonicNow?: () => bigint;
  /** Source for `occurredAt` (ISO 8601). */
  readonly now?: () => string;
  /** Source for the `session_events.id` primary key; defaults to `mintUuidV7`. */
  readonly newEventId?: () => string;
}

/** The envelope linkage and atomic table write one emission carries. */
export interface LifecycleEventLinkage {
  readonly correlationId?: string | null | undefined;
  readonly causationId?: string | null | undefined;
  /** Forwarded to the append path (see `EventLogAppendOptions.transactionalPrelude`). */
  readonly transactionalPrelude?: (() => void) | undefined;
}

/** Builds one lifecycle envelope from a parsed payload and appends it. */
export class LifecycleEventAppender {
  readonly #sessionEvents: LifecycleEventLog;
  readonly #monotonicNow: () => bigint;
  readonly #now: () => string;
  readonly #newEventId: () => string;
  readonly #version: EventEnvelopeVersion;

  constructor(deps: LifecycleEventEmitterDeps, version: EventEnvelopeVersion) {
    this.#sessionEvents = deps.sessionEvents;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newEventId = deps.newEventId ?? mintUuidV7;
    this.#version = version;
  }

  /**
   * Appends `type` with `payload`. The envelope's session and actor are read back from the parsed
   * payload, so the two cannot disagree. Throws when the type has no registered category.
   */
  async append<TState extends string>(
    type: SessionEventType,
    payload: RepoWorkspaceLifecyclePayloadOf<TState>,
    linkage: LifecycleEventLinkage,
  ): Promise<EventLogAppendReceipt> {
    // Looked up from the registry: the strict layer refuses an envelope whose category disagrees
    // with its type.
    const category: EventCategory | undefined = SESSION_EVENT_CATEGORY_BY_TYPE.get(type);
    if (category === undefined) {
      throw new Error(
        `No category is registered for event type "${type}": a lifecycle type must be present in ` +
          "SESSION_EVENT_CATEGORY_BY_TYPE for the strict layer to interpret what is written.",
      );
    }
    const envelope: UnsequencedEventEnvelope = {
      id: this.#newEventId(),
      sessionId: payload.sessionId,
      occurredAt: this.#now(),
      category,
      type,
      actor: payload.actor ?? null,
      payload,
      // Absent, not null: the correlation pair is optional and not nullable on the envelope.
      ...(linkage.correlationId != null ? { correlationId: linkage.correlationId } : {}),
      ...(linkage.causationId != null ? { causationId: linkage.causationId } : {}),
      version: this.#version,
    };
    return this.#sessionEvents.append(envelope, {
      monotonicNs: this.#monotonicNow(),
      // Spread, because `exactOptionalPropertyTypes` rejects an explicit `undefined`.
      ...(linkage.transactionalPrelude !== undefined
        ? { transactionalPrelude: linkage.transactionalPrelude }
        : {}),
    });
  }
}
