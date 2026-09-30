// EventLogService: the only durable append path for `session_events`. Three obligations are only
// jointly satisfiable in `append()` under one lock:
// - Serialization: `withSessionAppendLock` keeps two appends from allocating the same `sequence`
//   across the awaits between reading the head and writing the row.
// - Serviceability: every canonical form is held to `EVENT_CANONICAL_BYTES_MAX` (one relay frame).
// - Sealing: the codec seals `pii_payload` and `content_payload`; its output is written as a unit.
// Dual-write: `options.transactionalPrelude` is a synchronous closure run in the same transaction
// just before the INSERT, because a better-sqlite3 transaction cannot span an `await`. The append
// lock is keyed on `sessionId`, so a producer whose event depends on its own row re-checks that
// state as the prelude's first statement and throws if it moved; an abort consumes no sequence.
// This service does not write `retention_class`; the purge owns it.

import {
  DAEMON_EVENT_CANONICAL_BYTES_EXCEEDED_CODE,
  DaemonEventCanonicalBytesExceededDetailsSchema,
  EVENT_CANONICAL_BYTES_MAX,
  JsonRpcErrorCode,
  type EventEnvelope,
  type SessionId,
} from "@ai-sidekicks/contracts";
import type { Database, Statement } from "better-sqlite3";

import { DaemonDomainError } from "../ipc/domain-error.js";
import { canonicalizeEvent, normalizeOccurredAt, type CanonicalBytes } from "./canonicalizer.js";
import {
  assertNoCodecOwnedContentKeys,
  assertRegisteredVariantParses,
  writeEventWithPii,
  type EventContentInput,
  type PiiEligibleCategory,
  type PiiEncryptor,
  type PiiEventWriteResult,
  type RawEventInput,
} from "./pii-indirection.js";
import { withSessionAppendLock } from "./session-append-lock.js";
import type {
  SessionContentKeyDisposer,
  SessionContentKeySource,
} from "./session-content-key-store.js";

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

/** The PII half of an append; supplying it routes the write through the sealing codec. */
interface EventLogAppendPii {
  /** Whose content key seals `piiPayload`, and the value for the stamp column. */
  readonly userId: string;
  /** The PII half of the split — encrypted into `pii_payload`. */
  readonly piiPayload: Record<string, unknown>;
}

/**
 * The machine-authored content partition (assistant or tool prose) for `content_payload`: a body
 * only. The codec mints `contentLength` and `contentTruncated`; supplying either is refused.
 */
interface EventLogAppendContent {
  /** The prose. Over-bound bodies are truncated at a codepoint boundary. */
  readonly body: string;
}

/** Handed to the codec on a content-only row; calling it is a routing defect, so it throws. */
const UNWIRED_PII_ENCRYPTOR: PiiEncryptor = {
  encrypt: () =>
    Promise.reject(
      new Error(
        "EventLogService routed a PII partition to the sealing codec with no PiiEncryptor wired. " +
          "The append path refuses that combination before the codec runs, so reaching this is an " +
          "append-path routing defect.",
      ),
    ),
};

/** Options for one {@link EventLogService.append}. */
export interface EventLogAppendOptions {
  /**
   * A synchronous write on the same connection, committed atomically with this row just before the
   * INSERT. It must only write, since the payload was sealed and measured before the transaction
   * opened; a throw aborts before the INSERT and reaches the caller unchanged.
   */
  readonly transactionalPrelude?: () => void;

  /** The PII partition, routed through the codec; without a `piiEncryptor` the append throws. */
  readonly pii?: EventLogAppendPii;

  /**
   * The content partition, sealed in the same codec call as `pii`. Requires a `contentKeySource`,
   * else the append throws. The codec enforces the body-bearing types (`BODY_BEARING_EVENT_TYPES`),
   * so higher-MINOR types this daemon does not know are not refused here.
   */
  readonly content?: EventLogAppendContent;

  /** `monotonic_ns`: within-daemon ordering only, never the replay key; defaults to the clock. */
  readonly monotonicNs?: bigint;
}

