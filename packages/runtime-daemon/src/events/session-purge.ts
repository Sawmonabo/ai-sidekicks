// The whole-session purge: one deletion replaces every purgeable row of each
// session it removes with a signed audit stub, so the sessions' content is gone
// and their chains survive, and appends one receipt naming every session it
// removed.
//
// This is the only operation in this package that MUTATES an already-committed
// row of the append-only log, and it runs only when a person deletes sessions.
// Nothing in the background calls it: a kept session's transcript is never
// thinned, and the background compactor never rewrites a committed column. The
// caller chooses the sessions and owns the precondition that each is archived or
// closed and locked against new work while the purge runs; this module does not
// read session state.
//
// Three properties carry the design:
//
//   1. NEVER-PURGED CATEGORIES. The row selector excludes `audit_integrity` and
//      `event_maintenance` in SQL, so a row of either family is never read as a
//      candidate. `audit_integrity` rows carry the purged session's real id and
//      are the tamper-evidence record; `event_maintenance` rows record
//      maintenance, this purge's own receipt included. The rows that remain are
//      the signed audit skeleton a purged session keeps.
//   2. ANCHOR BEFORE DESTRUCTION. A covering anchor is obtained over each
//      session's whole purge span before its first row is touched. If it cannot
//      be obtained, that session is refused with zero rows mutated.
//   3. SIGN-EXACT-BYTES. The stub projection is canonicalized ONCE to `B`,
//      `stub_signature = Ed25519(B)`, and that same `B` is what lands in
//      `payload`. No re-serialization sits between signing and storing, so a
//      verifier authenticates the stub by checking the signature directly over
//      the stored bytes.
//
// `payload` is a TEXT-affinity column and `B` is a `Uint8Array`. Binding `B` as
// a Buffer would write a BLOB into that column, and a verifier reading it back
// would hold something other than the signed bytes. The binding is therefore
// `new TextDecoder().decode(B)`: canonical JSON is valid UTF-8, so the decode is
// lossless and a verifier recovers `B` by UTF-8-encoding the stored TEXT. The
// decoded string is derived from `B` and never from a second `JSON.stringify`.
//
// What is checked BEFORE anything is destroyed, in increasing cost order:
//
//   1. NOT INSIDE AN APPEND-LOCK HOLD, once per deletion. The session append
//      lock is reentrant per owner, so a purge entered inside a hold would
//      acquire nothing for the rows it stubs and run outside the serialization
//      the hold provides.
//   2. SENTINEL SIGNING KEY, once per deletion. The receipt is appended on the
//      daemon-scope sentinel session, whose signing key is a different row from
//      the ones the stubs are signed with. The append resolves it only after
//      every session's rows, so an unresolvable key would surface after the
//      payloads were gone: the destruction would have no durable record. The
//      purge probes it before touching any session.
//   3. INGEST HALT, per session. A session halted for signing-key reuse is
//      refused. Signing a stub is attestation under the same key the halt
//      declared repudiable, so purging a halted session would destroy the
//      pre-halt evidence and re-attest what is left under the discredited key.
//      The refusal is reported, never silent: the person asked for it to go.
//
// A session that is refused does not stop the deletion: the others are
// independent, and the person asked for all of them to go. The receipt names
// each session that lost rows, with the range it stubbed; a session refused
// before its first stub lost nothing and is not named, and one that stopped part
// way is named with the range it did stub. Each refusal is on that session's
// outcome.
//
// Locking. Each row is read, projected, signed and rewritten under one hold of
// its session's append lock; each session's signing key is resolved once before
// its rows and the receipt is appended after every session, all outside every
// hold, because a hold spanning foreign I/O would stall every producer on the
// session.

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EVENT_CANONICAL_BYTES_MAX,
  EventCategorySchema,
  EventCompactedPayloadSchema,
  EventEnvelopeVersionSchema,
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
} from "@ai-sidekicks/contracts";
import type {
  AnchorPayload,
  EventCategory,
  EventCompactedPayload,
  EventCompactedRemovedSession,
  EventEnvelopeVersion,
  NodeId,
  SessionId,
} from "@ai-sidekicks/contracts";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Database, Statement } from "better-sqlite3";

