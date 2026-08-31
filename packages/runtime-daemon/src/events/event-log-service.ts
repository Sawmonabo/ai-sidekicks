// EventLogService — the SOLE durable append path for `session_events`
// (Plan-006 T3.1).
//
// Everything that lands a row in the audit log goes through `append()`. That is
// not a style preference: the append path holds four obligations that are only
// jointly satisfiable in one place, under one lock.
//
//   1. SERIALIZATION. `session_events` is a hash chain partitioned by session:
//      a row's `prev_hash` is its predecessor's `row_hash` and its `sequence` is
//      the predecessor's plus one. Producing a row means read-the-head then
//      write-the-successor, and this path is async between those steps.
//      `withSessionAppendLock` is what keeps two appends from deriving the same
//      link. See `session-append-lock.ts` for why a mutex is unavoidable here.
//   2. ADMISSION. The ingest-halt gate (I-006-4-03) must be consulted before any
//      work, so a halted session cannot advance its chain head even by a row
//      that would otherwise be perfectly valid.
//   3. INTEGRITY. `prev_hash` / `row_hash` / `daemon_signature` are computed
//      from the canonical bytes of the row being written, against the head this
//      path just read. A writer that computed them elsewhere would be computing
//      them against a head it does not hold.
//   4. PII CUSTODY. The `pii_payload` split, its digest, and the owner stamp are
//      produced by T2.4's codec, which needs the `prev_hash` only this path can
//      read — so this path invokes the codec rather than accepting its output.
//
// SEQUENCE ALLOCATION LIVES HERE, and that is a deliberate move rather than an
// incidental one. Plan-003's emitter used to allocate by reading the log and
// adding one, which was atomic only because its read and its append were
// separated by no `await`. Producers are async now, so that window spans awaits
// and two concurrent appends on one session would allocate the same number —
// one losing to `UNIQUE(session_id, sequence)` on a legitimate write. Reading
// the head and writing the successor inside a single lock hold closes it by
// construction, which is why the receipt returns `sequence`: the caller learns
// what it got, it does not choose it.
//
// ----------------------------------------------------------------------------
// The atomicity boundary: `transactionalPrelude`
// ----------------------------------------------------------------------------
//
// The Plan-003/005 producers ship a DUAL-WRITE: they upsert their own table AND
// emit an event, inside ONE better-sqlite3 transaction, with the table write
// FIRST and the emit LAST — so a throwing emit rolls back the table write. That
// property must survive this service becoming async, and better-sqlite3
// transactions are synchronous and cannot span an `await`.
//
// `options.transactionalPrelude` is the seam that preserves it: a SYNCHRONOUS
// closure executed inside the SAME transaction as the row INSERT, immediately
// BEFORE it. The producer hands its table write as the prelude; both commit
// atomically, in the shipped body order, and a throwing INSERT (a UNIQUE
// violation, a terminal-key trigger ABORT) rolls the prelude back. The producer
// wraps its whole read-decide-write in `withSessionAppendLock` and the nested
// `append()` reuses that hold through owner-scoped reentrancy.
//
// WHAT THIS RESTRUCTURE MOVED, and what the prelude therefore has to do.
// `DriverCapabilitiesWriter` and `NodeCapabilityService` previously ran their
// CHANGE-DETECTION read inside the write transaction. That read CANNOT stay
// inside it now, and the reason is structural, not a matter of effort — the
// event PAYLOAD depends on the read (`declared` and `updated` are different
// events with different payloads), signing depends on the payload, and signing
// is async. No ordering exists in which the read is inside the transaction that
// ends with the INSERT.
//
// The append lock does NOT cover the resulting window, and it is important not
// to claim otherwise: the lock is keyed on `sessionId` while both producers'
// hazards are keyed on something else (`driverName`; `(nodeId, capability)`).
// Two declares for the same driver under DIFFERENT sessions hold DIFFERENT
// locks and are ordered by nothing — on ONE connection as much as on two. Both
// read prior state, both park in the signing-key unseal, both commit.
//
// The window is closed by the PRELUDE, which is exactly why the prelude runs
// inside the transaction rather than beside it: each producer re-reads its
// decision-time state as the prelude's first statement, inside `BEGIN
// IMMEDIATE`, and throws a module-private divergence sentinel if it moved. That
// throw aborts the whole transaction — durable write undone, INSERT never
// reached, no sequence consumed, so a retry re-derives its sequence from the
// durable chain head — and the producer retries the read-decide-emit a bounded
// number of times on that sentinel alone. This service supplies the mechanism
// (a synchronous prelude inside an IMMEDIATE transaction whose throw rolls
// everything back); the producers own the comparison and the loop, because only
// they know what "unchanged" means for their state.
//
// ----------------------------------------------------------------------------
// What this service does NOT do
// ----------------------------------------------------------------------------
//
//   * It does not write `retention_class` or `stub_signature` — T3.2's
//     compactor owns both columns and their migration.
//   * It does not mint `participant_signature`. The column is nullable and no
//     V1 producer supplies one; `signer.ts` exports the minting function for
//     whoever does.
//   * It scaffolds no composition root. There is no production construction
//     site for the Plan-003/005 producers yet, so wiring the halt registry into
//     `bootstrap/index.ts` would be scaffolding a seam Phase 4's T4.2 observer
//     leg will author for real.
//
// Spec coverage: `Spec-006 §Integrity Protocol` (each row chained to its
// predecessor), `Spec-006 §Resolved Questions and V1 Scope Decisions` (per-session
// sequence numbers), `Spec-006 §Canonical Serialization Rules`
// (`pii_ciphertext_digest`), `Spec-006 §Event Maintenance (event_maintenance)`
// (`event.shredded`), `Spec-006 §Security Events (security_events)`
// (`daemon.pii_split_bypass`), `Spec-006 §Audit Integrity (audit_integrity)`
// (the halt state the gate reads), `Spec-006 §Daemon-Scope Event Binding And
// Node-Scope Anchoring` (the sentinel the halt registry refuses). Refs:
// Plan-006 T3.1, I-006-4-03, I-006-2-12.

