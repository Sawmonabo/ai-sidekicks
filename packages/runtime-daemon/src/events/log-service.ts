// EventLogService: the only append path for `session_events`. Four obligations meet here:
// - Order: the database writer reads the session's head and writes the row in one step on its own
//   connection, so two appends never share a sequence. An append takes the session's append lock
//   only while its row joins the writer's queue, so a caller holding the session sees its rows
//   land in the order it appended them, and lets it go before the commit, so a session's appends
//   share batches. The lock orders writes and nothing more: a read that decides a write goes inside
//   that write as a guarded statement in `transactionalPrelude`.
// - Content: machine-authored prose is kept in `content_payload` beside the event, and the payload
//   gains the members that describe it; both are written as a unit.
// - Dual-write: `transactionalPrelude` holds statements committed in the same write just before the
//   row, then the projection statements the service was built with. A guarded statement carries the
//   row count it expects, so a moved state refuses the write and consumes no sequence.
// - Reads and follow: the log is read on the read-only connection after a cursor or over a window,
//   and each committed event is published to the session's followers in sequence order, after the
//   append's outcome is settled, so no follower's fault reaches the append or the process.

import type { Database } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import {
  START_OF_LOG_POSITION,
  decodeEventCursor,
  encodeEventCursor,
  type EventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";
import { EventCursorUnresolvableError } from "@ai-sidekicks/contracts/error";

import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { WriteStatement } from "../database/statement.js";
import type { DatabaseWriter } from "../database/writer.js";
import { canonicalizeEvent, normalizeOccurredAt } from "./canonicalizer.js";
import {
  assertNoSeededContentDescription,
  assertRegisteredVariantParses,
  composeContentRow,
} from "./content/append.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";
import { sessionAppendLock } from "./session/append-lock.js";
import { SessionEventFollowers, type SessionEventListener } from "./session/followers.js";
import type { SessionEventRow } from "./session/insert.js";
import { prepareSessionEventReads, type SessionEventReads } from "./session/read.js";

/**
 * The append input: an {@link EventEnvelope} without `sequence`, which the writer allocates; the
 * receipt returns it.
 */
export type UnsequencedEventEnvelope = Omit<EventEnvelope, "sequence">;

/**
 * What {@link EventLogService.append} returns once the event has committed; `id` is the input's.
 */
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
  /** The read-only connection the log's reads and catch-ups run on. */
  readonly reader: Database;
  /**
   * Statements that keep a projection in step with the log, committed in each append's write after
   * its `transactionalPrelude` and before the row. Receives the envelope as it will be stored. A
   * thinking update takes none.
   */
  readonly projectionStatements?: (envelope: UnsequencedEventEnvelope) => readonly WriteStatement[];
  /**
   * Where the followers' failures that no follower hears are written: a follower of every session
   * that threw, and a session's missing events that could not be read.
   */
  readonly writeServiceLog: ServiceLogWriter;
  /** The most events one catch-up page reads before it waits for the next turn. Defaults to 100. */
  readonly catchUpPageSize?: number;
  /** `monotonic_ns` default source. Defaults to `process.hrtime.bigint()`. */
  readonly monotonicNow?: () => bigint;
}

/** What {@link EventLogService.readAfterCursor} takes. */
export interface EventReadAfterCursorRequest {
  readonly sessionId: SessionId;
  /** The position to read after; absent reads from the start of the log. */
  readonly afterCursor?: EventCursor | undefined;
  /** The most events returned. Defaults to 100. */
  readonly limit?: number | undefined;
}

/** What {@link EventLogService.readAfterCursor} returns. */
export interface EventReadAfterCursorResponse {
  /** The events after the cursor, in sequence order. */
  readonly events: readonly EventEnvelope[];
  /** Resumes right after the last event returned; when none was, the position read after. */
  readonly nextCursor: EventCursor;
  /** Whether the limit left events beyond `nextCursor`. */
  readonly hasMore: boolean;
}

/** What {@link EventLogService.readWindow} takes: both sequences are included. */
export interface EventReadWindowRequest {
  readonly sessionId: SessionId;
  readonly fromSequence: number;
  readonly toSequence: number;
}

/** What {@link EventLogService.readWindow} returns. */
export interface EventReadWindowResponse {
  /** The window's events, in sequence order. */
  readonly events: readonly EventEnvelope[];
}