/** Construction dependencies. */
export interface EventLogServiceDeps {
  /** The connection every write lands on. */
  readonly db: Database;
  /** Encryptor for PII partitions; without it a PII-carrying append throws. */
  readonly piiEncryptor?: PiiEncryptor;
  /** Without it a content-carrying append throws. The narrow key-store half: no `rewrapAll`. */
  readonly contentKeySource?: SessionContentKeySource;
  /**
   * Retires the key a content-bearing append minted when that append then failed, since
   * `resolveForWrite` commits its mint before the codec runs. Without it the compactor's sweep
   * reclaims the orphan on a later pass.
   */
  readonly contentKeyDisposer?: SessionContentKeyDisposer;
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
  readonly #piiEncryptor: PiiEncryptor | undefined;
  readonly #contentKeySource: SessionContentKeySource | undefined;
  readonly #contentKeyDisposer: SessionContentKeyDisposer | undefined;
  readonly #monotonicNow: () => bigint;

  constructor(deps: EventLogServiceDeps) {
    this.#piiEncryptor = deps.piiEncryptor;
    this.#contentKeySource = deps.contentKeySource;
    this.#contentKeyDisposer = deps.contentKeyDisposer;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());

    this.#insertStmt = deps.db.prepare(
      `INSERT INTO session_events (
         id, session_id, sequence, occurred_at, monotonic_ns,
         category, type, actor, payload, pii_payload,
         correlation_id, causation_id, version,
         pii_user_id, content_payload
       ) VALUES (
         @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
         @category, @type, @actor, @payload, @pii_payload,
         @correlation_id, @causation_id, @version,
         @pii_user_id, @content_payload
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
   * `sequence`. Refuses with `CodecOwnedContentKeyError`, a failed strict-variant parse, or
   * `daemon.event_canonical_bytes_exceeded` (400); only the last is a `DaemonDomainError`.
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
      assertNoCodecOwnedContentKeys(envelope.payload, "EventLogService.append");

      const head: HeadRow | undefined = this.#headStmt.get(sessionId) as HeadRow | undefined;
      const sequence: number =
        head === undefined ? 0 : Number(narrowHeadSequence(head.sequence, sessionId)) + 1;

      // The normalized `occurredAt` is what is persisted. `actor` narrows to `string | null`:
      // storage holds absent and `null` as one NULL while the canonical bytes distinguish them, so
      // the size ceiling is measured over the stored form.
      const normalizedOccurredAt: string = normalizeOccurredAt(envelope.occurredAt);
      const narrowedActor: string | null = envelope.actor ?? null;

      let composed: ComposedEventRow;
      try {
        composed = await this.#composeRow({
          envelope,
          sequence,
          occurredAt: normalizedOccurredAt,
          actor: narrowedActor,
          ...(options?.pii !== undefined ? { pii: options.pii } : {}),
          ...(options?.content !== undefined ? { content: options.content } : {}),
        });
      } catch (error) {
        // `resolveForWrite` commits its own transaction inside `#composeRow`, so any refusal after
        // it leaves a wrapped key with no body. Reconcile while this append holds the session lock.
        await this.#reconcileOrphanedContentKey(sessionId, options?.content !== undefined);
        throw error;
      }