import {
  DAEMON_EVENT_CANONICAL_BYTES_EXCEEDED_CODE,
  DAEMON_INGEST_HALTED_CODE,
  DAEMON_PII_SPLIT_BYPASS_CODE,
  DaemonEventCanonicalBytesExceededDetailsSchema,
  DaemonIngestHaltedDetailsSchema,
  DaemonPiiSplitBypassDetailsSchema,
  EVENT_CANONICAL_BYTES_MAX,
  EventShreddedPayloadSchema,
  JsonRpcErrorCode,
  type EventEnvelope,
  type EventShreddedEvent,
  type EventShreddedPayload,
  type SessionId,
} from "@ai-sidekicks/contracts";
import type { Database, Statement } from "better-sqlite3";

import { DaemonDomainError } from "../ipc/domain-error.js";
import { canonicalizeEvent, normalizeOccurredAt, type CanonicalBytes } from "./canonicalizer.js";
import { NeverHaltedIngestHaltSource, type IngestHaltSource } from "./ingest-halt-source.js";
import {
  assertNoCodecOwnedContentKeys,
  assertRegisteredVariantParses,
  PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  PII_PARTICIPANT_ID_PAYLOAD_KEY,
  writeEventWithPii,
  type EventContentInput,
  type PiiEligibleCategory,
  type PiiEncryptor,
  type PiiEventWriteResult,
  type RawEventInput,
} from "./pii-indirection.js";
import { withSessionAppendLock } from "./session-append-lock.js";
import type { SessionContentKeySource } from "./session-content-key-store.js";
import { GENESIS_PREV_HASH, signRow, type Ed25519PrivateKey, type SignedRow } from "./signer.js";
import type { DaemonSigningKeySource } from "./signing-key-source.js";

/**
 * The append input: a canonical {@link EventEnvelope} MINUS its `sequence`.
 *
 * `sequence` is omitted rather than ignored. This service allocates it under
 * the lock (see the file header), so a caller-supplied value could only be
 * silently discarded — and a discarded `sequence` is the kind of input a
 * producer would reasonably believe was honoured. The receipt returns the
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
 * to its echoed `piiParticipantId`.
 */
export interface EventLogAppendReceipt {
  readonly id: string;
  readonly sequence: number;
  /** 32 bytes — the new chain head, and the `prev_hash` of the next row. */
  readonly rowHash: Uint8Array;
}

/**
 * The PII half of an append. Supplying this routes the write through T2.4's
 * codec (encrypt → digest → embed → canonicalize → sign) instead of the plain
 * canonicalize-then-sign path.
 *
 * The partition itself (which fields are PII) is Plan-022's `splitPii`
 * classification, performed by the CALLER. This service consumes a partition
 * and never performs one — the classification is Plan-022-owned and Plan-006
 * cannot import from a higher tier.
 */
export interface EventLogAppendPii {
  /** Whose content key seals `piiPayload`, and the value for the stamp column. */
  readonly participantId: string;
  /** The PII half of the split — encrypted into `pii_payload`, never hashed. */
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
 * `contentLength`, `contentTruncated`, and `contentCiphertextDigest` are NOT
 * here either — the sealing codec mints all three from the body it actually
 * sealed, and a producer that supplies one is refused.
 */
export interface EventLogAppendContent {
  /** The prose. Over-bound bodies are truncated at a codepoint boundary. */
  readonly body: string;
}

/**
 * The encryptor handed to the codec on a content-only row, where no participant
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
   *     payload is too late here: the payload was canonicalized and signed
   *     before the transaction opened. Decide first, under the lock, then hand
   *     the resulting write down.
   *
   * A throwing prelude aborts the transaction before the INSERT, so no row
   * lands and the throw reaches the caller unchanged.
   */
  readonly transactionalPrelude?: () => void;

  /**
   * The PII partition, when this row carries one. Routes through T2.4's codec.
   * Requires a `piiEncryptor` on the service (CP-006-1); an append that carries
   * PII with no encryptor wired fails LOUD rather than silently persisting the
   * partition in the clear.
   */
  readonly pii?: EventLogAppendPii;

  /**
   * The machine-authored content partition, when this row carries one. Routes
   * through the SAME codec as `pii` — a row carrying both runs the
   * encrypt-then-digest-then-sign order once over both partitions.
   *
   * Requires a `contentKeySource` on the service; an append that carries content
   * with no key source wired fails LOUD rather than silently dropping the prose
   * or writing it into the hashed, signed `payload` column.
   *
   * ADMITTED ONLY ON THE FIVE BODY-BEARING EVENT TYPES, and enforced by the
   * CODEC rather than by this type. `BODY_BEARING_EVENT_TYPES` in
   * `pii-indirection.ts` derives that closed set from the contracts union, and
   * `writeEventWithPii` refuses any other type before spending a nonce.
   *
   * NOT EXPRESSIBLE HERE, which is worth saying rather than leaving as an
   * apparent omission. Two shapes were available and both are worse. Restating
   * the five types on this surface would be a second registration of a decision
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
   * key (I-003-4). Caller-supplied so producers keep their injectable
   * monotonic clocks (a test that must drive NON-monotonic values through a
   * producer cannot do so if the writer reads its own clock unconditionally).
   * Defaults to this service's clock.
   */
  readonly monotonicNs?: bigint;
}

