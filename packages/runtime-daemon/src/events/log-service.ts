// EventLogService: the only append path for `session_events`. Three obligations meet in
// `append()`:
// - Serialization: the database writer reads the session's head and writes the row in one step on
//   its own connection, so two appends never share a sequence. `append()` takes
//   `withSessionAppendLock` only to hand its row to the writer, so it lands behind a caller
//   holding the session across its own read-decide-write, and lets the lock go before the commit,
//   so a session's appends share batches.
// - Content: machine-authored prose is kept in `content_payload` beside the event, and the payload
//   gains the members that describe it; both are written as a unit.
// - Dual-write: `options.transactionalPrelude` holds statements committed in the same write just
//   before the row. A producer whose event depends on its own row's state guards a statement with
//   the row count it expects, so a moved state refuses the write and consumes no sequence.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../database/messages.js";
import type { DatabaseWriter, EventWriteOutcome } from "../database/writer.js";
import { canonicalizeEvent, normalizeOccurredAt } from "./canonicalizer.js";
import {
  assertNoSeededContentDescription,
  assertRegisteredVariantParses,
  composeContentRow,
} from "./content/append.js";
import { withSessionAppendLock } from "./session/append-lock.js";

/**
 * The append input: an {@link EventEnvelope} without `sequence`, which the writer allocates; the
 * receipt returns it.
 */
export type UnsequencedEventEnvelope = Omit<EventEnvelope, "sequence">;

/**
 * What {@link EventLogService.append} returns once the write has settled: the stored event's
 * sequence, or, for an assistant's thinking update met by a full write queue, that it was dropped.
 * `id` is echoed from the input.
 */
export type EventLogAppendReceipt =
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

/** Options for one {@link EventLogService.append}. */
export interface EventLogAppendOptions {
  /**
   * Statements committed in the same write just before the row. A statement whose row count is
   * not the one it expects refuses the write with `WriteRefusedError`, and nothing of it is kept.
   */
  readonly transactionalPrelude?: readonly WriteStatement[];

  /**
   * The content partition. Only the body-bearing types (`BODY_BEARING_EVENT_TYPES`) take one; any
   * other type is refused.
   */
  readonly content?: EventLogAppendContent;

  /** `monotonic_ns`: within-daemon ordering only, never the order key; defaults to the clock. */
  readonly monotonicNs?: bigint;
}

/** Construction dependencies. */
export interface EventLogServiceDeps {
  /** The writer every append goes through. */
  readonly writer: Pick<DatabaseWriter, "appendEvent">;
  /** `monotonic_ns` default source. Defaults to `process.hrtime.bigint()`. */
  readonly monotonicNow?: () => bigint;
}

// The writer allocates the real sequence; composition checks the envelope with this one.
const UNALLOCATED_SEQUENCE = 0;

/** The sole append path for `session_events`; see the file header. */
export class EventLogService {
  readonly #writer: Pick<DatabaseWriter, "appendEvent">;
  readonly #monotonicNow: () => bigint;

  constructor(deps: EventLogServiceDeps) {
    this.#writer = deps.writer;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
  }

  /**
   * Appends one event and resolves once it has committed, with its allocated `sequence`. Refuses
   * with a seeded content description member, a content partition on a type that carries none, a
   * failed strict-variant parse, or a payload with no canonical form. An event is never refused
   * for its size.
   */
  async append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt> {
    const sessionId: SessionId = envelope.sessionId;
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
    const row = {
      id: composed.envelope.id,
      session_id: sessionId,
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

    // The lock is held only while the row joins the writer's queue; the result is boxed so the
    // lock's own promise settles before the commit does.
    const queued = await withSessionAppendLock(sessionId, () =>
      Promise.resolve({
        outcome: this.#writer.appendEvent(row, options?.transactionalPrelude ?? []),
      }),
    );
    const outcome: EventWriteOutcome = await queued.outcome;
    return outcome.isStored
      ? { isStored: true, id: row.id, sequence: outcome.sequence }
      : { isStored: false, id: row.id };
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