      // Everything bound comes from `composed`, never the caller's input: its envelope carries the
      // normalized `occurredAt` and content members, and its ciphertexts were sealed for this row.
      try {
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
            pii_payload: composed.piiPayload ?? null,
            correlation_id: composed.envelope.correlationId ?? null,
            causation_id: composed.envelope.causationId ?? null,
            version: composed.envelope.version,
            pii_user_id: composed.piiUserId ?? null,
            content_payload: composed.contentPayload ?? null,
          },
          options?.transactionalPrelude,
        );
      } catch (error) {
        // A throwing prelude or UNIQUE violation rolls the INSERT back, leaving the minted key with
        // no sealed row; after a successful INSERT the disposer would find the row and do nothing.
        await this.#reconcileOrphanedContentKey(sessionId, options?.content !== undefined);
        throw error;
      }

      const receipt: EventLogAppendReceipt = {
        id: composed.envelope.id,
        sequence,
      };

      return receipt;
    });
  }

  /**
   * Retires the wrapped key this append may have just minted when it did not stand. Runs under the
   * failing append's lock and does nothing once any body was sealed; a disposal failure is
   * swallowed so it cannot hide the append's own error, and the compactor's sweep reclaims the key
   * later.
   */
  async #reconcileOrphanedContentKey(
    sessionId: SessionId,
    appendCarriedContent: boolean,
  ): Promise<void> {
    // An append with no content partition never reached the minting path; disposing anyway could
    // delete a key another append is about to seal under.
    if (!appendCarriedContent || this.#contentKeyDisposer === undefined) {
      return;
    }
    try {
      await this.#contentKeyDisposer.deleteIfUnreferenced(sessionId);
    } catch {
      // Swallowed on purpose; see the method doc.
    }
  }

  async #composeRow(input: ComposeRowInput): Promise<ComposedEventRow> {
    const storable: EventEnvelope = {
      ...input.envelope,
      sequence: input.sequence,
      occurredAt: input.occurredAt,
      actor: input.actor,
    };

    // Plain means neither partition, not no PII: `assistant.*` and `tool.*` rows carry machine
    // prose and must reach the codec.
    if (input.pii === undefined && input.content === undefined) {
      // Parsed with the function the codec calls; a type with no registered variant is skipped.
      assertRegisteredVariantParses(storable, {
        name: "EventLogService.append",
        timing:
          "Refused before canonicalization, on a path that seals nothing: the payload the caller supplied is the payload that would be stored.",
      });

      const canonical: CanonicalBytes = canonicalizeEvent(storable);
      // A row too large for one relay frame is refused before any write, never truncated. The
      // sealing branch re-checks on the codec's measurement, which adds the content members.
      if (canonical.length > EVENT_CANONICAL_BYTES_MAX) {
        throw eventCanonicalBytesExceeded(canonical.length, storable.id);
      }
      return {
        envelope: storable,
        piiPayload: undefined,
        piiUserId: undefined,
        contentPayload: undefined,
      };
    }

    if (input.pii !== undefined && this.#piiEncryptor === undefined) {
      // Dropping the partition or writing it into the plain payload would lose or expose user data;
      // a plain Error, since this is a wiring defect.
      throw new Error(
        "EventLogService.append received a PII partition but no PiiEncryptor is wired " +
          ". Refusing rather than persisting user PII outside the" +
          "pii_payload split. Construct the service with `piiEncryptor`.",
      );
    }

    if (input.content !== undefined && this.#contentKeySource === undefined) {
      // Fail loud as for the encryptor: dropping the prose leaves the transcript missing turns, and
      // writing it into `payload` stores it as plaintext.
      throw new Error(
        "EventLogService.append received a content partition but no SessionContentKeySource " +
          "is wired. Refusing rather than dropping machine-authored prose or persisting it in " +
          "the plaintext payload column. Construct the service with `contentKeySource`.",
      );
    }

    // Resolved before the codec runs because it can block on a person (the master key is wiped on
    // an idle timer); the codec takes key material, so the await stays out here. The key is minted
    // on a session's first content-bearing append.
    const contentPartition: EventContentInput | undefined =
      input.content === undefined || this.#contentKeySource === undefined
        ? undefined
        : {
            body: input.content.body,
            contentKey: (await this.#contentKeySource.resolveForWrite(storable.sessionId)).key,
          };

    // The codec is invoked here because the sequence it seals under is allocated only under the
    // lock; the category cast is a narrowing the codec re-checks at runtime.
    const codecCommonFields = {
      id: storable.id,
      sessionId: storable.sessionId,
      sequence: storable.sequence,
      occurredAt: storable.occurredAt,
      type: storable.type,
      actor: input.actor,
      payload: storable.payload,
      version: storable.version,
      ...(storable.correlationId !== undefined ? { correlationId: storable.correlationId } : {}),
      ...(storable.causationId !== undefined ? { causationId: storable.causationId } : {}),
      category: storable.category as PiiEligibleCategory,
    };

    // The arm is chosen, not built from optional spreads: the codec input is a union on which
    // partition is present, and spreads would type-check as the PII arm on a content-only row.
    let codecInput: RawEventInput;
    if (input.pii === undefined) {
      // A checked narrowing, not a cast: `as` would silence the compiler over the failure this
      // guards, prose reaching the codec as `undefined` and the row landing with no body.
      if (contentPartition === undefined) {
        throw new Error(
          "EventLogService.append reached the sealing codec with neither partition resolved: " +
            "the plain branch admits a row with no PII and no content, so this is an append-path " +
            "routing defect rather than a caller error.",
        );
      }
      codecInput = { ...codecCommonFields, content: contentPartition };
    } else {
      codecInput = {
        ...codecCommonFields,
        piiUserId: input.pii.userId,
        piiPayload: input.pii.piiPayload,
        ...(contentPartition !== undefined ? { content: contentPartition } : {}),
      };
    }

    const written: PiiEventWriteResult = await writeEventWithPii(
      codecInput,
      // A refusing stub instead of `undefined` behind a cast: a content-only row never calls the
      // encryptor and the guard above refuses PII without one, so if that changed the stub fails by
      // name instead of with a `TypeError`.
      this.#piiEncryptor ?? UNWIRED_PII_ENCRYPTOR,
    );

    // The same ceiling as the plain branch, on the stored form the codec measured.
    if (written.canonicalByteLength > EVENT_CANONICAL_BYTES_MAX) {
      throw eventCanonicalBytesExceeded(written.canonicalByteLength, storable.id);
    }

    // Every value comes from `written`; nothing is re-derived or re-sealed.
    return {
      envelope: written.envelope,
      piiPayload: written.piiPayload === undefined ? undefined : Buffer.from(written.piiPayload),
      piiUserId: written.piiUserId,
      contentPayload:
        written.contentPayload === undefined ? undefined : Buffer.from(written.contentPayload),
    };
  }
}