/**
 * Plan-022 Path 1's post-shred hook.
 *
 * Invoked AFTER an `event.shredded` row is durable, while its session's append
 * lock is still held — so a handler observing the log sees the shred row and
 * everything before it, and nothing appended after. It receives the payload as
 * PARSED by {@link EventShreddedPayloadSchema} (never the caller's raw object)
 * together with the row's receipt.
 *
 * A rejecting handler propagates to the `append()` caller, and this is the one
 * place that propagation is misleading enough to state outright: the row is
 * ALREADY COMMITTED by then. A rejection here means "the post-shred hook
 * failed", never "the shred event was not recorded".
 */
export type ShredCallback = (
  shredded: EventShreddedPayload,
  receipt: EventLogAppendReceipt,
) => Promise<void>;

/** Construction dependencies. */
export interface EventLogServiceDeps {
  /** The connection every write lands on. Prepared statements are cached. */
  readonly db: Database;
  /** Per-session Ed25519 signing key. Async — an unseal may await a ceremony. */
  readonly signingKeySource: DaemonSigningKeySource;
  /**
   * The admission gate. Defaults to {@link NeverHaltedIngestHaltSource} —
   * fail-OPEN, for the reason argued at that class: a daemon with no key-reuse
   * observer wired has no evidence any session is compromised, and refusing
   * every write in that configuration would also refuse the events an operator
   * needs to diagnose it. Production wiring passes the `IngestHaltRegistry`.
   */
  readonly haltSource?: IngestHaltSource;
  /**
   * PII content-key encryptor (CP-006-1; Plan-022 Tier 5 implements). Optional
   * because most deployments and nearly every test append no PII at all;
   * omitting it makes a PII-carrying append throw rather than silently
   * degrade.
   */
  readonly piiEncryptor?: PiiEncryptor;
  /**
   * Session content-key source (Plan-006 T3.6). Optional for the same reason as
   * `piiEncryptor` and with the same failure posture: most tests append no
   * machine-authored prose, and omitting it makes a content-carrying append
   * throw rather than silently drop the body.
   *
   * The NARROW half of the store deliberately — `resolveForWrite` and nothing
   * else, so the append path cannot reach the rotation primitive that belongs to
   * Plan-022's erasure orchestrator.
   */
  readonly contentKeySource?: SessionContentKeySource;
  /** `monotonic_ns` default source. Defaults to `process.hrtime.bigint()`. */
  readonly monotonicNow?: () => bigint;
}

/**
 * The chain head as read under the lock — absent for a session's first row.
 *
 * BOTH members are `unknown` rather than `bigint` / `Uint8Array` deliberately:
 * the columns are declared `INTEGER NOT NULL` / `BLOB NOT NULL`, but that
 * declaration is a claim TypeScript never checked, and the read below is where
 * both checks happen — the read-side stance `signing-key-source.ts` takes
 * toward `daemon_signing_keys`. Declaring the narrow types here would have made
 * every use downstream of the cast unchecked: SQLite's declared types give
 * AFFINITY, not enforcement, so a TEXT `row_hash` written by anything with
 * access to the file arrives as a JS `string` and would be chained into
 * `prev_hash` — signed, stored, and verifiable nowhere.
 */
interface ChainHeadRow {
  readonly sequence: unknown;
  readonly row_hash: unknown;
}

export class EventLogService {
  readonly #insertStmt: Statement;
  readonly #chainHeadStmt: Statement;
  // The transaction wrapper is prepared once and dispatched `.immediate()` at
  // call time. IMMEDIATE, not the `db.transaction` DEFERRED default: this body
  // writes from its first statement, and taking the RESERVED writer-intent lock
  // at BEGIN makes concurrent writers on other connections serialize there
  // rather than collide at write-upgrade time as SQLITE_BUSY_SNAPSHOT (which
  // `busy_timeout` cannot absorb) — the same discipline `RuntimeBindingStore`
  // documents.
  readonly #writeTxn: (bindings: InsertBindings, prelude: (() => void) | undefined) => void;
  readonly #signingKeySource: DaemonSigningKeySource;
  readonly #haltSource: IngestHaltSource;
  readonly #piiEncryptor: PiiEncryptor | undefined;
  readonly #contentKeySource: SessionContentKeySource | undefined;
  readonly #monotonicNow: () => bigint;
  #shredCallback: ShredCallback | undefined;

  constructor(deps: EventLogServiceDeps) {
    this.#signingKeySource = deps.signingKeySource;
    this.#haltSource = deps.haltSource ?? new NeverHaltedIngestHaltSource();
    this.#piiEncryptor = deps.piiEncryptor;
    this.#contentKeySource = deps.contentKeySource;
    this.#monotonicNow = deps.monotonicNow ?? (() => process.hrtime.bigint());

    this.#insertStmt = deps.db.prepare(
      `INSERT INTO session_events (
         id, session_id, sequence, occurred_at, monotonic_ns,
         category, type, actor, payload, pii_payload,
         correlation_id, causation_id, version,
         prev_hash, row_hash, daemon_signature, participant_signature,
         pii_participant_id, content_payload
       ) VALUES (
         @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
         @category, @type, @actor, @payload, @pii_payload,
         @correlation_id, @causation_id, @version,
         @prev_hash, @row_hash, @daemon_signature, NULL,
         @pii_participant_id, @content_payload
       )`,
    );

