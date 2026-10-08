// EventLogService: the only append path for `session_events`. Three obligations meet here:
// - Order: the database writer reads the session's head and writes the row in one step on its own
//   connection, so two appends never share a sequence. An append takes the session's append lock
//   only while its row joins the writer's queue, so a caller holding the session sees its rows
//   land in the order it appended them, and lets it go before the commit, so a session's appends
//   share batches. The lock orders writes and nothing more: a read that decides a write goes inside
//   that write as a guarded statement in `transactionalPrelude`.
// - Content: machine-authored prose is kept in `content_payload` beside the event, and the payload
//   gains the members that describe it; both are written as a unit.
// - Dual-write: `transactionalPrelude` holds statements committed in the same write just before the
//   row. A guarded statement carries the row count it expects, so a moved state refuses the write
//   and consumes no sequence.
// - Refusal: a session that takes no writes, its history damaged, refuses the append before
//   anything is queued.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../database/statement.js";
import type { DatabaseWriter } from "../database/writer.js";
import { canonicalizeEvent, normalizeOccurredAt } from "./canonicalizer.js";
import {
  assertNoSeededContentDescription,
  assertRegisteredVariantParses,
  composeContentRow,
} from "./content/append.js";
import { sessionAppendLock } from "./session/append-lock.js";
import type { SessionEventRow } from "./session/insert.js";

/**
 * The append input: an {@link EventEnvelope} without `sequence`, which the writer allocates; the
 * receipt returns it.
 */
export type UnsequencedEventEnvelope = Omit<EventEnvelope, "sequence">;

/** What {@link EventLogService.append} returns once the event has committed; `id` is the input's. */
export interface EventLogAppendReceipt {
  readonly id: string;
  readonly sequence: number;
}

/**
 * What {@link EventLogService.appendThinkingUpdate} returns: the stored update's sequence, or that
 * the full write queue dropped it. `id` is the input's.
 */
export type ThinkingUpdateReceipt =
  | { readonly isStored: true; readonly id: string; readonly sequence: number }
  | { readonly isStored: false; readonly id: string };

/**
 * The machine-authored content partition (assistant or tool prose) for `content_payload`: a body
 * only. The append path writes `contentLength` and `contentTruncated`; supplying either is refused.
 */
interface EventLogAppendContent {
  /** The prose. Over-bound bodies are truncated at a codepoint boundary. */
  readonly body: string;
}

/** Options for one {@link EventLogService.appendThinkingUpdate}. */
export interface ThinkingUpdateAppendOptions {
  /**
   * The content partition. Only the body-bearing types (`BODY_BEARING_EVENT_TYPES`) take one; any
   * other type is refused.
   */
  readonly content?: EventLogAppendContent;

  /** `monotonic_ns`: within-daemon ordering only, never the order key; defaults to the clock. */
  readonly monotonicNs?: bigint;
}

/** Options for one {@link EventLogService.append}. */
export interface EventLogAppendOptions extends ThinkingUpdateAppendOptions {
  /**
   * Statements committed in the same write just before the row. A statement whose row count is
   * not the one it expects refuses the write with `WriteRefusedError`, and nothing of it is kept.
   */
  readonly transactionalPrelude?: readonly WriteStatement[];

  /**
   * Events of the same session committed in the same write, in order, just before this one, each
   * at its own sequence; each is checked as this one is and carries no content.
   */
  readonly precedingEvents?: readonly UnsequencedEventEnvelope[];
}

/** Construction dependencies. */
export interface EventLogServiceDeps {
  /** The writer every append goes through. */
  readonly writer: Pick<DatabaseWriter, "appendEvents" | "appendThinkingUpdate">;
  /** `monotonic_ns` default source. Defaults to `process.hrtime.bigint()`. */
  readonly monotonicNow?: () => bigint;
  /** Throws when the session takes no event of `eventType`; every append is taken when absent. */
  readonly refuseSessionWrite?: (sessionId: SessionId, eventType: string) => void;
}

// The writer allocates the real sequence; composition checks the envelope with this one.
const UNALLOCATED_SEQUENCE = 0;

/** The sole append path for `session_events`; see the file header. */
export class EventLogService {
  readonly #writer: Pick<DatabaseWriter, "appendEvents" | "appendThinkingUpdate">;
  readonly #monotonicNow: () => bigint;
  readonly #refuseSessionWrite: (sessionId: SessionId, eventType: string) => void;

  constructor(deps: EventLogServiceDeps) {
    this.#writer = deps.writer;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
    this.#refuseSessionWrite = deps.refuseSessionWrite ?? (() => {});
  }