/**
 * The stored head `sequence`, checked rather than asserted: `#headStmt` reads an INTEGER as a
 * `bigint`, and anything else (affinity leaves non-numeric TEXT and REAL as is) would become `NaN`
 * or a fractional sequence after `Number(...) + 1`.
 */
function narrowHeadSequence(value: unknown, sessionId: SessionId): bigint {
  if (typeof value !== "bigint") {
    throw new Error(
      `session_events.sequence for session ${sessionId} is not an INTEGER: got a value of type ${typeof value}. The column is declared INTEGER NOT NULL and this statement reads it with safeIntegers, so a non-bigint value means the row was written or altered outside this module. Refusing here rather than allocating the next sequence from it.`,
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
  readonly pii_payload: Buffer | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly version: string;
  readonly pii_user_id: string | null;
  readonly content_payload: Buffer | null;
}

interface ComposeRowInput {
  readonly envelope: UnsequencedEventEnvelope;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly actor: string | null;
  readonly pii?: EventLogAppendPii;
  readonly content?: EventLogAppendContent;
}

/** The persistables, whichever path produced them. */
interface ComposedEventRow {
  readonly envelope: EventEnvelope;
  readonly piiPayload: Buffer | undefined;
  readonly piiUserId: string | undefined;
  readonly contentPayload: Buffer | undefined;
}

/**
 * Builds the `daemon.event_canonical_bytes_exceeded` refusal for both append branches. The detail
 * carries the two sizes only, never the oversized payload.
 */
function eventCanonicalBytesExceeded(
  canonicalByteLength: number,
  eventId: string,
): DaemonDomainError {
  return new DaemonDomainError(
    `event ${eventId} canonicalizes to ${String(canonicalByteLength)} bytes, over the ` +
      `${String(EVENT_CANONICAL_BYTES_MAX)}-byte EVENT_CANONICAL_BYTES_MAX ceiling ` +
      `a row this size could never be` +
      `re-published inside one 64 KB relay frame on backfill seam. Refused` +
      `with no row written. The event payload catalog is metadata-shaped by design — ` +
      `move bulk content behind a reference instead of inlining it.`,
    {
      code: DAEMON_EVENT_CANONICAL_BYTES_EXCEEDED_CODE,
      // InvalidParams: the refusal is structural, so no session state makes the write admissible.
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 400,
      detail: DaemonEventCanonicalBytesExceededDetailsSchema.parse({
        canonicalBytes: canonicalByteLength,
        maxCanonicalBytes: EVENT_CANONICAL_BYTES_MAX,
      }),
    },
  );
}