    // The chain head: highest `sequence` and its `row_hash`, in ONE query, so
    // the sequence allocated and the `prev_hash` chained to always come from
    // the same row. Two queries could straddle a concurrent commit from another
    // connection and produce a row whose `prev_hash` belongs to a different
    // predecessor than its `sequence` implies — a chain fork that verifies
    // nowhere. `safeIntegers` because `sequence` is INTEGER and the ceiling is
    // `Number.MAX_SAFE_INTEGER` (EVENT_ENVELOPE_SEQUENCE_MAX); reading it as a
    // bigint keeps the read lossless right up to that bound.
    this.#chainHeadStmt = deps.db
      .prepare(
        `SELECT sequence, row_hash
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
          // not durable while the chain head advanced in the caller's view.
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
   * Register Plan-022 Path 1's post-shred hook. At most one; a second call
   * REPLACES the first.
   *
   * Replacement rather than a handler list, deliberately: Path 1 has exactly
   * one orchestrator, and a list would quietly admit a second registrant whose
   * failure would then be attributed to the first. If a second consumer ever
   * needs the signal, that is a fan-out decision to take explicitly.
   */
  registerShredCallback(handler: ShredCallback): void {
    this.#shredCallback = handler;
  }

  /**
   * Append one event. The sole durable production write path for
   * `session_events`.
   *
   * Allocates `sequence`, chains `prev_hash`, signs the canonical bytes, and
   * commits the row — together with `options.transactionalPrelude`, if given —
   * in one transaction, under the per-session append lock. Reentrant: a caller
   * already holding that lock (the producers' `guard-swap-append` wrap, the
   * T4.2 observer's halt-and-record sequence) reuses its hold rather than
   * deadlocking.
   *
   * REFUSALS, in the order they are evaluated:
   *   1. `daemon.ingest_halted` (409) — the session's ingest is administratively
   *      halted. Evaluated FIRST under the lock, before canonicalization and
   *      before any write, so a halted session's chain head never advances and
   *      no partial row is produced.
   *   2. `daemon.pii_split_bypass` (400) — the payload carries a reserved PII
   *      key the T2.4 codec alone may write.
   *   3. `CodecOwnedContentKeyError` — the payload pre-seeds one of the
   *      three content members the T2.4 codec alone determines
   *      (`contentCiphertextDigest`, `contentLength`, `contentTruncated`).
   *      Evaluated in the same structural step as 2 and before the
   *      plain-vs-codec branch choice, so a forged content claim cannot be
   *      signed on either branch.
   *   4. {@link assertRegisteredVariantParses} — a REGISTERED strict variant
   *      whose payload does not parse. Raised inside `#signEvent`'s plain
   *      branch, after the chain head is read and before canonicalization.
   * The first two are typed `DaemonDomainError`s carrying schema-PARSED details,
   * so `mapJsonRpcError` renders `data.type` beside `data.fields` with no mapper
   * change. The last two are INTERNAL typed errors, not wire codes: neither has
   * a row in `docs/architecture/contracts/error-contracts.md`, and reusing
   * `daemon.pii_split_bypass` for either would make a registered contract
   * describe a refusal it does not describe.
   */
  async append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt> {
    const sessionId: SessionId = envelope.sessionId;
    return withSessionAppendLock(sessionId, async () => {
      // (1) ADMISSION GATE — first, before everything. Synchronous, no I/O, no
      // lock (the `IngestHaltSource` contract), so it costs nothing on the hot
      // path. Placing it ahead of the structural guard below is deliberate: a
      // halted session is refusing every write regardless of the write's shape,
      // and reporting "your payload is malformed" to a caller whose session is
      // halted would send it to fix the wrong thing.
      if (this.#haltSource.isHalted(sessionId)) {
        throw new DaemonDomainError(
          `Ingest is administratively halted for session ${sessionId}: a daemon signing key ` +
            `was observed under more than one identity, so rows signed for this session ` +
            `cannot be attested. Writes are re-admitted when the collision leaves the ` +
            `observable set.`,
          {
            code: DAEMON_INGEST_HALTED_CODE,
            // InvalidRequest, not InvalidParams: the REQUEST is well-formed and
            // would be accepted in another session state. That is the same
            // distinction the notional 409 draws against the 400 below.
            jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
            httpStatus: 409,
            // PARSED, not cast. The detail is what `mapJsonRpcError` renders as
            // `data.fields`, and a detail-less throw renders `undefined` there
            // — so parsing is what makes the rendered shape a guarantee rather
            // than a convention.
            detail: DaemonIngestHaltedDetailsSchema.parse({ sessionId }),
          },
        );
      }

      // (2) RESERVED-KEY GUARDS — structural, before any work is spent, and
      // BEFORE the plain-vs-codec branch choice `#signEvent` makes below. Both
      // refuse a payload that pre-seeds a member only the T2.4 codec may write;
      // they are split because only one of the two is a registered wire code.
      this.#assertNoReservedPiiKeys(envelope.payload);
      // The CONTENT trio. Shared with the codec's own refusal-2 third arm — one
      // definition, two call sites at the two ends of this one durable append
      // path, never a copy. Placed here rather than in
      // `#signEvent`'s plain branch because the branch choice is made from
      // `options.content`, not from the payload: a caller that omits
      // `options.content` and seeds `contentCiphertextDigest` takes the PLAIN
      // branch, where nothing is sealed and the payload the caller supplied is
      // the payload that gets signed — minting a permanently `digest_unbound`
      // row, or false length/truncation metadata, under this daemon's signature.
      // Guarding ahead of the choice means neither branch can be entered with a
      // forged claim. Runs for tolerant carriers too, deliberately — see the
      // guard's own note for that decision and for why it throws an internal
      // typed error rather than a `DaemonDomainError`.
      assertNoCodecOwnedContentKeys(envelope.payload, "EventLogService.append");

      // (3) `event.shredded` EMISSION-SEAM PARSE. Before the write, so a
      // malformed shred payload is refused rather than persisted, and the
      // PARSED value is what both the row and the callback carry (the
      // emitter-parses convention). `event.shredded` is `event_maintenance`,
      // a category T2.4's codec refuses outright (I-006-3-01 layer 2), so it
      // necessarily travels the plain path with `pii_payload` NULL — shredding
      // PII into a record OF the shred would be self-defeating.
      const shreddedPayload: EventShreddedPayload | undefined =
        envelope.type === EVENT_SHREDDED_EVENT_TYPE
          ? EventShreddedPayloadSchema.parse(envelope.payload)
          : undefined;

      // (4) CHAIN HEAD. One query, under the lock, for both the sequence to
      // allocate and the hash to chain to.
      const head: ChainHeadRow | undefined = this.#chainHeadStmt.get(sessionId) as
        | ChainHeadRow
        | undefined;
      const sequence: number =
        head === undefined ? 0 : Number(narrowHeadSequence(head.sequence, sessionId)) + 1;
      const prevHash: Uint8Array =
        head === undefined ? GENESIS_PREV_HASH : narrowHeadRowHash(head.row_hash, sessionId);

      // (5) THE TWO T2.1-INHERITED NORMALIZATION OBLIGATIONS, both discharged
      // BEFORE canonicalization, both because the SIGNED bytes and the STORED
      // column must be the same value:
      //
      //   * `occurredAt` is normalized here and the NORMALIZED value is what
      //     gets persisted — never the producer's raw input. Signing the
      //     normalized spelling while storing the raw one produces a row whose
      //     signature no verifier can reproduce from storage, and T4.1's
      //     `occurred_at_not_canonical` check exists precisely to catch the
      //     column drifting off canonical form.
      //   * `actor` is narrowed from the envelope's THREE states
      //     (`string | null | undefined`) to the TWO storage-representable ones
      //     (`string | null`). `session_events.actor` collapses absent and
      //     `null` onto one NULL column while the canonical bytes distinguish
      //     them, so canonicalizing an ABSENT actor for a row that persists SQL
      //     NULL emits bytes storage cannot reproduce. `canonicalizeEvent`
      //     documents this as a PRECONDITION and names this path as its owner.
      const normalizedOccurredAt: string = normalizeOccurredAt(envelope.occurredAt);
      const narrowedActor: string | null = envelope.actor ?? null;

      // (6) SIGN. Either through T2.4's codec (PII path) or plain
      // canonicalize-then-sign. Both produce the same four persistables.
      const daemonSigningKey: Ed25519PrivateKey = await this.#signingKeySource.read(sessionId);
      const signed: SignedEventRow = await this.#signEvent({
        envelope,
        sequence,
        occurredAt: normalizedOccurredAt,
        actor: narrowedActor,
        prevHash,
        daemonSigningKey,
        ...(options?.pii !== undefined ? { pii: options.pii } : {}),
        ...(options?.content !== undefined ? { content: options.content } : {}),
      });

      // (7) PERSIST — the prelude and the row, atomically. Everything bound
      // here comes from `signed`, never from the caller's input: substituting
      // any of the four (a re-canonicalized envelope, a re-read `prev_hash`, a
      // stamp taken from anywhere else) yields an untampered row that can never
      // verify, because the verifier recomputes from what was STORED.
      this.#writeTxn(
        {
          id: signed.envelope.id,
          session_id: sessionId,
          sequence,
          occurred_at: signed.envelope.occurredAt,
          monotonic_ns: options?.monotonicNs ?? this.#monotonicNow(),
          category: signed.envelope.category,
          type: signed.envelope.type,
          actor: signed.envelope.actor ?? null,
          payload: JSON.stringify(signed.envelope.payload),
          pii_payload: signed.piiPayload ?? null,
          correlation_id: signed.envelope.correlationId ?? null,
          causation_id: signed.envelope.causationId ?? null,
          version: signed.envelope.version,
          prev_hash: Buffer.from(signed.signedRow.prevHash),
          row_hash: Buffer.from(signed.signedRow.rowHash),
          daemon_signature: Buffer.from(signed.signedRow.daemonSignature),
          pii_participant_id: signed.piiParticipantId ?? null,
          content_payload: signed.contentPayload ?? null,
        },
        options?.transactionalPrelude,
      );

      const receipt: EventLogAppendReceipt = {
        id: signed.envelope.id,
        sequence,
        rowHash: signed.signedRow.rowHash,
      };

      // (8) POST-SHRED HOOK — after the row is durable, still under the lock.
      if (shreddedPayload !== undefined && this.#shredCallback !== undefined) {
        await this.#shredCallback(shreddedPayload, receipt);
      }

      return receipt;
    });
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  /**
   * Refuse a payload carrying either reserved PII key.
   *
   * SCOPE. This method covers the PII pair ONLY. The three codec-owned CONTENT
   * members are refused by its sibling `assertNoCodecOwnedContentKeys`, called
   * immediately after it in step (2) — a separate call rather than two more
   * branches here, because the two refusals differ in kind: this one is the
   * registered wire code `daemon.pii_split_bypass`, whose `error-contracts.md`
   * row and `.strict()` detail schema describe the PII split and nothing else,
   * while the content refusal is an internal typed error that this branch mints
   * no wire code for. Folding them together would force one of the two to
   * misreport itself.
   *
   * BOTH keys are CODEC-OWNED. `writeEventWithPii` is the only thing that may
   * embed `pii_ciphertext_digest` or `pii_participant_id` into a payload, and
   * this service invokes that codec itself (it holds the `prev_hash` the codec
   * needs). So a payload arriving here with either key already present did not
   * come through the split — which is precisely the `daemon.pii_split_bypass`
   * defect, seen from whichever side the producer got wrong:
   *
   *   * OWNER STAMP present, no digest — the acceptance criterion's named case.
   *     PII was tagged with an owner but its bytes were never encrypted, so the
   *     plaintext would land in the hashed, signed, un-shreddable `payload`
   *     column. Checked first so the named case reports the named path.
   *   * DIGEST present — a claim about ciphertext this write does not hold.
   *     Either the row asserts bytes that are not in `pii_payload` (an
   *     unverifiable row: T4.1 recomputes the digest FROM the stored ciphertext),
   *     or the caller ran the codec and is now discarding half its output.
   *
   * WHY THE RESERVED KEYS AND NOT A REGISTRY OF PII FIELD NAMES. Spec-022's PII
   * Data Map classifies PII SEMANTICALLY ("user messages, file paths, code
   * snippets") and names no enumerable set of payload keys — so a key registry
   * would have to be invented here, would be wrong the moment a payload shape
   * changed, and would give a false sense of coverage. The reserved keys are
   * the mechanical, already-committed vocabulary T2.4 exports for exactly this
   * consumer, and they detect the failure that actually matters: a write that
   * routed around the split. A payload carrying unmarked PII with no reserved
   * key is NOT caught here and cannot be — that is Plan-022's `splitPii`
   * classification obligation, upstream of this seam.
   *
   * `fieldPath` is a KEY PATH and never a value. That is the security property:
   * the write is refused BECAUSE it carries PII outside the split, so echoing
   * the value into an error envelope would complete the leak. The paths are
   * built from the reserved-key CONSTANTS, so no payload content can reach the
   * detail.
   */
  #assertNoReservedPiiKeys(payload: Record<string, unknown>): void {
    if (Object.hasOwn(payload, PII_PARTICIPANT_ID_PAYLOAD_KEY)) {
      throw piiSplitBypass(
        `payload.${PII_PARTICIPANT_ID_PAYLOAD_KEY}`,
        `payload carries the reserved PII owner stamp \`${PII_PARTICIPANT_ID_PAYLOAD_KEY}\` — ` +
          `only the pii-indirection codec may embed it, and this write did not go through the ` +
          `encrypt-then-digest-then-sign split. Pass the PII partition as append options ` +
          `instead of embedding it in the payload.`,
      );
    }
    if (Object.hasOwn(payload, PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY)) {
      throw piiSplitBypass(
        `payload.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}`,
        `payload carries the reserved PII ciphertext digest ` +
          `\`${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}\` — only the pii-indirection codec may embed ` +
          `it, and a digest naming ciphertext this row does not hold can never verify. Pass ` +
          `the PII partition as append options instead of embedding it in the payload.`,
      );
    }
  }

  /**
   * Produce the four persistables for one row, by whichever of the two paths
   * this append takes. Both return the SAME shape so the INSERT below has one
   * binding site rather than a branch per column.
   */
  async #signEvent(input: SignEventInput): Promise<SignedEventRow> {
    // The envelope as it will be STORED: sequenced, with the normalized
    // `occurredAt` and the narrowed `actor`. This is the object that gets
    // canonicalized, so the bytes signed and the columns written agree by
    // construction rather than by parallel maintenance.
    const storable: EventEnvelope = {
      ...input.envelope,
      sequence: input.sequence,
      occurredAt: input.occurredAt,
      actor: input.actor,
    };

    // THE PLAIN BRANCH IS "NEITHER PARTITION", not "no PII". Phase 3B widened
    // this predicate rather than adding a third branch, and the widening is the
    // structural point of the change: `assistant.*` and `tool.*` rows carry
    // machine prose and usually no participant PII at all, so before it the
    // common content-bearing row took this branch and never reached the codec —
    // the column could exist and nothing would ever write to it.
    if (input.pii === undefined && input.content === undefined) {
      // PARSE WHAT WILL BE SIGNED, on the branch that seals nothing. The defect
      // is a property of the ROW, not of which column was written: a registered
      // type under the wrong category, or with a `payload` its own variant
      // refuses, canonicalizes and signs exactly as happily here as it does
      // through the codec, and comes back out unreadable as anything but a
      // stub. The SAME function the sealing branch calls at its refusal 9 —
      // imported, never copied, because two implementations would be two
      // answers to "which rows may be signed" and would diverge on the first
      // variant that lands.
      //
      // The TOLERANT-CARRIER SKIP rides along inside it rather than being
      // restated here: a `type` with no registered payload variant is waved
      // through, because `packages/contracts/src/event.ts` is explicit that a
      // reader "MUST persist an envelope whose `type` it cannot interpret as a
      // version stub — never drop or reject it" (`ADR-018 §Decision` #5/#9),
      // while the STRICT layer is "the interpretation surface, where unknown
      // types and category/type mismatches fail loud at parse time". Refusing
      // an unregistered census type here would reject exactly the envelopes the
      // stub path exists to preserve.
      //
      // AFTER `#assertNoReservedPiiKeys`, which ran back in `append` before
      // this method was reached, and the order is load-bearing now that the
      // strict layer REGISTERS both reserved keys as optional members: a
      // caller-embedded `pii_participant_id` parses cleanly here, so the typed
      // `daemon.pii_split_bypass` refusal — which names the field path and the
      // remedy — is the one that must see it first. This guard catches what
      // that one cannot express.
      assertRegisteredVariantParses(storable, {
        name: "EventLogService.append",
        timing:
          "Refused before canonicalization, on a path that seals nothing: the payload the caller supplied is the payload that would be signed.",
      });

      const canonical: CanonicalBytes = canonicalizeEvent(storable);
      // The `EVENT_CANONICAL_BYTES_MAX` serviceability ceiling (`Spec-006
      // §Canonical Serialization Rules`, 2026-08-11 amendment): a row whose
      // canonical form cannot ride one Spec-008 relay frame is refused before
      // any row is written — never truncated, never silently accepted.
      // Checked against the very bytes `signRow` is about to cover, not
      // against the caller's payload. The PII branch below runs the same
      // check against the codec's measurement of the DIGEST-BEARING form —
      // the bytes THAT path signs — which can exceed the ceiling even when
      // the caller's plain payload would not, because the embed step widens
      // the canonical member set by the digest and the owner stamp.
      if (canonical.length > EVENT_CANONICAL_BYTES_MAX) {
        throw eventCanonicalBytesExceeded(canonical.length, storable.id);
      }
      return {
        envelope: storable,
        signedRow: signRow(canonical, input.prevHash, input.daemonSigningKey),
        piiPayload: undefined,
        piiParticipantId: undefined,
        contentPayload: undefined,
      };
    }

    if (input.pii !== undefined && this.#piiEncryptor === undefined) {
      // FAIL LOUD. The alternative — dropping the partition, or writing it into
      // the plain payload — would either lose participant data silently or
      // persist it unencrypted in a hashed, signed, un-shreddable column. A
      // plain Error, not a typed refusal: this is a WIRING defect (CP-006-1's
      // encryptor was never injected), not something a caller can correct by
      // changing its request.
      throw new Error(
        "EventLogService.append received a PII partition but no PiiEncryptor is wired " +
          "(CP-006-1). Refusing rather than persisting participant PII outside the " +
          "pii_payload split. Construct the service with `piiEncryptor`.",
      );
    }

    if (input.content !== undefined && this.#contentKeySource === undefined) {
      // FAIL LOUD, on the encryptor guard's logic applied to the other
      // partition. The alternatives are dropping the prose — which makes the
      // canonical transcript unauthoritative for exactly the turns it exists to
      // hold — or writing it into `payload`, which is hashed, signed, and never
      // shredded. A plain Error rather than a typed refusal: this is a wiring
      // defect (CP-006-15's key source was never injected), not a request a
      // caller can correct.
      throw new Error(
        "EventLogService.append received a content partition but no SessionContentKeySource " +
          "is wired. Refusing rather than dropping machine-authored prose or persisting it in " +
          "the signed payload column. Construct the service with `contentKeySource`.",
      );
    }

    // The session content key, resolved BEFORE the codec runs because resolving
    // it can block on a human (the daemon master key's custody ladder wipes its
    // in-memory copy on an idle timer). The codec takes MATERIAL, so the await
    // happens out here rather than inside the module that owns the
    // canonicalization order. Minted lazily on this session's first
    // content-bearing append, which is why a session that never runs an agent
    // stores no key.
    const contentPartition: EventContentInput | undefined =
      input.content === undefined || this.#contentKeySource === undefined
        ? undefined
        : {
            body: input.content.body,
            contentKey: (await this.#contentKeySource.resolveForWrite(storable.sessionId)).key,
          };

    // T2.4's codec owns steps 1-6 of the encrypt-then-digest-then-sign order;
    // step 7 (the INSERT) is this service's, which is why the codec is invoked
    // here rather than by the caller: it needs the `prevHash` only the append
    // path can read under the lock. The category cast is narrowing, and the
    // codec re-checks it at runtime (I-006-3-01 layer 2) — the two refused
    // categories throw there rather than being silently admitted, so a wrong
    // category is a loud failure and not an unchecked assumption.
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
        piiParticipantId: input.pii.participantId,
        piiPayload: input.pii.piiPayload,
        ...(contentPartition !== undefined ? { content: contentPartition } : {}),
      };
    }

    const written: PiiEventWriteResult = await writeEventWithPii(
      codecInput,
      input.prevHash,
      // A REFUSING STUB rather than `undefined` behind a cast. A content-only row
      // never calls the encryptor — the codec skips the PII stage when no
      // partition is present — and the guard above already refuses a PII
      // partition with no encryptor wired, so this argument is unreachable as a
      // call. If that ever stopped being true, the cast would surface as a
      // `TypeError` on `undefined.encrypt` from inside the codec; the stub
      // surfaces the same defect by name, at the boundary that owns it.
      this.#piiEncryptor ?? UNWIRED_PII_ENCRYPTOR,
      input.daemonSigningKey,
    );

    // The same ceiling as the plain branch, on the DIGEST-BEARING canonical
    // form the codec measured at its own step 5 — the exact bytes `written.
    // signedRow` covers. Post-encrypt by construction (see
    // `PiiEventWriteResult.canonicalByteLength` for why no earlier point can
    // measure it), still upstream of the INSERT: a refusal here writes
    // nothing, and the spent AEAD seal and signature are discarded with the
    // result.
    if (written.canonicalByteLength > EVENT_CANONICAL_BYTES_MAX) {
      throw eventCanonicalBytesExceeded(written.canonicalByteLength, storable.id);
    }

    // PERSIST THESE AS A UNIT — the codec's caller obligation. Every value below
    // comes from `written`; none is re-derived from the input, and neither
    // ciphertext is re-sealed (both digests inside the signed payload commit to
    // exactly these arrays).
    return {
      envelope: written.envelope,
      signedRow: written.signedRow,
      piiPayload: written.piiPayload === undefined ? undefined : Buffer.from(written.piiPayload),
      piiParticipantId: written.piiParticipantId,
      contentPayload:
        written.contentPayload === undefined ? undefined : Buffer.from(written.contentPayload),
    };
  }
}