import { canonicalizeJson } from "./canonicalizer.js";
import type { CanonicalBytes } from "./canonicalizer.js";
import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "./event-log-service.js";
import { NeverHaltedIngestHaltSource } from "./ingest-halt-source.js";
import type { IngestHaltSource } from "./ingest-halt-source.js";
import type { AnchorRangeRequest } from "./merkle-anchor-service.js";
import { isWithinSessionAppendLockHold, withSessionAppendLock } from "./session-append-lock.js";
import type { SessionContentKeyDisposer } from "./session-content-key-store.js";
import type { Ed25519PrivateKey } from "./signer.js";
import type { DaemonSigningKeySource } from "./signing-key-source.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";

/** The `retention_class` value a purged row carries. */
export const AUDIT_STUB_RETENTION_CLASS = "audit_stub" as const;

/**
 * The two categories a purge never touches: the signed audit skeleton a purged
 * session keeps.
 */
const NEVER_PURGED_EVENT_CATEGORIES: readonly EventCategory[] = [
  "audit_integrity",
  "event_maintenance",
];

// The same two categories as a SQL literal list, interpolated rather than bound:
// positional binds would tie each statement's correctness to where the shared
// WHERE fragment sits in it. `EventCategory` is a closed union of bare
// identifiers, so there is nothing to escape. Derived from the array so the two
// cannot drift.
const NEVER_PURGED_CATEGORY_SQL_LIST: string = NEVER_PURGED_EVENT_CATEGORIES.map(
  (category) => `'${category}'`,
).join(", ");

// A row that is neither already a stub nor in a never-purged category.
const LIVE_PURGEABLE_WHERE = `retention_class IS NULL
           AND category NOT IN (${NEVER_PURGED_CATEGORY_SQL_LIST})`;

/**
 * Payload members kept VERBATIM in the stub whenever the source payload carries
 * them.
 *
 *   * `runId` + `runVersion`: the terminal-run unique index's expressions on
 *     terminal `run_lifecycle` rows. `trg_run_terminal_key_update` aborts a stub
 *     that drops, retypes or alters either, and dropping them would let a second
 *     terminal for the same run land.
 *   * `executionPosture` + `credentialPolicyRef`: the posture audit record on
 *     `run.running` rows. A trusted-mode row carries no credential reference and
 *     the stub neither requires nor invents one.
 *   * `targetPosition`: the rewind target on `run.rolled_back` rows.
 *   * `sourceEpoch` + `sourcePosition`: the epoch stamp, so a stub of a
 *     stale-epoch row stays attributed to its source epoch.
 *   * `contentLength` + `contentTruncated`: the shape of the sealed body the
 *     same UPDATE destroys. `contentCiphertextDigest` is deliberately absent: it
 *     commits to ciphertext this UPDATE removes, and keeping it would leave the
 *     stub asserting a binding to bytes that no longer exist.
 */
const PRESERVED_PAYLOAD_KEYS: readonly string[] = [
  "runId",
  "runVersion",
  "executionPosture",
  "credentialPolicyRef",
  "targetPosition",
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
];

// The receipt's envelope category, type and version. The version is minted
// through its schema so a literal that stopped satisfying the grammar throws at
// import rather than at the first receipt.
const EVENT_MAINTENANCE_CATEGORY: EventCategory = "event_maintenance";
const PURGE_RECEIPT_TYPE = "event.compacted" as const;
const PURGE_RECEIPT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// Ed25519 signatures are 64 bytes (RFC 8032 section 5.1.6).
const ED25519_SIGNATURE_LENGTH = 64;

/**
 * The stub projection that replaces a purged row's `payload`.
 *
 * The index signature carries the preserved members, which are written under
 * keys known only at run time. `purgedAt` and `summary` exist only inside these
 * bytes and have no scalar column; every other named member mirrors its column.
 */
