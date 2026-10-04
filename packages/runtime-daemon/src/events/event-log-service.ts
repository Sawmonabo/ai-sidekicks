// EventLogService: the only durable append path for `session_events`. Three obligations are only
// jointly satisfiable in `append()` under one lock:
// - Serialization: `append()` reads the head and writes the row with no await between, and takes
//   `withSessionAppendLock` so it waits behind a caller holding the session across its own
//   read-decide-write instead of landing between that caller's read and its write.
// - Content: machine-authored prose is kept in `content_payload` beside the event, and the payload
//   gains the members that describe it; both are written as a unit.
// - Dual-write: `options.transactionalPrelude` is a synchronous closure run in the same transaction
//   just before the INSERT, because a better-sqlite3 transaction cannot span an `await`. The
//   append lock is keyed on `sessionId`, so a producer whose event depends on its own row
//   re-checks that state as the prelude's first statement and throws if it moved; an abort
//   consumes no sequence.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event-envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import type { Database, Statement } from "better-sqlite3";

import { canonicalizeEvent, normalizeOccurredAt } from "./canonicalizer.js";
import {
  assertNoSeededContentDescription,
  assertRegisteredVariantParses,
  composeContentRow,
} from "./event-content.js";
import { withSessionAppendLock } from "./session-append-lock.js";

/**
 * The append input: an {@link EventEnvelope} without `sequence`, which the service allocates under
 * the lock; the receipt returns it.
 */
export type UnsequencedEventEnvelope = Omit<EventEnvelope, "sequence">;

/** What a successful {@link EventLogService.append} returns; `id` is echoed from the input. */
export interface EventLogAppendReceipt {
  readonly id: string;
  readonly sequence: number;
}

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
   * A synchronous write on the same connection, committed atomically with this row just before the
   * INSERT. It must only write, since the payload was composed and measured before the transaction
   * opened; a throw aborts before the INSERT and reaches the caller unchanged.
   */
  readonly transactionalPrelude?: () => void;

  /**
   * The content partition. Only the body-bearing types (`BODY_BEARING_EVENT_TYPES`) take one; any
   * other type is refused.
   */
  readonly content?: EventLogAppendContent;

  /** `monotonic_ns`: within-daemon ordering only, never the replay key; defaults to the clock. */
  readonly monotonicNs?: bigint;
}

/** Construction dependencies. */
export interface EventLogServiceDeps {
  /** The connection every write lands on. */
  readonly db: Database;
  /** `monotonic_ns` default source. Defaults to `process.hrtime.bigint()`. */
  readonly monotonicNow?: () => bigint;
}

/** The head row read under the lock; `sequence` is `unknown` (SQLite does not enforce types). */
interface HeadRow {
  readonly sequence: unknown;
}

/** The sole durable append path for `session_events`; see the file header. */
export class EventLogService {
  readonly #insertStmt: Statement;
  readonly #headStmt: Statement;
  // IMMEDIATE takes the writer lock at BEGIN, so concurrent writers wait there instead of failing
  // at write-upgrade with SQLITE_BUSY_SNAPSHOT, which `busy_timeout` cannot absorb.
  readonly #writeTxn: (bindings: InsertBindings, prelude: (() => void) | undefined) => void;
  readonly #monotonicNow: () => bigint;

  constructor(deps: EventLogServiceDeps) {
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());