// --------------------------------------------------------------------------
// Module-private helpers + shapes
// --------------------------------------------------------------------------

// The `event.shredded` type literal, taken by indexed access from the contracts
// variant rather than respelled. The binding is what makes a rename in contracts
// fail THIS compile: a bare string literal would keep compiling and silently
// disable the shred seam — the parse would simply never run, and no test of a
// non-shred append would notice.
const EVENT_SHREDDED_EVENT_TYPE: EventShreddedEvent["type"] = "event.shredded";

/**
 * The `row_hash` width `signer.ts` enforces, re-spelled here for the chain-head
 * read guard rather than imported — `signer.ts` keeps its own
 * `CHAIN_HASH_LENGTH` module-private, and `pii-indirection.ts` re-spells it for
 * the same reason rather than widening that export surface for one integer.
 *
 * DRIFT HERE IS ONE-DIRECTIONAL AND LOUD: this value only ever refuses a stored
 * head, and `signRow` re-checks the `prev_hash` it produces, so a stale value
 * can cause a false refusal — never a signature over a wrong-width chain link.
 */
const CHAIN_HASH_LENGTH = 32;

/**
 * The stored chain-head `sequence`, checked rather than asserted.
 *
 * `#chainHeadStmt` is prepared `.safeIntegers(true)`, so an INTEGER column
 * arrives as a `bigint` and anything else means the column does not hold an
 * integer at all: INTEGER affinity coerces only text that LOOKS numeric, so a
 * non-numeric TEXT value stays TEXT and a REAL one stays REAL. Either would
 * survive `Number(...) + 1` — as `NaN` and as a fractional sequence — and be
 * INSERTed as this row's `sequence` and signed into its canonical bytes.
 */