export type AuditStubProjection = {
  id: string;
  sessionId: SessionId;
  sequence: number;
  occurredAt: string;
  category: EventCategory;
  type: string;
  actor: string | null;
  purgedAt: string;
  retentionClass: typeof AUDIT_STUB_RETENTION_CLASS;
  summary: string;
  [preservedKey: string]: unknown;
};

/** What one deletion did to one of its sessions, or refused to do and why. */
export interface SessionPurgeOutcome {
  readonly sessionId: SessionId;
  /** Rows whose payload was replaced by a signed audit stub. */
  readonly rowsStubbed: number;
  /** The lowest and highest sequence stubbed; absent when no row was. */
  readonly fromSequence?: number | undefined;
  readonly toSequence?: number | undefined;
  /**
   * Present iff this session was refused or its content key could not be
   * retired. A refusal raised before its rows (the halt, the anchor) leaves the
   * session intact; one raised among its rows leaves the rows already stubbed as
   * stubs, and the receipt names exactly those.
   */
  readonly refusedReason?: string | undefined;
}

/** What one deletion did. */
export interface SessionPurgeResult {
  /** The receipt's `operationId`. */
  readonly operationId: string;
  /** One entry per session the deletion was asked to remove, in order. */
  readonly outcomes: readonly SessionPurgeOutcome[];
  /**
   * Present iff the deletion as a whole was refused or failed: before any
   * session was touched (the lock-hold check, the sentinel probe; `outcomes` is
   * then empty), or when the receipt could not be appended after rows were
   * stubbed.
   */
  readonly refusedReason?: string | undefined;
}

/**
 * The durable append seam for the receipt. Structural, so a test can hand in a
 * recording double.
 */
export interface SessionPurgeEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

/**
 * The anchor force-fire seam. `anchorRange` owns the coverage pre-check and
 * short-circuits when a covering anchor exists, so this module keeps no second
 * coverage predicate; it only checks that the returned anchor covers the span.
 */
export interface SessionPurgeAnchorSource {
  anchorRange(request: AnchorRangeRequest): Promise<AnchorPayload>;
}

/** Construction dependencies. */
export interface SessionPurgeDeps {
  /** The connection every read and stub UPDATE lands on. */
  readonly db: Database;
  /** This daemon's NodeId, attributed in every receipt. */
  readonly nodeId: NodeId;
  /** Resolves the session's Ed25519 private key for `stub_signature`. */
  readonly signingKeySource: DaemonSigningKeySource;
  /** Where the receipt is appended. */
  readonly eventLog: SessionPurgeEventLog;
  /** The anchor-before-destruction seam. */
  readonly anchorSource: SessionPurgeAnchorSource;
  /**
   * Retires the session's wrapped content key once the purge has cleared the
   * last body it sealed. Required: a no-op default would leave dead wrapped
   * keys accumulating with nothing at the wiring site to say so.
   */
  readonly contentKeyDisposer: SessionContentKeyDisposer;
  /** The ingest-halt read seam. Defaults to never halted, as the append path does. */
  readonly haltSource?: IngestHaltSource;
  /** One clock for the stub's `purgedAt` and the receipt's timestamps. */
  readonly now?: () => Date;
  /** Mints the receipt's `operationId`. Defaults to `mintUuidV7`. */
  readonly operationIdFactory?: () => string;
  /** Mints the receipt row's id. Defaults to `mintUuidV7`. */
  readonly newEventId?: () => string;
}

// Raw read shapes. Every member is `unknown` because column declarations are
// claims TypeScript never checked, and the read boundary is where they are
// checked.
interface PurgeSpanRow {
  readonly from_sequence: unknown;
  readonly to_sequence: unknown;
}

interface CandidateRow {
  readonly id: unknown;
  readonly sequence: unknown;
  readonly occurred_at: unknown;
  readonly category: unknown;
  readonly type: unknown;
  readonly actor: unknown;
  readonly payload: unknown;
}

interface PurgeSpan {
  readonly fromSequence: number;
  readonly toSequence: number;
}

// Thrown to abort one session or the whole deletion. Caught in `purge` and turned
// into a `refusedReason`; never escapes it.
class SessionPurgeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPurgeRefusal";
  }
}