// The most events a read after a cursor returns when the caller names no limit.
const DEFAULT_EVENT_READ_LIMIT = 100;

// The writer allocates the real sequence; composition checks the envelope with this one.
const UNALLOCATED_SEQUENCE = 0;

/** The sole append path for `session_events`, its reads and its followers; see the file header. */
export class EventLogService {
  readonly #writer: Pick<DatabaseWriter, "appendEvents" | "appendThinkingUpdate">;
  readonly #reads: SessionEventReads;
  readonly #followers: SessionEventFollowers;
  readonly #projectionStatements: (envelope: UnsequencedEventEnvelope) => readonly WriteStatement[];
  readonly #monotonicNow: () => bigint;

  constructor(deps: EventLogServiceDeps) {
    this.#writer = deps.writer;
    this.#reads = prepareSessionEventReads(deps.reader);
    this.#followers = new SessionEventFollowers(
      this.#reads,
      deps.catchUpPageSize ?? DEFAULT_EVENT_READ_LIMIT,
      deps.writeServiceLog,
    );
    this.#projectionStatements = deps.projectionStatements ?? (() => []);
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());
  }

  /**
   * Appends one event, after any `precedingEvents`, and resolves once it has committed, with its
   * allocated `sequence`. Refuses an assistant's thinking update, which goes through
   * {@link appendThinkingUpdate}, a preceding event of another session, a seeded content
   * description member, a content partition on a type that carries none, a failed strict-variant
   * parse, or a payload with no canonical form. An event is never refused for its size.
   */
  async append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt> {
    // One clock reading for every event of the write.
    const monotonicNs = options?.monotonicNs ?? this.#monotonicNow();
    const preceding = (options?.precedingEvents ?? []).map((precedingEvent) => {
      if (precedingEvent.sessionId !== envelope.sessionId) {
        throw new Error(
          `A preceding ${precedingEvent.type} event of session ${precedingEvent.sessionId} cannot ` +
            `share the write of an event of session ${envelope.sessionId}`,
        );
      }
      return this.#composeRow(precedingEvent, { monotonicNs });
    });
    const composed = this.#composeRow(envelope, { ...options, monotonicNs });
    const written = [...preceding, composed];
    const statements = [
      ...(options?.transactionalPrelude ?? []),
      ...written.flatMap((event) => this.#projectionStatements(event.storedEnvelope)),
    ];
    const queued = await this.#queueInSessionOrder(envelope.sessionId, () =>
      this.#writer.appendEvents(
        written.map((event) => event.row),
        statements,
      ),
    );
    const committed = written.flatMap((event, index) => {
      const sequence = queued.outcome[index];
      return sequence === undefined ? [] : [{ ...event.storedEnvelope, sequence }];
    });
    const sequence = committed.at(-1)?.sequence;
    if (sequence === undefined || committed.length !== written.length) {
      queued.settle();
      throw new Error("The database writer committed the events without their sequences");
    }
    this.#publishCommitted(committed, queued.settle);
    return { id: composed.row.id, sequence };
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
    const composed = this.#composeRow(envelope, options);
    const { outcome, settle } = await this.#queueInSessionOrder(envelope.sessionId, () =>
      this.#writer.appendThinkingUpdate(composed.row),
    );
    if (!outcome.isStored) {
      settle();
      return { isStored: false, id: composed.row.id };
    }
    this.#publishCommitted([{ ...composed.storedEnvelope, sequence: outcome.sequence }], settle);
    return { isStored: true, id: composed.row.id, sequence: outcome.sequence };
  }

  /**
   * Reads up to `limit` events with a sequence after the cursor's position, in sequence order.
   * Throws `EventCursorUnresolvableError` for a cursor that names no position or one past the
   * session's last event.
   */
  async readAfterCursor(
    request: EventReadAfterCursorRequest,
  ): Promise<EventReadAfterCursorResponse> {
    const afterPosition = this.#resolveCursor(
      request.afterCursor,
      this.#reads.readHead(request.sessionId),
    );
    const limit = request.limit ?? DEFAULT_EVENT_READ_LIMIT;
    // One row past the limit shows whether more remain.
    const page = this.#reads.readAfter(request.sessionId, afterPosition, limit + 1);
    const hasMore = page.length > limit;
    const events = hasMore ? page.slice(0, limit) : page;
    const lastEvent = events.at(-1);
    return {
      events,
      nextCursor: encodeEventCursor(lastEvent === undefined ? afterPosition : lastEvent.sequence),
      hasMore,
    };
  }

  /** Reads the events with a sequence from `fromSequence` to `toSequence`, in sequence order. */
  async readWindow(request: EventReadWindowRequest): Promise<EventReadWindowResponse> {
    return {
      events: this.#reads.readWindow(request.sessionId, request.fromSequence, request.toSequence),
    };
  }

  /**
   * Delivers the session's events after `afterCursor` (all of them when absent), then each one
   * committed afterward, in sequence order with none skipped or repeated, catching up only while
   * the listener has room. Throws `SessionNotFoundError` for a session with no events and
   * `EventCursorUnresolvableError` for a cursor it cannot read, before any change. The first page
   * is delivered before this returns and a failure on it is thrown; a later failure ends the follow
   * through `onFailure`. The detach it returns stops delivery at once, from inside `onChange` too.
   */
  follow(
    sessionId: SessionId,
    afterCursor: EventCursor | undefined,
    listener: SessionEventListener,
  ): () => void {
    const head = this.#reads.readHead(sessionId);
    if (head === undefined) {
      throw new SessionNotFoundError("The session has no events to follow.", { sessionId });
    }
    return this.#followers.follow(sessionId, this.#resolveCursor(afterCursor, head), listener);
  }

  /**
   * Delivers every session's events as they commit, each session's in sequence order, until the
   * returned detach runs. `onGap` hears of a session whose events before a receipt could not be
   * read, just before that receipt, so a follower that keeps state built from events rebuilds that
   * session's from its rows.
   */
  followAll(
    onCommitted: (event: EventEnvelope) => void,
    onGap?: (sessionId: SessionId) => void,
  ): () => void {
    return this.#followers.followAll(onCommitted, onGap);
  }

  // The position a cursor names, checked against the session's head; absent is the start of the
  // log. The head is read before any page, so a cursor past it cannot pass on a later commit.
  #resolveCursor(cursor: EventCursor | undefined, head: number | undefined): number {
    if (cursor === undefined) {
      return START_OF_LOG_POSITION;
    }
    const position = decodeEventCursor(cursor);
    if (position > (head ?? START_OF_LOG_POSITION)) {
      throw new EventCursorUnresolvableError(cursor);
    }
    return position;
  }

  // Published in a microtask, in sequence order, so the append's outcome reports only the write;
  // the followers contain their own faults. The settle runs once publishing ends, however it ends.
  #publishCommitted(committed: readonly EventEnvelope[], settle: () => void): void {
    queueMicrotask(() => {
      try {
        for (const event of committed) {
          this.#followers.publish(event);
        }
      } finally {
        settle();
      }
    });
  }

  // Composes the row exactly as it will be stored, checked and canonicalized, and the envelope it
  // stores.
  #composeRow(
    envelope: UnsequencedEventEnvelope,
    options: ThinkingUpdateAppendOptions | undefined,
  ): StoredEventComposition {
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
    const { sequence: _unallocated, ...storedEnvelope } = composed.envelope;
    const row: SessionEventRow = {
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
    return { row, storedEnvelope };
  }

  // Hands the write to the writer under the session's append lock and waits for it outside the
  // lock. The result is boxed so the lock's own promise settles before the commit does. A failed
  // write settles its tracking here; a committed one hands the settle on with its outcome.
  async #queueInSessionOrder<T>(
    sessionId: SessionId,
    queue: () => Promise<T>,
  ): Promise<{ readonly outcome: T; readonly settle: () => void }> {
    const queued = await sessionAppendLock.run(sessionId, () =>
      Promise.resolve({ settle: this.#followers.trackAppend(sessionId), result: queue() }),
    );
    try {
      return { outcome: await queued.result, settle: queued.settle };
    } catch (error) {
      queued.settle();
      throw error;
    }
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

/** One append's row and the envelope it stores, without the sequence the writer allocates. */
interface StoredEventComposition {
  readonly row: SessionEventRow;
  readonly storedEnvelope: UnsequencedEventEnvelope;
}

/** The persistables, whichever path produced them. */
interface ComposedEventRow {
  readonly envelope: EventEnvelope;
  readonly storedBody: string | undefined;
}