    this.#insertStmt = deps.db.prepare(
      `INSERT INTO session_events (
         id, session_id, sequence, occurred_at, monotonic_ns,
         category, type, actor, payload,
         correlation_id, causation_id, version, content_payload
       ) VALUES (
         @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
         @category, @type, @actor, @payload,
         @correlation_id, @causation_id, @version, @content_payload
       )`,
    );

    // `safeIntegers` reads the INTEGER as a bigint, lossless up to `EVENT_ENVELOPE_SEQUENCE_MAX`.
    this.#headStmt = deps.db
      .prepare(
        `SELECT sequence
           FROM session_events
          WHERE session_id = ?
          ORDER BY sequence DESC
          LIMIT 1`,
      )
      .safeIntegers(true);

    const writeTxn = deps.db.transaction(
      (bindings: InsertBindings, prelude: (() => void) | undefined): void => {
        // Prelude first, row last, so a throwing INSERT rolls the prelude back.
        prelude?.();
        const result = this.#insertStmt.run(bindings);
        if (result.changes !== 1) {
          // Unreachable through a plain INSERT, but a silent zero would report a sequence for a
          // row that is not durable.
          throw new Error(
            `EventLogService.append: expected 1 row inserted, got ${String(result.changes)} ` +
              `for session=${bindings.session_id} sequence=${String(bindings.sequence)}`,
          );
        }
      },
    );
    this.#writeTxn = (bindings, prelude) => {
      writeTxn.immediate(bindings, prelude);
    };
  }

  /**
   * Appends one event under the per-session append lock (reentrant) and returns its allocated
   * `sequence`. Refuses with a seeded content description member, a content partition on a type
   * that carries none, a failed strict-variant parse, or a payload with no canonical form. An
   * event is never refused for its size.
   */
  async append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt> {
    const sessionId: SessionId = envelope.sessionId;
    return withSessionAppendLock(sessionId, async () => {
      // Checked before `options.content` picks the branch: seeding `contentLength` without content
      // would otherwise take the plain branch and be stored as given. Runs for tolerant carriers
      // too.
      assertNoSeededContentDescription(envelope.payload, "EventLogService.append");

      const head: HeadRow | undefined = this.#headStmt.get(sessionId) as HeadRow | undefined;
      const sequence: number =
        head === undefined ? 0 : Number(narrowHeadSequence(head.sequence, sessionId)) + 1;

      // The normalized `occurredAt` is what is persisted. `actor` narrows to `string | null`:
      // storage holds absent and `null` as one NULL while the canonical bytes distinguish them, so
      // the size ceiling is measured over the stored form.
      const normalizedOccurredAt: string = normalizeOccurredAt(envelope.occurredAt);
      const narrowedActor: string | null = envelope.actor ?? null;

      const composed: ComposedEventRow = composeRow(
        {
          ...envelope,
          sequence,
          occurredAt: normalizedOccurredAt,
          actor: narrowedActor,
        },
        options?.content,
      );

      // Everything bound comes from `composed`, never the caller's input: its envelope carries the
      // normalized `occurredAt` and the content members measured from the body it stores.
      this.#writeTxn(
        {
          id: composed.envelope.id,
          session_id: sessionId,
          sequence,
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
        },
        options?.transactionalPrelude,
      );

      const receipt: EventLogAppendReceipt = {
        id: composed.envelope.id,
        sequence,
      };

      return receipt;
    });
  }
}

/**
 * Composes the stored form: the envelope as it will be written and, on a content-bearing append,
 * the body `content_payload` holds. Both are checked against the registered variant and
 * canonicalized before the transaction opens.
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
  // surrogate, which SQLite would store as U+FFFD, or a sequence past the safe integers.
  canonicalizeEvent(composed.envelope);
  return composed;
}

/**
 * The stored head `sequence`, checked rather than asserted: `#headStmt` reads an INTEGER as a
 * `bigint`, and anything else (affinity leaves non-numeric TEXT and REAL as is) would become `NaN`
 * or a fractional sequence after `Number(...) + 1`.
 */
function narrowHeadSequence(value: unknown, sessionId: SessionId): bigint {
  if (typeof value !== "bigint") {
    throw new Error(
      `session_events.sequence for session ${sessionId} is not an INTEGER: got a value of ` +
        `type ${typeof value}. The column is declared INTEGER NOT NULL and this statement ` +
        `reads it with safeIntegers, so a non-bigint value means the row was written or ` +
        `altered outside this module. Refusing here rather than allocating the next sequence ` +
        `from it.`,
    );
  }
  return value;
}

/** The bound row, snake_case to match the column names one-for-one. */
interface InsertBindings {
  readonly id: string;
  readonly session_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly monotonic_ns: bigint;
  readonly category: string;
  readonly type: string;
  readonly actor: string | null;
  readonly payload: string;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly version: string;
  readonly content_payload: string | null;
}

/** The persistables, whichever path produced them. */
interface ComposedEventRow {
  readonly envelope: EventEnvelope;
  readonly storedBody: string | undefined;
}