/**
 * Purges the sessions one deletion removes.
 *
 * Rows commit one per hold, not in one transaction: each row's replace, sign
 * and mark is a single UPDATE and so atomic, and a transaction across every row
 * would hold the session's lock for the whole purge. A purge that stops part
 * way leaves a mixed session, each row either whole or a verifiable stub, and a
 * repeated purge resumes it: the `retention_class IS NULL` filter skips the
 * rows already stubbed.
 */
export class SessionPurge {
  readonly #nodeId: NodeId;
  readonly #signingKeySource: DaemonSigningKeySource;
  readonly #eventLog: SessionPurgeEventLog;
  readonly #anchorSource: SessionPurgeAnchorSource;
  readonly #contentKeyDisposer: SessionContentKeyDisposer;
  readonly #haltSource: IngestHaltSource;
  readonly #now: () => Date;
  readonly #operationIdFactory: () => string;
  readonly #newEventId: () => string;

  // Prepared in the constructor: every statement names `retention_class`, so a
  // handle that never ran the migration adding it fails at construction.
  readonly #purgeSpanStmt: Statement;
  readonly #candidateSequencesStmt: Statement;
  readonly #candidateRowStmt: Statement;
  readonly #stubUpdateStmt: Statement;

  constructor(deps: SessionPurgeDeps) {
    this.#nodeId = deps.nodeId;
    this.#signingKeySource = deps.signingKeySource;
    this.#eventLog = deps.eventLog;
    this.#anchorSource = deps.anchorSource;
    this.#contentKeyDisposer = deps.contentKeyDisposer;
    this.#haltSource = deps.haltSource ?? new NeverHaltedIngestHaltSource();
    this.#now = deps.now ?? ((): Date => new Date());
    this.#operationIdFactory = deps.operationIdFactory ?? mintUuidV7;
    this.#newEventId = deps.newEventId ?? mintUuidV7;

    this.#purgeSpanStmt = deps.db.prepare(
      `SELECT MIN(sequence) AS from_sequence,
              MAX(sequence) AS to_sequence
         FROM session_events
        WHERE session_id = ?
          AND ${LIVE_PURGEABLE_WHERE}`,
    );