  /**
   * Appends one event, after any `precedingEvents`, and resolves once it has committed, with its
   * allocated `sequence`. Refuses an assistant's thinking update, which goes through
   * {@link appendThinkingUpdate}, a preceding event of another session, a seeded content
   * description member, a content partition on a type that carries none, a failed strict-variant
   * parse, a payload with no canonical form, or an event of a session that takes no writes. An
   * event is never refused for its size.
   */
  async append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt> {
    this.#refuseSessionWrite(envelope.sessionId, envelope.type);
    // One clock reading for every event of the write.
    const monotonicNs = options?.monotonicNs ?? this.#monotonicNow();
    const precedingRows = (options?.precedingEvents ?? []).map((preceding) => {
      if (preceding.sessionId !== envelope.sessionId) {
        throw new Error(
          `A preceding ${preceding.type} event of session ${preceding.sessionId} cannot share ` +
            `the write of an event of session ${envelope.sessionId}`,
        );
      }
      return this.#composeRow(preceding, { monotonicNs });
    });
    const row = this.#composeRow(envelope, { ...options, monotonicNs });
    const sequences = await this.#queueInSessionOrder(envelope.sessionId, () =>
      this.#writer.appendEvents([...precedingRows, row], options?.transactionalPrelude),
    );
    const sequence = sequences.at(-1);
    if (sequence === undefined) {
      throw new Error("The database writer committed the event without a sequence");
    }
    return { id: row.id, sequence };
  }

  /**
   * Appends one assistant thinking update, which a full write queue drops rather than waits on.
   * Resolves once it has committed or been dropped; refuses any other type and refuses as
   * {@link append} does.
   */
  async appendThinkingUpdate(
    envelope: UnsequencedEventEnvelope,
    options?: ThinkingUpdateAppendOptions,
  ): Promise<ThinkingUpdateReceipt> {
    this.#refuseSessionWrite(envelope.sessionId, envelope.type);
    const row = this.#composeRow(envelope, options);
    const outcome = await this.#queueInSessionOrder(envelope.sessionId, () =>
      this.#writer.appendThinkingUpdate(row),
    );
    return outcome.isStored
      ? { isStored: true, id: row.id, sequence: outcome.sequence }
      : { isStored: false, id: row.id };
  }

  // Composes the row exactly as it will be stored, checked and canonicalized.
  #composeRow(
    envelope: UnsequencedEventEnvelope,
    options: ThinkingUpdateAppendOptions | undefined,
  ): SessionEventRow {
    // Checked before `options.content` picks the branch: seeding `contentLength` without content
    // would otherwise take the plain branch and be stored as given. Runs for tolerant carriers too.
    assertNoSeededContentDescription(envelope.payload, "EventLogService.append");

    // The normalized `occurredAt` is what is persisted. `actor` narrows to `string | null`: storage
    // holds absent and `null` as one NULL while the canonical bytes distinguish them, so the size
    // ceiling is measured over the stored form.
    const composed: ComposedEventRow = composeRow(
      {
        ...envelope,
        sequence: UNALLOCATED_SEQUENCE,
        occurredAt: normalizeOccurredAt(envelope.occurredAt),
        actor: envelope.actor ?? null,
      },
      options?.content,
    );

    // Everything bound comes from `composed`, never the caller's input: its envelope carries the
    // normalized `occurredAt` and the content members measured from the body it stores.
    return {
      id: composed.envelope.id,
      session_id: envelope.sessionId,
      occurred_at: composed.envelope.occurredAt,
      monotonic_ns: options?.monotonicNs ?? this.#monotonicNow(),
      category: composed.envelope.category,
      type: composed.envelope.type,
      actor: composed.envelope.actor ?? null,
      payload: JSON.stringify(composed.envelope.payload),
      correlation_id: composed.envelope.correlationId ?? null,
      causation_id: composed.envelope.causationId ?? null,
      version: composed.envelope.version,
      content_payload: composed.storedBody ?? null,
    };
  }

  // Hands the write to the writer under the session's append lock and waits for it outside the
  // lock. The result is boxed so the lock's own promise settles before the commit does.
  async #queueInSessionOrder<T>(sessionId: SessionId, queue: () => Promise<T>): Promise<T> {
    const queued = await sessionAppendLock.run(sessionId, () =>
      Promise.resolve({ result: queue() }),
    );
    return queued.result;
  }
}

/**
 * Composes the stored form: the envelope as it will be written and, on a content-bearing append,
 * the body `content_payload` holds. Both are checked against the registered variant and
 * canonicalized before the row goes to the writer.
 */
function composeRow(
  storable: EventEnvelope,
  content: EventLogAppendContent | undefined,
): ComposedEventRow {
  const composed: ComposedEventRow =
    content === undefined
      ? { envelope: storable, storedBody: undefined }
      : composeContentRow(storable, content.body);
  assertRegisteredVariantParses(composed.envelope, "EventLogService.append");
  // Refuses before any write what the stored row could not hold faithfully: an unpaired
  // surrogate, which SQLite would store as U+FFFD. The writer refuses an unsafe sequence.
  canonicalizeEvent(composed.envelope);
  return composed;
}

/** The persistables, whichever path produced them. */
interface ComposedEventRow {
  readonly envelope: EventEnvelope;
  readonly storedBody: string | undefined;
}
