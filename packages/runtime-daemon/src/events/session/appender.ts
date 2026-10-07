// The envelope build and single append every daemon-authored session event shares. Each producer
// builds its own payload and passes it here; this module owns the envelope fields.
//
//   * One append per call: no retry, no fan-out.
//   * No sequence number, chain hash or signature: the append path owns them.
//   * The append receipt is returned as is, not examined.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import type { EventCategory, EventEnvelopeVersion } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../../database/statement.js";
import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../log-service.js";
import { mintUuidV7 } from "../../uuid-v7.js";

/**
 * The durable append seam, typed against the append path's own signature. A table write that must
 * commit atomically with the event row is passed as `transactionalPrelude`, statements the append
 * path commits in the same write, just before the row.
 */
export interface SessionEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

/** Dependencies of a session event producer; every member but `sessionEvents` has a default. */
export interface SessionEventAppenderDeps {
  readonly sessionEvents: SessionEventLog;
  /** Source for `monotonic_ns` (in-daemon ordering only; a rebuild orders by `sequence`). */
  readonly monotonicNow?: () => bigint;
  /** Source for `occurredAt` (ISO 8601). */
  readonly now?: () => string;
  /** Source for the `session_events.id` primary key; defaults to `mintUuidV7`. */
  readonly newEventId?: () => string;
}

/** An event built to go in another event's write: its type and its payload. */
export interface SessionEventDraft {
  readonly type: SessionEventType;
  readonly payload: AppendedPayload;
}

/** The envelope linkage and atomic table write one emission carries. */
export interface SessionEventLinkage {
  readonly correlationId?: string | null | undefined;
  readonly causationId?: string | null | undefined;
  /** Forwarded to the append path (see `EventLogAppendOptions.transactionalPrelude`). */
  readonly transactionalPrelude?: readonly WriteStatement[] | undefined;
  /** A body-bearing event's prose, stored beside its payload (see `EventLogAppendOptions.content`). */
  readonly content?: EventLogAppendOptions["content"] | undefined;
  /** Events committed just before this one in its write (see `EventLogAppendOptions`). */
  readonly precedingEvents?: readonly SessionEventDraft[] | undefined;
}

/** The members the envelope reads back from a payload: its session and, when one acted, its actor. */
export interface AppendedPayload {
  readonly sessionId: SessionId;
  readonly actor?: string | null | undefined;
}

/** Builds one session event envelope from a built payload and appends it. */
export class SessionEventAppender {
  readonly #sessionEvents: SessionEventLog;
  readonly #monotonicNow: () => bigint;
  readonly #now: () => string;
  readonly #newEventId: () => string;
  readonly #version: EventEnvelopeVersion;

  constructor(deps: SessionEventAppenderDeps, version: EventEnvelopeVersion) {
    this.#sessionEvents = deps.sessionEvents;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newEventId = deps.newEventId ?? mintUuidV7;
    this.#version = version;
  }

  /**
   * Appends `type` with `payload`, after any of `linkage.precedingEvents` in the same write. The
   * envelope's session and actor are read back from the payload, so the two cannot disagree.
   * Throws when a type has no registered category.
   */
  async append(
    type: SessionEventType,
    payload: AppendedPayload,
    linkage: SessionEventLinkage,
  ): Promise<EventLogAppendReceipt> {
    // Built in write order, so the ids minted for them rise with their sequences.
    const precedingEvents = (linkage.precedingEvents ?? []).map((preceding) =>
      this.#envelopeOf(preceding.type, preceding.payload, {}),
    );
    const envelope = this.#envelopeOf(type, payload, linkage);
    return this.#sessionEvents.append(envelope, {
      monotonicNs: this.#monotonicNow(),
      // Spread, because `exactOptionalPropertyTypes` rejects an explicit `undefined`.
      ...(linkage.transactionalPrelude !== undefined
        ? { transactionalPrelude: linkage.transactionalPrelude }
        : {}),
      ...(linkage.content !== undefined ? { content: linkage.content } : {}),
      ...(precedingEvents.length > 0 ? { precedingEvents } : {}),
    });
  }

  #envelopeOf(
    type: SessionEventType,
    payload: AppendedPayload,
    linkage: Pick<SessionEventLinkage, "correlationId" | "causationId">,
  ): UnsequencedEventEnvelope {
    // Looked up from the registry: the strict layer refuses an envelope whose category disagrees
    // with its type.
    const category: EventCategory | undefined = SESSION_EVENT_CATEGORY_BY_TYPE.get(type);
    if (category === undefined) {
      throw new Error(
        `No category is registered for event type "${type}": an appended type must be present ` +
          "in SESSION_EVENT_CATEGORY_BY_TYPE for the strict layer to interpret what is written.",
      );
    }
    return {
      id: this.#newEventId(),
      sessionId: payload.sessionId,
      occurredAt: this.#now(),
      category,
      type,
      actor: payload.actor ?? null,
      payload: { ...payload },
      // Absent, not null: the correlation pair is optional and not nullable on the envelope.
      ...(linkage.correlationId != null ? { correlationId: linkage.correlationId } : {}),
      ...(linkage.causationId != null ? { causationId: linkage.causationId } : {}),
      version: this.#version,
    };
  }
}