    // Sequences only: each row is re-read under its own hold, so the projection
    // is built from state observed inside the hold.
    this.#candidateSequencesStmt = deps.db.prepare(
      `SELECT sequence AS sequence
         FROM session_events
        WHERE session_id = ?
          AND ${LIVE_PURGEABLE_WHERE}
        ORDER BY sequence`,
    );

    this.#candidateRowStmt = deps.db.prepare(
      `SELECT id AS id,
              sequence AS sequence,
              occurred_at AS occurred_at,
              category AS category,
              type AS type,
              actor AS actor,
              payload AS payload
         FROM session_events
        WHERE session_id = ?
          AND sequence = ?
          AND ${LIVE_PURGEABLE_WHERE}`,
    );

    // The destruction. `payload` is rewritten, never nulled (the column is NOT
    // NULL and a reader must still find the stub). The PII ciphertext, its owner
    // stamp and the sealed body go, and so do the correlation links. Left out,
    // and load-bearing that they are: `prev_hash`, `row_hash`,
    // `daemon_signature`, `monotonic_ns` and `version`, which freeze the chain,
    // and `category` / `type`, which the terminal-key trigger's de-scope leg
    // watches and the stub mirrors. The `retention_class IS NULL` guard makes a
    // repeated UPDATE a zero-row no-op rather than a double stub.
    this.#stubUpdateStmt = deps.db.prepare(
      `UPDATE session_events
          SET payload = ?,
              correlation_id = NULL,
              causation_id = NULL,
              pii_payload = NULL,
              pii_user_id = NULL,
              content_payload = NULL,
              retention_class = ?,
              stub_signature = ?
        WHERE id = ?
          AND session_id = ?
          AND retention_class IS NULL`,
    );
  }

  /**
   * Replace every live purgeable row of each session in `sessionIds` with a
   * signed audit stub, append one receipt naming every session that lost rows,
   * and retire each such session's content key.
   *
   * Never throws: every failure becomes a `refusedReason`, on the session it
   * belongs to or on the deletion.
   */
  async purge(sessionIds: readonly SessionId[]): Promise<SessionPurgeResult> {
    const operationId: string = this.#operationIdFactory();
    const purgeInstant: Date = this.#now();

    try {
      if (isWithinSessionAppendLockHold()) {
        throw new SessionPurgeRefusal(
          "a purge entered inside a session append-lock hold would stub rows outside the hold's " +
            "serialization; refusing to mutate any row.",
        );
      }
      await this.#probeSentinelSigningKey();
    } catch (error) {
      return { operationId, outcomes: [], refusedReason: describeError(error) };
    }

    const outcomes: SessionPurgeOutcome[] = [];
    for (const sessionId of sessionIds) {
      outcomes.push(await this.#purgeSession(sessionId, purgeInstant));
    }

    // The receipt names every session that lost rows, INCLUDING one that was
    // refused part way: that is exactly where rows were destroyed, and
    // destruction must never go unrecorded.
    const removedSessions: EventCompactedRemovedSession[] = outcomes.flatMap((outcome) =>
      outcome.fromSequence !== undefined && outcome.toSequence !== undefined
        ? [
            {
              sessionId: outcome.sessionId,
              fromSeq: outcome.fromSequence,
              toSeq: outcome.toSequence,
            },
          ]
        : [],
    );
    let refusedReason: string | undefined;
    if (removedSessions.length > 0) {
      try {
        await this.#appendReceipt(operationId, purgeInstant, removedSessions);
      } catch (error) {
        refusedReason = `purge receipt append failed after rows of ${String(removedSessions.length)} sessions were stubbed: ${describeError(error)}`;
      }
    }

    // The stub UPDATE is a `content_payload = NULL` writer, so the purge may
    // have cleared the last body a session's wrapped key sealed. The store
    // re-checks under its own exclusion and is a no-op while any body survives.
    // A failure here is reported, and it is a delay rather than a leak: the
    // compactor's tick sweeps every unreferenced key.
    const settledOutcomes: SessionPurgeOutcome[] = [];
    for (const outcome of outcomes) {
      settledOutcomes.push(
        outcome.rowsStubbed > 0 ? await this.#disposeContentKey(outcome) : outcome,
      );
    }

    return { operationId, outcomes: settledOutcomes, refusedReason };
  }

  async #purgeSession(sessionId: SessionId, purgeInstant: Date): Promise<SessionPurgeOutcome> {
    let rowsStubbed = 0;
    let fromSequence: number | undefined;
    let toSequence: number | undefined;
    try {
      // Asked about THIS session, never the sentinel: the halt registry forbids
      // halting the sentinel.
      if (this.#haltSource.isHalted(sessionId)) {
        throw new SessionPurgeRefusal(
          `session ${sessionId} is halted for signing-key reuse, and signing its stubs would ` +
            "re-attest its rows under the discredited key; refusing to mutate any row.",
        );
      }

      const span: PurgeSpan | undefined = this.#readPurgeSpan(sessionId);
      if (span === undefined) {
        return { sessionId, rowsStubbed: 0 };
      }

      // `anchorRange` requires a span dense over STORED rows, and it is: sequence
      // allocation is head+1 and a purge rewrites rows rather than deleting
      // them. Never-purged rows inside the span are leaves like any other.
      const anchor: AnchorPayload = await this.#anchorSource.anchorRange({
        sessionId,
        fromSeq: span.fromSequence,
        toSeq: span.toSequence,
      });
      if (anchor.startSequence > span.fromSequence || anchor.endSequence < span.toSequence) {
        throw new SessionPurgeRefusal(
          `anchor [${String(anchor.startSequence)}, ${String(anchor.endSequence)}] does not cover ` +
            `the purge span [${String(span.fromSequence)}, ${String(span.toSequence)}]; ` +
            "refusing to mutate any row.",
        );
      }

      // Resolved once, outside every hold: an unseal may await a key ceremony.
      const signingKey: Ed25519PrivateKey = await this.#signingKeySource.read(sessionId);

      for (const sequence of this.#readCandidateSequences(sessionId)) {
        if (await this.#stubRow(sessionId, sequence, signingKey, purgeInstant)) {
          rowsStubbed += 1;
          fromSequence ??= sequence;
          toSequence = sequence;
        }
      }
      return { sessionId, rowsStubbed, fromSequence, toSequence };
    } catch (error) {
      return {
        sessionId,
        rowsStubbed,
        fromSequence,
        toSequence,
        refusedReason: describeError(error),
      };
    }
  }

  async #disposeContentKey(outcome: SessionPurgeOutcome): Promise<SessionPurgeOutcome> {
    try {
      await this.#contentKeyDisposer.deleteIfUnreferenced(outcome.sessionId);
      return outcome;
    } catch (error) {
      const disposalFailure = `session content-key disposal failed after ${String(outcome.rowsStubbed)} rows were stubbed: ${describeError(error)}`;
      return { ...outcome, refusedReason: appendReason(outcome.refusedReason, disposalFailure) };
    }
  }

  /**
   * Resolve the sentinel's signing key and discard it, refusing the purge when
   * it cannot be resolved. The key is not held across the row loop: the receipt
   * append resolves it again, and private key material is not kept alive for
   * nothing. Only the rejection is ever rendered.
   */
  async #probeSentinelSigningKey(): Promise<void> {
    try {
      await this.#signingKeySource.read(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    } catch (error) {
      throw new SessionPurgeRefusal(
        "the daemon-scope sentinel's signing key could not be resolved, so this deletion could not " +
          "append the record of its own work; refusing to mutate any row " +
          `(${describeError(error)}).`,
      );
    }
  }

  /**
   * One hold on the session's append lock, spanning read, project, canonicalize,
   * sign and UPDATE. Returns false when the row was no longer live under the
   * hold (a concurrent purge stubbed it).
   */
  async #stubRow(
    sessionId: SessionId,
    sequence: number,
    signingKey: Ed25519PrivateKey,
    purgeInstant: Date,
  ): Promise<boolean> {
    return withSessionAppendLock(sessionId, async () => {
      const raw: unknown = this.#candidateRowStmt.get(sessionId, sequence);
      if (raw === undefined) {
        return false;
      }
      const row = raw as CandidateRow;

      const eventId: string = readString(row.id, "session_events.id");
      const storedPayload: string = readString(row.payload, "session_events.payload");
      // Measured off the STORED text: this figure is signed into the summary, and
      // a re-serialization would disagree by whatever key order and whitespace
      // the original write used.
      const storedPayloadByteLength: number = Buffer.byteLength(storedPayload, "utf8");
      const projection: AuditStubProjection = projectAuditStub(
        sessionId,
        row,
        eventId,
        parsePayload(storedPayload, eventId),
        storedPayloadByteLength,
        purgeInstant,
      );

      // SIGN-EXACT-BYTES. The signature covers the bounded canonicalization's
      // final output and the UPDATE stores the UTF-8 decoding of those same
      // bytes. The decode is sound because `canonicalizeJson` refuses a lone
      // surrogate; without that guard the decoder would substitute U+FFFD and the
      // stored stub would no longer match its signature.
      const canonicalStubBytes: CanonicalBytes = canonicalizeBoundedStubProjection(
        projection,
        eventId,
      );
      const stubSignature: Uint8Array = ed25519.sign(canonicalStubBytes, signingKey);
      if (stubSignature.length !== ED25519_SIGNATURE_LENGTH) {
        // The column is a bare BLOB and a signature that fails to verify reads
        // as tamper evidence, so a wrong width would look like a forged row.
        throw new SessionPurgeRefusal(
          `stub signature for event ${eventId} is ${String(stubSignature.length)} bytes, ` +
            `expected ${String(ED25519_SIGNATURE_LENGTH)}.`,
        );
      }

      const result = this.#stubUpdateStmt.run(
        new TextDecoder().decode(canonicalStubBytes),
        AUDIT_STUB_RETENTION_CLASS,
        Buffer.from(stubSignature),
        eventId,
        sessionId,
      );
      if (result.changes !== 1) {
        // Under this hold the row was just read live, so a miss means it moved
        // inside the critical section. Counting it as stubbed would report a row
        // that still holds its full payload.
        throw new SessionPurgeRefusal(
          `audit-stub UPDATE for event ${eventId} (sequence ${String(sequence)}) changed ` +
            `${String(result.changes)} rows, expected 1.`,
        );
      }
      return true;
    });
  }

  /**
   * One receipt per deletion, appended on the daemon-scope sentinel and naming
   * every session the deletion removed rows from.
   *
   * Each range bounds the rows actually stubbed, not the anchored span: after a
   * refusal part way the span's tail still holds full payloads. Never-purged
   * rows can sit inside a range; a reader that needs per-row truth reads
   * `retention_class`. Parsed at the emission seam, so a drifted shape fails
   * here rather than reaching the append.
   */
  async #appendReceipt(
    operationId: string,
    purgeInstant: Date,
    removedSessions: EventCompactedRemovedSession[],
  ): Promise<void> {
    const occurredAt: string = purgeInstant.toISOString();
    const payload: EventCompactedPayload = EventCompactedPayloadSchema.parse({
      nodeId: this.#nodeId,
      operationId,
      occurredAt,
      removedSessions,
    });

    await this.#eventLog.append({
      id: this.#newEventId(),
      sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
      occurredAt,
      category: EVENT_MAINTENANCE_CATEGORY,
      type: PURGE_RECEIPT_TYPE,
      actor: null,
      payload,
      version: PURGE_RECEIPT_VERSION,
    });
  }

  #readPurgeSpan(sessionId: SessionId): PurgeSpan | undefined {
    const row = this.#purgeSpanStmt.get(sessionId) as PurgeSpanRow;
    if (row.from_sequence === null) {
      return undefined;
    }
    return {
      fromSequence: readNumber(row.from_sequence, "lowest purgeable sequence"),
      toSequence: readNumber(row.to_sequence, "highest purgeable sequence"),
    };
  }

  #readCandidateSequences(sessionId: SessionId): readonly number[] {
    const rows: readonly unknown[] = this.#candidateSequencesStmt.all(sessionId);
    return rows.map((raw) =>
      readNumber((raw as { readonly sequence: unknown }).sequence, "candidate sequence"),
    );
  }
}

