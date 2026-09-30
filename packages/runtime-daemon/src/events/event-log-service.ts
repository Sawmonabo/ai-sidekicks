// EventLogService — the SOLE durable append path for
// `session_events`.
//
// Everything that lands a row in the log goes through `append()`. That is not a
// style preference: the append path holds three obligations that are only
// jointly satisfiable in one place, under one lock.
//
//   1. SERIALIZATION. A row's `sequence` is its predecessor's plus one.
//      Producing a row means read-the-head then write-the-successor, and this
//      path is async between those steps. `withSessionAppendLock` is what keeps
//      two appends from allocating the same sequence. See
//      `session-append-lock.ts` for why a mutex is unavoidable here.
//   2. SERVICEABILITY. Every row's canonical form is held to
//      `EVENT_CANONICAL_BYTES_MAX`, measured over the bytes of the row being
//      written, so no stored row is too large to ride one relay frame.
//   3. The `pii_payload` and `content_payload` partitions are sealed by the
//      codec, whose output this path writes as a unit — so this path invokes the
//      codec rather than accepting its output.
//
// SEQUENCE ALLOCATION LIVES HERE, and that is a deliberate move rather than an
// incidental one. the emitter used to allocate by reading the log and adding
// one, which was atomic only because its read and its append were separated by
// no `await`. Producers are async now, so that window spans awaits and two
// concurrent appends on one session would allocate the same number — one losing
// to `UNIQUE(session_id, sequence)` on a legitimate write. Reading the head and
// writing the successor inside a single lock hold closes it by construction,
// which is why the receipt returns `sequence`: the caller learns what it got,
// it does not choose it.
//
// ----------------------------------------------------------------------------
// The atomicity boundary: `transactionalPrelude`
// ----------------------------------------------------------------------------
//
// 005 producers ship a DUAL-WRITE: they upsert their own table AND emit an
// event, inside ONE better-sqlite3 transaction, with the table write FIRST and
// the emit LAST — so a throwing emit rolls back the table write. That property
// must survive this service becoming async, and better-sqlite3 transactions are
// synchronous and cannot span an `await`.
//
// `options.transactionalPrelude` is the seam that preserves it: a SYNCHRONOUS
// closure executed inside the SAME transaction as the row INSERT, immediately
// BEFORE it. The producer hands its table write as the prelude; both commit
// atomically, in the shipped body order, and a throwing INSERT (a UNIQUE
// violation, a terminal-key trigger ABORT) rolls the prelude back. The producer
// wraps its whole read-decide-write in `withSessionAppendLock` and the nested
// `append()` reuses that hold through owner-scoped reentrancy.
//
// WHAT THE PRELUDE HAS TO DO. A producer whose event PAYLOAD depends on a read
// of its own state cannot run that read inside the write transaction: sealing
// depends on the payload, and sealing is async. No ordering exists in which the
// read is inside the transaction that ends with the INSERT.
//
// The append lock does NOT cover the resulting window, and it is important not
// to claim otherwise: the lock is keyed on `sessionId`, while a producer's
// hazard is keyed on its own row. Two appends that touch the same row under
// DIFFERENT sessions hold DIFFERENT locks and are ordered by nothing — on ONE
// connection as much as on two.
//
// The window is closed by the PRELUDE, which is exactly why the prelude runs
// inside the transaction rather than beside it: the producer re-checks its
// decision-time state as the prelude's first statement (a re-read or a
// compare-and-swap `UPDATE`), inside `BEGIN IMMEDIATE`, and throws if it moved.
// That throw aborts the whole transaction — durable write undone, INSERT never
// reached, no sequence consumed, so a retry re-derives its sequence from the
// durable head. This service supplies the mechanism (a synchronous prelude
// inside an IMMEDIATE transaction whose throw rolls everything back); the
// producers own the comparison and what an abort means, because only they know
// what "unchanged" means for their state.
//
// ----------------------------------------------------------------------------
// What this service does NOT do
// ----------------------------------------------------------------------------
//
//   * It does not write `retention_class` — the purge owns that column.
//   * It scaffolds no composition root. There is no production construction
//     site for its producers yet.
//

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
 * The append input: a canonical {@link EventEnvelope} MINUS its `sequence`.
 *
 * `sequence` is omitted rather than ignored. This service allocates it under
 * the lock (see the file header), so a caller-supplied value could only be
 * silently discarded — and a discarded `sequence` is the kind of input a
 * producer would reasonably believe was honored. The receipt returns the
 * allocated value, which is the one place it is knowable.
 */