function narrowHeadSequence(value: unknown, sessionId: SessionId): bigint {
  if (typeof value !== "bigint") {
    throw new Error(
      `session_events.sequence for session ${sessionId} is not an INTEGER: got a value of type ${typeof value}. The column is declared INTEGER NOT NULL and this statement reads it with safeIntegers, so a non-bigint value means the row was written or altered outside this module. Refusing here rather than allocating the next sequence from it.`,
    );
  }
  return value;
}

/**
 * The stored chain-head `row_hash`, checked rather than asserted — this value
 * becomes the next row's `prev_hash`, so a wrong-shaped one is chained into the
 * canonical bytes and signed. Refused here, where the diagnostic can still name
 * the column, rather than at `signRow`, whose message names an argument.
 */
function narrowHeadRowHash(value: unknown, sessionId: SessionId): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== CHAIN_HASH_LENGTH) {
    throw new Error(
      `session_events.row_hash for session ${sessionId} is not a ${CHAIN_HASH_LENGTH}-byte BLOB: got ${
        value instanceof Uint8Array
          ? `${value.length} bytes`
          : `a non-Uint8Array value of type ${typeof value}`
      }. The column is declared BLOB NOT NULL and this module writes a 32-byte BLAKE3 chain hash, so a wrong-shaped value means the row was written or altered outside this module.`,
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
  readonly prev_hash: Buffer;
  readonly row_hash: Buffer;
  readonly daemon_signature: Buffer;
  readonly pii_participant_id: string | null;
  readonly content_payload: Buffer | null;
}

interface SignEventInput {
  readonly envelope: UnsequencedEventEnvelope;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly actor: string | null;
  readonly prevHash: Uint8Array;
  readonly daemonSigningKey: Ed25519PrivateKey;
  readonly pii?: EventLogAppendPii;
  readonly content?: EventLogAppendContent;
}

/** The persistables, whichever path produced them. */
interface SignedEventRow {
  readonly envelope: EventEnvelope;
  readonly signedRow: SignedRow;
  readonly piiPayload: Buffer | undefined;
  readonly piiParticipantId: string | undefined;
  readonly contentPayload: Buffer | undefined;
}

/**
 * Build the `daemon.pii_split_bypass` refusal. Factored so both arms parse the
 * detail through the same schema — a second hand-built detail object is exactly
 * how one of two sibling refusals ends up rendering a different `data.fields`
 * shape than the other.
 */
function piiSplitBypass(fieldPath: string, message: string): DaemonDomainError {
  return new DaemonDomainError(message, {
    code: DAEMON_PII_SPLIT_BYPASS_CODE,
    // InvalidParams, not InvalidRequest: the request is STRUCTURALLY invalid
    // and no session state makes it admissible — the 400/409 distinction the
    // error-contracts rows draw between this refusal and the ingest halt.
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    httpStatus: 400,
    detail: DaemonPiiSplitBypassDetailsSchema.parse({ fieldPath }),
  });
}

/**
 * Build the `daemon.event_canonical_bytes_exceeded` refusal — the append
 * ceiling of `Spec-006 §Canonical Serialization Rules` (2026-08-11 amendment;
 * error-contracts.md §Daemon, 400). Factored for the same reason as
 * {@link piiSplitBypass}: both append branches raise it, and a second
 * hand-built detail object is exactly how sibling refusals drift apart.
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
      `(Spec-006 §Canonical Serialization Rules): a row this size could never be ` +
      `re-published inside one 64 KB relay frame on the Spec-008 backfill seam. Refused ` +
      `with no row written. The event payload catalog is metadata-shaped by design — ` +
      `move bulk content behind a reference instead of inlining it.`,
    {
      code: DAEMON_EVENT_CANONICAL_BYTES_EXCEEDED_CODE,
      // InvalidParams like its `daemon.pii_split_bypass` sibling, and for the
      // same reason: STRUCTURAL, so no session state change makes the write
      // admissible.
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 400,
      detail: DaemonEventCanonicalBytesExceededDetailsSchema.parse({
        canonicalBytes: canonicalByteLength,
        maxCanonicalBytes: EVENT_CANONICAL_BYTES_MAX,
      }),
    },
  );
}