function projectAuditStub(
  sessionId: SessionId,
  row: CandidateRow,
  eventId: string,
  payloadObject: Record<string, unknown>,
  storedPayloadByteLength: number,
  purgeInstant: Date,
): AuditStubProjection {
  // PARSED, not cast: the category is signed into the stub, and a column value
  // outside the enum would be frozen there by the one operation that destroys
  // the evidence of how it got there.
  const category: EventCategory = EventCategorySchema.parse(
    readString(row.category, "session_events.category"),
  );
  const type: string = readString(row.type, "session_events.type");

  const projection: AuditStubProjection = {
    // Each scalar member is taken from the stored row, since a verifier checks
    // it byte-equal to its column.
    id: eventId,
    sessionId,
    sequence: readNumber(row.sequence, "session_events.sequence"),
    occurredAt: readString(row.occurred_at, "session_events.occurred_at"),
    category,
    type,
    actor: readNullableString(row.actor, "session_events.actor"),
    purgedAt: purgeInstant.toISOString(),
    retentionClass: AUDIT_STUB_RETENTION_CLASS,
    summary: buildStubSummary(category, type, payloadObject, storedPayloadByteLength),
  };

  for (const key of PRESERVED_PAYLOAD_KEYS) {
    const value: unknown = payloadObject[key];
    if (value !== undefined) {
      projection[key] = value;
    }
  }
  return projection;
}