export type UnsequencedEventEnvelope = Omit<EventEnvelope, "sequence">;

/**
 * What a successful {@link EventLogService.append} returns.
 *
 * `id` is echoed from the input rather than minted here (the caller owns the
 * primary key), but it is returned anyway so a caller has ONE object carrying
 * every identifier of the row it just wrote — the same "the persistence
 * contract admits exactly this result" discipline `PiiEventWriteResult` applies
 * to its echoed `piiUserId`.
 */
export interface EventLogAppendReceipt {
  readonly id: string;
  readonly sequence: number;
}

/**
 * The PII half of an append. Supplying this routes the write through the
 * sealing codec instead of the plain path.
 *
 * The partition itself (which fields are PII) is the `splitPii`
 * classification, performed by the CALLER.
 */
interface EventLogAppendPii {
  /** Whose content key seals `piiPayload`, and the value for the stamp column. */
  readonly userId: string;
  /** The PII half of the split — encrypted into `pii_payload`. */
  readonly piiPayload: Record<string, unknown>;
}

/**
 * The machine-authored content partition — assistant or tool prose destined for
 * `session_events.content_payload`.
 *
 * A BODY AND NOTHING ELSE. The sealing key is resolved by this service through
 * the injected {@link SessionContentKeySource}, never supplied by a producer:
 * handing every emitter a live session content key would put key material on
 * every call path that emits an assistant message, for no gain.
 *
 * `contentLength` and `contentTruncated` are NOT here either — the sealing
 * codec mints both from the body it actually sealed, and a producer that
 * supplies one is refused.
 */
interface EventLogAppendContent {
  /** The prose. Over-bound bodies are truncated at a codepoint boundary. */
  readonly body: string;
}

/**
 * The encryptor handed to the codec on a content-only row, where no user
 * partition exists and the injected {@link PiiEncryptor} may legitimately be
 * absent. Calling it is a routing defect, so it answers by name rather than by
 * `TypeError`.
 */
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
   * A SYNCHRONOUS durable write to commit ATOMICALLY WITH this row, executed
   * inside the same transaction immediately BEFORE the INSERT.
   *
   * This is the producers' dual-write atomicity seam — see the file header for
   * why it exists and exactly what it does and does not preserve. Three
   * constraints on what may go in here, each load-bearing:
   *
   *   * SYNCHRONOUS. It runs inside a better-sqlite3 transaction, which cannot
   *     span an `await`. A closure returning a promise would have its work
   *     escape the transaction entirely while the transaction committed around
   *     nothing.
   *   * SAME CONNECTION. Statements prepared on a DIFFERENT connection do not
   *     join this transaction, so their writes would commit independently of
   *     this row's rollback — the exact non-atomic dual-write the seam exists
   *     to prevent.
   *   * WRITES ONLY, no decisions. A read whose result shapes THIS row's
   *     payload is too late here: the payload was sealed and measured before
   *     the transaction opened. Decide first, under the lock, then hand
   *     the resulting write down.
   *
   * A throwing prelude aborts the transaction before the INSERT, so no row
   * lands and the throw reaches the caller unchanged.
   */
  readonly transactionalPrelude?: () => void;

  /**
   * The PII partition, when this row carries one. Routes through the codec.
   * Requires a `piiEncryptor` on the service; an append that carries PII with
   * no encryptor wired fails LOUD rather than silently persisting the partition
   * in the clear.
   */
  readonly pii?: EventLogAppendPii;

  /**
   * The machine-authored content partition, when this row carries one. Routes
   * through the SAME codec as `pii` — a row carrying both is sealed in one
   * codec call over both partitions.
   *
   * Requires a `contentKeySource` on the service; an append that carries content
   * with no key source wired fails LOUD rather than silently dropping the prose
   * or writing it into the plaintext `payload` column.
   *
   * ADMITTED ONLY ON THE BODY-BEARING EVENT TYPES, and enforced by the
   * CODEC rather than by this type. `BODY_BEARING_EVENT_TYPES` in
   * `pii-indirection.ts` derives that closed set from the contracts union, and
   * `writeEventWithPii` refuses any other type before spending a nonce.
   *
   * NOT EXPRESSIBLE HERE, which is worth saying rather than leaving as an
   * apparent omission. Two shapes were available and both are worse. Restating
   * those types on this surface would be a second registration of a decision
   * contracts already made — the exact drift the derivation exists to prevent.
   * Threading a generic from `envelope.type` through `append` would type-check
   * only for a caller whose `type` is a literal, and
   * {@link UnsequencedEventEnvelope} declares it `string` ON PURPOSE: the
   * envelope is a tolerant carrier that must accept a higher-MINOR type this
   * daemon does not know. A narrowing here would refuse those envelopes at the
   * one surface built to admit them. The sole write path is where the closed set
   * belongs, and it is where it lives.
   */
  readonly content?: EventLogAppendContent;

  /**
   * `monotonic_ns` for the row — within-daemon ordering only, never the replay
   * key. Caller-supplied so producers keep their injectable monotonic clocks
   * (a test that must drive NON-monotonic values through a producer cannot do
   * so if the writer reads its own clock unconditionally). Defaults to this
   * service's clock.
   */
  readonly monotonicNs?: bigint;
}