/**
 * A one-line summary composed from the row's SHAPE (category, type, field
 * count, byte count) and never from payload values: the stub carries no PII,
 * and interpolating payload content would put it back into signed bytes kept
 * for the life of the log.
 */
function buildStubSummary(
  category: EventCategory,
  type: string,
  payloadObject: Record<string, unknown>,
  storedPayloadByteLength: number,
): string {
  const fieldCount: number = Object.keys(payloadObject).length;
  return (
    `${category}/${type}: original payload discarded at purge ` +
    `(${String(fieldCount)} fields, ${String(storedPayloadByteLength)} bytes)`
  );
}

/**
 * Canonicalize a stub projection under `EVENT_CANONICAL_BYTES_MAX`, shortening
 * the locally minted `summary` toward the bound and refusing when the projection
 * stays oversized with `summary` gone.
 *
 * It can fire because this module reads rows straight off SQLite, including
 * rows written outside the append path's ceiling, and the preserved members are
 * copied verbatim. `summary` is the one member minted here, so it is the one a
 * bound may shorten; the rest are scalar mirrors or preserved evidence.
 *
 * Measured on canonical bytes and cut by code points: every code point
 * serializes to at least one byte, so each round removes at least the overage
 * and the loop converges, and cutting by code point never splits a surrogate
 * pair, which `canonicalizeJson` would refuse.
 */
function canonicalizeBoundedStubProjection(
  projection: AuditStubProjection,
  eventId: string,
): CanonicalBytes {
  let boundedProjection: AuditStubProjection = projection;
  let canonicalStubBytes: CanonicalBytes = canonicalizeJson(boundedProjection);
  while (
    canonicalStubBytes.length > EVENT_CANONICAL_BYTES_MAX &&
    boundedProjection.summary.length > 0
  ) {
    const overage: number = canonicalStubBytes.length - EVENT_CANONICAL_BYTES_MAX;
    const summaryCodePoints: readonly string[] = Array.from(boundedProjection.summary);
    boundedProjection = {
      ...boundedProjection,
      summary: summaryCodePoints.slice(0, Math.max(0, summaryCodePoints.length - overage)).join(""),
    };
    canonicalStubBytes = canonicalizeJson(boundedProjection);
  }
  if (canonicalStubBytes.length > EVENT_CANONICAL_BYTES_MAX) {
    throw new SessionPurgeRefusal(
      `audit-stub projection for event ${eventId} is ${String(canonicalStubBytes.length)} ` +
        `canonical bytes with its summary already emptied, over the ` +
        `${String(EVENT_CANONICAL_BYTES_MAX)}-byte EVENT_CANONICAL_BYTES_MAX bound every ` +
        "stored payload must satisfy; every remaining member is a scalar mirror or preserved " +
        "content this purge may not shorten.",
    );
  }
  return canonicalStubBytes;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A later failure keeps the earlier cause, because the first explains why the
// session's purge stopped where it did.
function appendReason(existing: string | undefined, next: string): string {
  return existing === undefined ? next : `${existing}; ${next}`;
}

function parsePayload(storedPayload: string, eventId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedPayload);
  } catch (error) {
    throw new SessionPurgeRefusal(
      `session_events.payload for event ${eventId} is not valid JSON (${describeError(error)}).`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SessionPurgeRefusal(
      `session_events.payload for event ${eventId} is not a JSON object; the stub projection ` +
        "cannot read the preserved members out of it.",
    );
  }
  return parsed as Record<string, unknown>;
}

function readString(value: unknown, column: string): string {
  if (typeof value === "string") return value;
  throw new SessionPurgeRefusal(
    `${column} is not TEXT (got ${typeof value}); the stored row is corrupt.`,
  );
}

function readNullableString(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  return readString(value, column);
}

/**
 * A finite number, accepting a `bigint` only when it round-trips as a safe
 * integer: past 2^53 the nearest double names a different row, and a byte count
 * would be signed wrong into a stub kept for the life of the log.
 */
function readNumber(value: unknown, column: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const narrowed: number = Number(value);
    if (Number.isSafeInteger(narrowed)) return narrowed;
    throw new SessionPurgeRefusal(
      `${column} is a bigint past the safe-integer range (${String(value)}); refusing to narrow ` +
        "it, because the nearest double names a different row than the one stored.",
    );
  }
  throw new SessionPurgeRefusal(
    `${column} is not a finite INTEGER (got ${typeof value}); the stored row is corrupt.`,
  );
}