/** Construction dependencies. */
export interface EventLogServiceDeps {
  /** The connection every write lands on. Prepared statements are cached. */
  readonly db: Database;
  /**
   * PII content-key encryptor (implemented elsewhere). Optional because most
   * deployments and nearly every test append no PII at all; omitting it makes
   * a PII-carrying append throw rather than silently degrade.
   */
  readonly piiEncryptor?: PiiEncryptor;
  /**
   * Optional for the same reason as `piiEncryptor` and with the same failure
   * posture: most tests append no machine-authored prose, and omitting it makes
   * a content-carrying append throw rather than silently drop the body.
   *
   * The NARROW half of the store deliberately — `resolveForWrite` and nothing
   * else, so the append path cannot reach the rotation primitive that belongs to
   * the erasure orchestrator.
   */
  readonly contentKeySource?: SessionContentKeySource;
  /**
   * The DISPOSAL half of the same store, used on ONE path: reconciling the key
   * a content-bearing append minted when that append then failed.
   *
   * WHY THE APPEND PATH NEEDS IT AT ALL. `resolveForWrite` mints and COMMITS a
   * wrapped DEK in its own transaction, before the codec runs and well before
   * the INSERT — it has to, because unwrapping can block on the master key's
   * custody ladder and a better-sqlite3 transaction cannot span an await. Every
   * failure after that point therefore leaves a durable key row with nothing
   * sealed under it: the strict-variant check, the canonical-size ceiling, a
   * throwing transactional prelude, a UNIQUE violation on the INSERT. On a
   * session that never runs another content-bearing append — an inactive one
   * never compacts either — the row is permanent, and `rewrapAll` walks it on
   * every unrelated user's erasure for the life of the node.
   *
   * OPTIONAL, and the degraded stance is honest rather than convenient: with it
   * unwired the orphan is not leaked, it is DELAYED — the compactor's pass-level
   * reconciliation sweep re-derives exactly this obligation from durable state
   * and reclaims the row on a later tick. That is the same reason
   * `contentKeySource` is optional, arrived at from the other side.
   */
  readonly contentKeyDisposer?: SessionContentKeyDisposer;
  /** `monotonic_ns` default source. Defaults to `process.hrtime.bigint()`. */
  readonly monotonicNow?: () => bigint;
}

/**
 * The head as read under the lock — absent for a session's first row.
 *
 * `unknown` rather than `bigint` deliberately: the column is declared
 * `INTEGER NOT NULL`, but SQLite's declared types give AFFINITY, not
 * enforcement, and the read below is where the check happens.
 */
interface HeadRow {
  readonly sequence: unknown;
}

export class EventLogService {
  readonly #insertStmt: Statement;
  readonly #headStmt: Statement;
  // The transaction wrapper is prepared once and dispatched `.immediate()` at
  // call time. IMMEDIATE, not the `db.transaction` DEFERRED default: this body
  // writes from its first statement, and taking the RESERVED writer-intent lock
  // at BEGIN makes concurrent writers on other connections serialize there
  // rather than collide at write-upgrade time as SQLITE_BUSY_SNAPSHOT (which
  // `busy_timeout` cannot absorb) — the same discipline `RuntimeBindingStore`
  // documents.
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

    // The head: the highest `sequence`. `safeIntegers` because `sequence` is
    // INTEGER and the ceiling is `Number.MAX_SAFE_INTEGER`
    // (EVENT_ENVELOPE_SEQUENCE_MAX); reading it as a bigint keeps the read
    // lossless right up to that bound.
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
        // BODY ORDER IS LOAD-BEARING and matches what the producers shipped:
        // the durable write FIRST, the event row LAST. A throwing INSERT
        // (UNIQUE violation, terminal-key trigger ABORT) therefore rolls the
        // prelude back — which is the whole reason the prelude is a parameter
        // of this method rather than something the caller runs itself.
        prelude?.();
        const result = this.#insertStmt.run(bindings);
        if (result.changes !== 1) {
          // Unreachable through a plain INSERT (better-sqlite3 throws on
          // constraint failure rather than reporting zero changes), which is
          // exactly why it is checked: a silent zero here would mean the row is
          // not durable while its sequence was reported to the caller.
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
   * Append one event. The sole durable production write path for
   * `session_events`.
   *
   * Allocates `sequence`, seals any partitions, holds the canonical form to
   * the size ceiling, and commits the row — together with
   * `options.transactionalPrelude`, if given — in one transaction, under the
   * per-session append lock. Reentrant: a caller already holding that lock
   * reuses its hold rather than deadlocking.
   *
   * REFUSALS, in the order they are evaluated:
   *   1. `CodecOwnedContentKeyError` — the payload pre-seeds one of the content
   *      members the codec alone determines (`contentLength`,
   *      `contentTruncated`). Evaluated before the plain-vs-codec branch choice,
   *      so a false content claim cannot be stored on either branch.
   *   2. {@link assertRegisteredVariantParses} — a REGISTERED strict variant
   *      whose payload does not parse. Raised on the plain branch after the head
   *      is read, and by the codec after the seal on the sealing branch.
   *   3. `daemon.event_canonical_bytes_exceeded` (400) — the row's canonical
   *      form is over `EVENT_CANONICAL_BYTES_MAX`.
   * The first two are INTERNAL typed errors, not wire codes; the third is a
   * typed `DaemonDomainError` carrying schema-PARSED details.
   */
  async append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt> {
    const sessionId: SessionId = envelope.sessionId;
    return withSessionAppendLock(sessionId, async () => {
      // (1) The CONTENT pair. Shared with the codec's own refusal — one
      // definition, two call sites at the two ends of this one durable append
      // path. Placed here rather than in `#composeRow`'s plain branch because
      // the branch choice is made from `options.content`, not from the payload:
      // a caller that omits `options.content` and seeds `contentLength` takes
      // the PLAIN branch, where nothing is sealed and the payload the caller
      // supplied is the payload that gets stored. Runs for tolerant carriers
      // too — see the guard's own note.
      assertNoCodecOwnedContentKeys(envelope.payload, "EventLogService.append");

      // (2) HEAD. One query, under the lock, for the sequence to allocate.
      const head: HeadRow | undefined = this.#headStmt.get(sessionId) as HeadRow | undefined;
      const sequence: number =
        head === undefined ? 0 : Number(narrowHeadSequence(head.sequence, sessionId)) + 1;

      //   * `occurredAt` is normalized here and the NORMALIZED value is what
      //     gets persisted — never the producer's raw input — so the column
      //     holds the canonical RFC 3339 UTC millisecond form.
      //   * `actor` is narrowed from the envelope's THREE states
      //     (`string | null | undefined`) to the TWO storage-representable ones
      //     (`string | null`). `session_events.actor` collapses absent and
      //     `null` onto one NULL column while the canonical bytes distinguish
      //     them, so the size ceiling is measured over the form storage holds.
      const normalizedOccurredAt: string = normalizeOccurredAt(envelope.occurredAt);
      const narrowedActor: string | null = envelope.actor ?? null;

      // Either through the codec (sealing path) or plain. Both produce the same
      // persistables.
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
        // THE MINT IS COMMITTED BY NOW AND NOTHING IS SEALED UNDER IT.
        // `resolveForWrite` runs inside `#composeRow` and commits its own
        // transaction, so every refusal raised after it — the strict-variant
        // check, the canonical-size ceiling, a codec fault — leaves a durable
        // wrapped DEK with no body. Reconciled here, while this append still
        // holds the session's lock: the disposer's predicate is "any retained
        // ciphertext", so this is a no-op the instant any earlier append sealed
        // one, and the hold is what keeps a CONCURRENT first append from having
        // its key taken between its own mint and its insert.
        await this.#reconcileOrphanedContentKey(sessionId, options?.content !== undefined);
        throw error;
      }

      // (3) PERSIST — the prelude and the row, atomically. Everything bound
      // here comes from `composed`, never from the caller's input: the codec's
      // envelope carries the normalized `occurredAt` and the content members,
      // and its ciphertexts are the ones sealed under this row's nonces.
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
        // THE SECOND LAYER, and it is independent of the first rather than a
        // repetition of it. A throwing prelude or a UNIQUE violation rolls the
        // INSERT back, so the sealed row this append minted a key for does not
        // exist — and the key does. Post-INSERT this call could only ever be a
        // no-op, because the predicate would find the very row just written;
        // reaching it at all means the write did not stand.
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

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  /**
   * Retire the wrapped DEK this append may have just minted, when the append
   * itself did not stand.
   *
   * THE HAZARD. `resolveForWrite` MINTS on a miss and commits that mint in its
   * own transaction, so the key row is durable the instant the codec asks for
   * it — well before this append knows whether it will produce a row. Every
   * refusal downstream of the mint (a strict-variant rejection, the canonical
   * size ceiling, a codec fault, a throwing `transactionalPrelude`, a UNIQUE
   * violation on the INSERT) therefore leaves `session_content_keys` holding a
   * key for a session that sealed nothing. On a session whose FIRST
   * content-bearing append is the one that failed, that row is unreachable
   * garbage: nothing references it and nothing else will ever mint it again,
   * because the next append finds it and reuses it.
   *
   * WHY DISPOSE RATHER THAN VALIDATE-BEFORE-MINTING. The mint is inside the
   * codec, below the refusals, and hoisting it above them would mean
   * re-deriving every downstream refusal at this layer — a second copy of the
   * codec's own rules, wrong the moment either copy moves. Disposal asks the
   * durable question instead, and the question is already implemented: the
   * disposer's predicate is "does any retained ciphertext still depend on this
   * key", so this is a NO-OP on every session that has ever successfully sealed
   * a body, and removes the row only when the failed append was genuinely the
   * only thing that had ever asked for one.
   *
   * WHY IT IS SAFE UNDER CONCURRENCY. This runs while the failing append still
   * holds the session's append lock, and `deleteIfUnreferenced` re-runs its
   * predicate inside that same hold — reentrantly, since the hold is
   * owner-scoped. A concurrent append on this session cannot be between its own
   * mint and its own INSERT while this executes, so there is no window in which
   * a live key is taken out from under a body about to be written.
   *
   * BEST-EFFORT BY CONSTRUCTION. A disposal failure is swallowed: the caller's
   * original error is the one that describes what went wrong with the append,
   * and replacing it with a cleanup fault would hide the real refusal behind a
   * housekeeping one. The leak that swallowing admits is bounded rather than
   * permanent — {@link SessionContentKeyDisposer.sweepUnreferenced} re-derives
   * the same obligation from durable state on every compaction pass, so this
   * path is the PROMPT disposal and that one is the guarantee.
   *
   * UNWIRED IS NOT AN ERROR. The disposer is optional on
   * {@link EventLogServiceDeps} for the same reason the content key source is:
   * a service constructed without content sealing can never mint a key, so it
   * can never orphan one.
   */
  async #reconcileOrphanedContentKey(
    sessionId: SessionId,
    appendCarriedContent: boolean,
  ): Promise<void> {
    // An append that carried no content partition never reached the minting
    // path, so there is nothing this call could dispose of that it did not
    // create — and calling anyway would let an unrelated failure delete a key
    // that some OTHER append is about to seal under.
    if (!appendCarriedContent || this.#contentKeyDisposer === undefined) {
      return;
    }
    try {
      await this.#contentKeyDisposer.deleteIfUnreferenced(sessionId);
    } catch {
      // Deliberately swallowed — see BEST-EFFORT BY CONSTRUCTION above.
    }
  }

  /**
   * Produce the persistables for one row, by whichever of the two paths this
   * append takes. Both return the SAME shape so the INSERT has one binding site
   * rather than a branch per column.
   */
  async #composeRow(input: ComposeRowInput): Promise<ComposedEventRow> {
    // The envelope as it will be STORED: sequenced, with the normalized
    // `occurredAt` and the narrowed `actor`.
    const storable: EventEnvelope = {
      ...input.envelope,
      sequence: input.sequence,
      occurredAt: input.occurredAt,
      actor: input.actor,
    };

    // THE PLAIN BRANCH IS "NEITHER PARTITION", not "no PII": `assistant.*` and
    // `tool.*` rows carry machine prose and usually no user PII at all, and
    // they must reach the codec.
    if (input.pii === undefined && input.content === undefined) {
      // PARSE WHAT WILL BE STORED, on the branch that seals nothing — the SAME
      // function the codec calls, imported, never copied. A type with no
      // registered payload variant is waved through inside it: a reader "MUST
      // persist an envelope whose `type` it cannot interpret as a version stub
      // — never drop or reject it".
      assertRegisteredVariantParses(storable, {
        name: "EventLogService.append",
        timing:
          "Refused before canonicalization, on a path that seals nothing: the payload the caller supplied is the payload that would be stored.",
      });

      const canonical: CanonicalBytes = canonicalizeEvent(storable);
      // The `EVENT_CANONICAL_BYTES_MAX` serviceability ceiling: a row whose
      // canonical form cannot ride one relay frame is refused before any row
      // is written — never truncated, never silently accepted. The sealing
      // branch below runs the same check against the codec's measurement of the
      // stored form, which can exceed the ceiling even when the caller's plain
      // payload would not, because the codec adds the content members.
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
      // The alternative — dropping the partition, or writing it into the plain
      // payload — would either lose user data silently or persist it
      // unencrypted in an un-shreddable column. A plain Error,
      // not a typed refusal: this is a WIRING defect (the encryptor was never
      // injected), not something a caller can correct by changing its request.
      throw new Error(
        "EventLogService.append received a PII partition but no PiiEncryptor is wired " +
          ". Refusing rather than persisting user PII outside the" +
          "pii_payload split. Construct the service with `piiEncryptor`.",
      );
    }

    if (input.content !== undefined && this.#contentKeySource === undefined) {
      // FAIL LOUD, on the encryptor guard's logic applied to the other
      // partition. The alternatives are dropping the prose — which makes the
      // canonical transcript unauthoritative for exactly the turns it exists to
      // hold — or writing it into `payload`, which is plaintext and never
      // shredded. A plain Error rather than a typed refusal: this is a wiring
      // defect (the key source was never injected), not a request a caller can
      // correct.
      throw new Error(
        "EventLogService.append received a content partition but no SessionContentKeySource " +
          "is wired. Refusing rather than dropping machine-authored prose or persisting it in " +
          "the plaintext payload column. Construct the service with `contentKeySource`.",
      );
    }

    // The session content key, resolved BEFORE the codec runs because resolving
    // it can block on a human (the daemon master key's custody ladder wipes its
    // in-memory copy on an idle timer). The codec takes MATERIAL, so the await
    // happens out here rather than inside the sealing module. Minted lazily on this session's first
    // content-bearing append, which is why a session that never runs an agent
    // stores no key.
    const contentPartition: EventContentInput | undefined =
      input.content === undefined || this.#contentKeySource === undefined
        ? undefined
        : {
            body: input.content.body,
            contentKey: (await this.#contentKeySource.resolveForWrite(storable.sessionId)).key,
          };

    // The codec seals; the INSERT is this service's, and the codec is invoked
    // here rather than by the caller because the sequence it seals under is
    // allocated only under the lock. The category cast is narrowing, and the
    // codec re-checks it at runtime — the refused category throws there rather
    // than being silently admitted.
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

    // The arm is chosen rather than assembled from optional spreads, because the
    // codec's input is a discriminated union and the discriminant is which
    // partition is present. Building one object with both members conditionally
    // spread would type-check as the PII arm on a content-only row and hand the
    // codec a value neither arm describes.
    let codecInput: RawEventInput;
    if (input.pii === undefined) {
      // A CHECKED narrowing rather than a cast, though the value is non-null by
      // construction: the plain branch above returned unless at least one
      // partition is present, this arm is the no-PII one, and the guard above
      // threw if the key source were missing. Asserting that with `as` would
      // make the compiler agree without anything re-checking it, and the failure
      // it would hide is the one this whole branch exists to prevent — prose
      // reaching the codec as `undefined` and the row landing with no body.
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
      // A REFUSING STUB rather than `undefined` behind a cast. A content-only row
      // never calls the encryptor — the codec skips the PII stage when no
      // partition is present — and the guard above already refuses a PII
      // partition with no encryptor wired, so this argument is unreachable as a
      // call. If that ever stopped being true, the cast would surface as a
      // `TypeError` on `undefined.encrypt` from inside the codec; the stub
      // surfaces the same defect by name, at the boundary that owns it.
      this.#piiEncryptor ?? UNWIRED_PII_ENCRYPTOR,
    );

    // The same ceiling as the plain branch, on the stored form the codec
    // measured. A refusal here writes nothing, and the spent seals are
    // discarded with the result.
    if (written.canonicalByteLength > EVENT_CANONICAL_BYTES_MAX) {
      throw eventCanonicalBytesExceeded(written.canonicalByteLength, storable.id);
    }

    // PERSIST THESE AS A UNIT — the codec's caller obligation. Every value below
    // comes from `written`; none is re-derived from the input, and neither
    // ciphertext is re-sealed.
    return {
      envelope: written.envelope,
      piiPayload: written.piiPayload === undefined ? undefined : Buffer.from(written.piiPayload),
      piiUserId: written.piiUserId,
      contentPayload:
        written.contentPayload === undefined ? undefined : Buffer.from(written.contentPayload),
    };
  }
}

// --------------------------------------------------------------------------
// Module-private helpers + shapes
// --------------------------------------------------------------------------

/**
 * The stored head `sequence`, checked rather than asserted.
 *
 * `#headStmt` is prepared `.safeIntegers(true)`, so an INTEGER column
 * arrives as a `bigint` and anything else means the column does not hold an
 * integer at all: INTEGER affinity coerces only text that LOOKS numeric, so a
 * non-numeric TEXT value stays TEXT and a REAL one stays REAL. Either would
 * survive `Number(...) + 1` — as `NaN` and as a fractional sequence — and be
 * INSERTed as this row's `sequence`.
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
 * Build the `daemon.event_canonical_bytes_exceeded` refusal. Both append
 * branches raise it, so one builder keeps their `data.fields` shape identical.
 *
 * The detail carries the two SIZES and nothing else — never payload content,
 * which on this code path is precisely the oversized value nothing should
 * echo into an error envelope.
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
      // InvalidParams: the refusal is STRUCTURAL, so no session state change
      // makes the write admissible.
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 400,
      detail: DaemonEventCanonicalBytesExceededDetailsSchema.parse({
        canonicalBytes: canonicalByteLength,
        maxCanonicalBytes: EVENT_CANONICAL_BYTES_MAX,
      }),
    },
  );
}
