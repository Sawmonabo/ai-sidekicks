// Contract coverage for `EventLogService` — the sole durable append path
// (Plan-006 T3.1).
//
// The arms here are SEQUENTIAL and SERVICE-LEVEL. The two registry mechanisms
// that are invisible to any serial call order live in `ingest-halt-source.test.ts`
// and are deliberately not repeated: this file exercises the gate through
// `append()`, that one exercises the registry through its own surface.
//
// FIVE PROPERTIES THIS FILE IS RESPONSIBLE FOR, each of which fails silently if
// nobody asserts it:
//
//   1. HASH-CHAIN INTEGRITY, in BOTH halves. `verifyRow` is intra-row by
//      contract — it is handed one row's canonical bytes and its own three
//      integrity columns, and its SCOPE note says outright that a per-row pass
//      over a log with a DELETED middle row returns `valid: true` throughout.
//      The linkage half (`prev_hash[n] === row_hash[n-1]`, `GENESIS_PREV_HASH`
//      at sequence 0) is the range-walking caller's obligation, so this file
//      walks it explicitly and proves the two halves see different defects.
//   2. PII INDIRECTION at the persistence boundary: the owner stamp reaches its
//      durable column, the ciphertext reaches `pii_payload`, and the row still
//      verifies against bytes that carry the digest rather than the plaintext.
//   3. THE TWO TYPED REFUSALS, asserted through `mapJsonRpcError` rather than
//      through `instanceof`. `daemon.ingest_halted` and `daemon.pii_split_bypass`
//      exist to reach a CLIENT, and the thing a client reads is `data.type`
//      beside `data.fields`. An arm that stops at the throw would stay green
//      through a detail that never got parsed and therefore renders `undefined`.
//   4. SERIALIZATION. Concurrent appends on one session must not derive the same
//      chain link, reentrant appends must not deadlock, and a throwing
//      `transactionalPrelude` must consume no sequence.
//   5. THE CHAIN-HEAD READ BOUNDARY. A declared SQLite column type is AFFINITY
//      and not enforcement, so both head columns are read back as `unknown` and
//      narrowed. The next row's `sequence` and its `prev_hash` are BOTH derived
//      from that one read, which is what makes a wrong-typed head a value that
//      gets signed rather than refused.
//
// FIXTURE NOTE — the signing key source answers for EVERY session id, the
// daemon-scope sentinel included. A per-session map keyed only on the fixture's
// session would make any daemon-scope append (the compactor's `event.compacted`,
// which travels this same path in `compactor.test.ts`) fail mid-flight rather
// than fail loudly.
//
// Spec coverage: `Spec-006 §Integrity Protocol` (each row chained to its
// predecessor), `Spec-006 §Canonical Serialization Rules`
// (`pii_ciphertext_digest`), `Spec-006 §Security Events (security_events)`
// (`daemon.pii_split_bypass`), `Spec-006 §Audit Integrity (audit_integrity)`
// (the halt state the gate reads). Refs: Plan-006 T3.1, T3.5, I-006-4-03,
// I-006-2-04, I-006-2-12.

import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  DAEMON_EVENT_CANONICAL_BYTES_EXCEEDED_CODE,
  DAEMON_INGEST_HALTED_CODE,
  DAEMON_PII_SPLIT_BYPASS_CODE,
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EVENT_CANONICAL_BYTES_MAX,
  EventEnvelopeVersionSchema,
  JsonRpcErrorCode,
  SessionIdSchema,
  type EventEnvelope,
  type JsonRpcErrorResponse,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { mapJsonRpcError } from "../../ipc/jsonrpc-error-mapping.js";
import { openDatabase } from "../../session/migration-runner.js";
import { canonicalizeEvent, type CanonicalBytes } from "../canonicalizer.js";
import {
  EventLogService,
  type EventLogAppendReceipt,
  type UnsequencedEventEnvelope,
} from "../event-log-service.js";
import { IngestHaltRegistry, NeverHaltedIngestHaltSource } from "../ingest-halt-source.js";
import {
  CodecOwnedContentKeyError,
  PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  PII_PARTICIPANT_ID_PAYLOAD_KEY,
  type PiiEncryptionRequest,
  type PiiEncryptor,
} from "../pii-indirection.js";
import { __resetSessionAppendLocksForTest, withSessionAppendLock } from "../session-append-lock.js";
import type { SessionContentKeySource } from "../session-content-key-store.js";
import {
  GENESIS_PREV_HASH,
  verifyRow,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  type RowVerification,
  type SignedRow,
} from "../signer.js";
import type { DaemonSigningKeySource } from "../signing-key-source.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10");
const OTHER_SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");

// A UUID rather than a readable slug, and the constraint is a real one worth
// knowing before writing a fixture: `pii_participant_id` is plain TEXT and
// `EventLogAppendPii` types the id as a bare `string`, but
// `EventShreddedPayloadSchema` requires a UUID. A participant that will ever be
// named in a shred record has to be one from the start, or the two halves of
// Plan-022 Path 1 disagree about who was shredded.
const PARTICIPANT = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";

const DAEMON_PRIVATE_KEY = new Uint8Array(32).fill(11) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY = ed25519.getPublicKey(DAEMON_PRIVATE_KEY) as Ed25519PublicKey;

let database: DatabaseType;

beforeEach(() => {
  // The production migration runner, never hand-rolled DDL: the terminal-key
  // triggers, the CHECK constraints on the three integrity columns and the
  // `UNIQUE(session_id, sequence)` key are all part of what these arms assert
  // against, and a bespoke CREATE TABLE would quietly drop them.
  database = openDatabase(":memory:");
  // The append lock is a module SINGLETON that survives the database, so a case
  // that leaves a queue entry behind would otherwise surface as an unrelated
  // timeout in the next one.
  __resetSessionAppendLocksForTest();
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
  database.close();
});

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

/** One macrotask — later than every pending microtask. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Whether `work` settles within `turns` macrotasks.
 *
 * The lock arms below assert BOTH directions — that something proceeds and that
 * something else waits — and the waiting direction has no natural assertion: a
 * hold that leaks manifests as a promise that never settles, which an ordinary
 * `await` turns into a suite-wide timeout rather than a named failure. Sampling a
 * bounded number of turns reports the defect where it happened.
 */
async function settlesWithin(work: Promise<unknown>, turns: number): Promise<boolean> {
  let settled = false;
  const observe = (): void => {
    settled = true;
  };
  void work.then(observe, observe);
  for (let turn = 0; turn < turns; turn += 1) await tick();
  return settled;
}

/**
 * A signing key source that answers for ANY session id, including the
 * daemon-scope sentinel.
 *
 * `gate`, when set, parks every `read` until it resolves — which is how an
 * append is held mid-flight AFTER it has passed the admission gate and taken the
 * lock. That is the real production shape (a key unseal may await a WebAuthn
 * ceremony), so parking there rather than at an artificial seam keeps the
 * interleaving arms honest.
 */
class ParkableSigningKeySource implements DaemonSigningKeySource {
  gate: Promise<void> | undefined;
  readCallCount = 0;

  create(): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    return Promise.resolve({ publicKey: DAEMON_PUBLIC_KEY });
  }

  async read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    this.readCallCount += 1;
    if (this.gate !== undefined) await this.gate;
    return DAEMON_PRIVATE_KEY;
  }
}

/**
 * The CP-006-1 stub: an XOR over a BLAKE3 keystream seeded by
 * `participantId || eventId`.
 *
 * Not an AEAD and not trying to be. It is DETERMINISTIC, which is what lets an
 * arm name expected bytes instead of re-deriving them, and it binds the two
 * identifiers in the one observable way a stub can — a ciphertext minted for one
 * (participant, event) pair differs bytewise from every other pair's.
 * `writeEventWithPii` digests whatever bytes it is handed and asserts nothing
 * about their width, exactly as CP-006-1 requires of an interface that fixes no
 * AEAD.
 */
class DeterministicPiiEncryptor implements PiiEncryptor {
  encryptCallCount = 0;

  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array> {
    this.encryptCallCount += 1;
    const keystream = blake3(
      new TextEncoder().encode(`${request.participantId} ${request.eventId}`),
      { dkLen: Math.max(1, request.plaintext.length) },
    );
    const sealed = new Uint8Array(request.plaintext.length);
    for (let index = 0; index < request.plaintext.length; index += 1) {
      sealed[index] = (request.plaintext[index] ?? 0) ^ (keystream[index] ?? 0);
    }
    return Promise.resolve(sealed);
  }
}

interface ServiceFixture {
  readonly service: EventLogService;
  readonly keySource: ParkableSigningKeySource;
  readonly encryptor: DeterministicPiiEncryptor;
  readonly haltRegistry: IngestHaltRegistry;
}

/**
 * A content-key seam that always answers, so the SEALING branch of `#signEvent`
 * is genuinely reachable in this file.
 *
 * Deliberately not the real {@link SessionContentKeyStore}: the arm that uses it
 * asserts WHERE a guard runs, and a store would drag the wrap format, the master
 * key and the mint race into a placement test. `session-content-partition.test.ts`
 * owns the real store against a real table.
 */
const ALWAYS_RESOLVING_CONTENT_KEY_SOURCE: SessionContentKeySource = {
  resolveForWrite: (sessionId) =>
    Promise.resolve({ sessionId, key: new Uint8Array(32).fill(9), keyVersion: 1 }),
};

function buildService(options?: {
  readonly withoutEncryptor?: boolean;
  readonly withContentKeySource?: boolean;
}): ServiceFixture {
  const keySource = new ParkableSigningKeySource();
  const encryptor = new DeterministicPiiEncryptor();
  const haltRegistry = new IngestHaltRegistry();
  const service = new EventLogService({
    db: database,
    signingKeySource: keySource,
    haltSource: haltRegistry,
    ...(options?.withoutEncryptor === true ? {} : { piiEncryptor: encryptor }),
    ...(options?.withContentKeySource === true
      ? { contentKeySource: ALWAYS_RESOLVING_CONTENT_KEY_SOURCE }
      : {}),
  });
  return { service, keySource, encryptor, haltRegistry };
}

let envelopeCounter = 0;

function makeEnvelope(overrides?: Partial<UnsequencedEventEnvelope>): UnsequencedEventEnvelope {
  envelopeCounter += 1;
  return {
    id: `evt-${String(envelopeCounter).padStart(4, "0")}`,
    sessionId: SESSION,
    occurredAt: "2026-08-04T12:00:00.000Z",
    category: "session_lifecycle",
    type: "session.updated",
    actor: null,
    payload: { note: `append ${String(envelopeCounter)}` },
    version: ENVELOPE_VERSION,
    ...overrides,
  };
}

/** The stored row, hydrated into exactly what `verifyRow` needs plus the PII columns. */
interface HydratedRow {
  readonly envelope: EventEnvelope;
  readonly canonical: CanonicalBytes;
  readonly signedRow: SignedRow;
  readonly piiPayload: Uint8Array | null;
  readonly piiParticipantId: string | null;
}

interface RawEventRow {
  readonly id: string;
  readonly session_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly category: string;
  readonly type: string;
  readonly actor: string | null;
  readonly payload: string;
  readonly pii_payload: Uint8Array | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly version: string;
  readonly prev_hash: Uint8Array;
  readonly row_hash: Uint8Array;
  readonly daemon_signature: Uint8Array;
  readonly pii_participant_id: string | null;
}

function readRawRows(sessionId: SessionId): ReadonlyArray<RawEventRow> {
  return database
    .prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence ASC")
    .all(sessionId) as ReadonlyArray<RawEventRow>;
}

/**
 * Rebuild the canonical bytes FROM STORAGE, never from the input the test handed
 * `append()`.
 *
 * That direction is the whole point: a verifier recomputes from what was
 * PERSISTED, so an arm that canonicalized its own input would stay green through
 * a service that signed one spelling of `occurredAt` and stored another — which
 * is exactly the drift `occurred_at_not_canonical` exists to catch.
 */
function hydrate(row: RawEventRow): HydratedRow {
  const envelope: EventEnvelope = {
    id: row.id,
    sessionId: SessionIdSchema.parse(row.session_id),
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    // The column is TEXT and TypeScript knows nothing about which canonical
    // category it holds; the append path already refused anything else.
    category: row.category as EventEnvelope["category"],
    type: row.type,
    actor: row.actor,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    version: EventEnvelopeVersionSchema.parse(row.version),
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
    ...(row.causation_id !== null ? { causationId: row.causation_id } : {}),
  };
  return {
    envelope,
    canonical: canonicalizeEvent(envelope),
    signedRow: {
      prevHash: row.prev_hash,
      rowHash: row.row_hash,
      daemonSignature: row.daemon_signature,
    },
    piiPayload: row.pii_payload,
    piiParticipantId: row.pii_participant_id,
  };
}

/**
 * The LINKAGE walk — I-006-2-04's second clause, which `verifyRow` explicitly
 * does not check. Returns the first defect found, or `undefined` for an intact
 * chain.
 */
function walkChainLinkage(sessionId: SessionId): string | undefined {
  const rows = readRawRows(sessionId);
  let expectedSequence = 0;
  let expectedPrevHash: Uint8Array = GENESIS_PREV_HASH;
  for (const row of rows) {
    if (row.sequence !== expectedSequence) {
      return `sequence gap: expected ${String(expectedSequence)}, stored ${String(row.sequence)}`;
    }
    if (!bytesEqual(row.prev_hash, expectedPrevHash)) {
      return `prev_hash at sequence ${String(row.sequence)} does not link to its predecessor`;
    }
    expectedSequence += 1;
    expectedPrevHash = row.row_hash;
  }
  return undefined;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Every row in the session, verified INTRA-ROW. */
function verifyEveryRow(sessionId: SessionId): ReadonlyArray<RowVerification> {
  return readRawRows(sessionId).map((row) => {
    const hydrated = hydrate(row);
    return verifyRow(hydrated.canonical, hydrated.signedRow, DAEMON_PUBLIC_KEY);
  });
}

/** The refusal as a CLIENT sees it. */
async function mappedRefusalOf(work: Promise<unknown>): Promise<JsonRpcErrorResponse> {
  try {
    await work;
  } catch (thrown) {
    return mapJsonRpcError(thrown, "req-1");
  }
  throw new Error("expected the append to be refused, but it resolved");
}

// ----------------------------------------------------------------------------
// Hash-chain integrity — `Plan-006 §Test And Verification Plan`'s hash-chain row
// ----------------------------------------------------------------------------

describe("EventLogService — hash chain (I-006-2-04)", () => {
  it("opens a session's chain at sequence 0 with the genesis prev_hash", async () => {
    const { service } = buildService();

    const receipt: EventLogAppendReceipt = await service.append(makeEnvelope());

    expect(receipt.sequence).toBe(0);
    const [row] = readRawRows(SESSION);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(bytesEqual(row.prev_hash, GENESIS_PREV_HASH)).toBe(true);
    // The receipt is the caller's copy of the new chain head; a receipt that did
    // not match storage would send the next producer chaining onto a hash the
    // log does not hold.
    expect(bytesEqual(receipt.rowHash, row.row_hash)).toBe(true);
    const hydrated = hydrate(row);
    expect(verifyRow(hydrated.canonical, hydrated.signedRow, DAEMON_PUBLIC_KEY)).toEqual({
      valid: true,
    });
  });

  it("chains every row to its predecessor and verifies all of them", async () => {
    const { service } = buildService();

    for (let index = 0; index < 6; index += 1) {
      await service.append(makeEnvelope({ payload: { index } }));
    }

    const rows = readRawRows(SESSION);
    expect(rows.map((row) => row.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(walkChainLinkage(SESSION)).toBeUndefined();
    expect(verifyEveryRow(SESSION)).toEqual(Array.from({ length: 6 }, () => ({ valid: true })));
  });

  it("partitions the chain per session — each session opens at its own genesis", async () => {
    const { service } = buildService();

    await service.append(makeEnvelope());
    await service.append(makeEnvelope({ sessionId: OTHER_SESSION }));
    await service.append(makeEnvelope());
    await service.append(makeEnvelope({ sessionId: OTHER_SESSION }));

    expect(readRawRows(SESSION).map((row) => row.sequence)).toEqual([0, 1]);
    expect(readRawRows(OTHER_SESSION).map((row) => row.sequence)).toEqual([0, 1]);
    expect(walkChainLinkage(SESSION)).toBeUndefined();
    expect(walkChainLinkage(OTHER_SESSION)).toBeUndefined();
  });

  it("reports hash_mismatch when a stored payload is tampered with at rest", async () => {
    const { service } = buildService();
    const receipt = await service.append(makeEnvelope({ payload: { amount: 1 } }));

    database
      .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ amount: 1000 }), receipt.id);

    // Recomputing from the TAMPERED bytes no longer reproduces the stored
    // `row_hash`, and rule 1 fails before rule 2 is ever evaluated.
    expect(verifyEveryRow(SESSION)).toEqual([{ valid: false, failureMode: "hash_mismatch" }]);
  });

  it("catches a DELETED middle row that survives every per-row check", async () => {
    // THE PAIRING IS THE POINT, and it doubles as the negative control for every
    // arm above that walks linkage: deleting a row forges nothing, so all three
    // survivors still verify intra-row. Only the linkage walk sees the hole. A
    // suite built on `verifyRow` alone would report a clean log here.
    const { service } = buildService();
    for (let index = 0; index < 4; index += 1) {
      await service.append(makeEnvelope({ payload: { index } }));
    }

    database
      .prepare("DELETE FROM session_events WHERE session_id = ? AND sequence = 1")
      .run(SESSION);

    expect(verifyEveryRow(SESSION)).toEqual([{ valid: true }, { valid: true }, { valid: true }]);
    expect(walkChainLinkage(SESSION)).toBe("sequence gap: expected 1, stored 2");
  });
});

// ----------------------------------------------------------------------------
// The chain-head read boundary — both columns read as `unknown`, then narrowed
// ----------------------------------------------------------------------------
//
// The HEALTHY direction is already pinned and is deliberately not repeated: the
// linkage walk above IS the narrowed head round-tripping, since every
// `prev_hash` it checks is the previous row's `row_hash` as this read returned
// it. What is left is the refusal direction, and only one of the two `row_hash`
// disjuncts is reachable from SQL — `CHECK(length(row_hash) = 32)` closes the
// wrong-WIDTH case for any value SQLite stores as a BLOB, so the width half is
// defense-in-depth and the TYPE half is what actually fires.

describe("EventLogService — chain-head read boundary", () => {
  // 32 CHARACTERS. `length()` counts characters on a TEXT value and bytes only
  // on a BLOB, so this passes `CHECK(length(row_hash) = 32)` while storing
  // something that is not a hash at all.
  const THIRTY_TWO_CHARACTER_TEXT = "0".repeat(32);

  it("refuses a head whose sequence is not an INTEGER rather than allocating from it", async () => {
    // INTEGER affinity coerces only text that LOOKS numeric, so `'x'` stays
    // TEXT — and SQLite orders TEXT above every INTEGER, which is what makes the
    // corrupted row the head that `ORDER BY sequence DESC` selects.
    //
    // TWO rows seeded and the LOWER one corrupted, deliberately: with a single
    // row the corrupt value is the head whatever the query orders by, so the arm
    // would stay green through a head read that lost its `ORDER BY` entirely.
    const { service } = buildService();
    await service.append(makeEnvelope());
    await service.append(makeEnvelope());

    database
      .prepare("UPDATE session_events SET sequence = 'x' WHERE session_id = ? AND sequence = 0")
      .run(SESSION);

    await expect(service.append(makeEnvelope())).rejects.toThrow(
      /session_events\.sequence for session .+ is not an INTEGER: got a value of type string/,
    );
    // Unnarrowed, `Number('x') + 1` is `NaN` — bound as this row's `sequence`,
    // signed into its canonical bytes, and stored.
    expect(readRawRows(SESSION)).toHaveLength(2);
  });

  it("refuses a head whose row_hash arrives as TEXT rather than chaining it into prev_hash", async () => {
    // `row_hash` is declared BLOB, which gives the column affinity NONE — a
    // bound string is stored AS TEXT and read back as a JS `string`. Nothing in
    // the DDL objects, so this read is the only thing standing between a value
    // that is not a hash and the next row's signed `prev_hash`.
    const { service } = buildService();
    await service.append(makeEnvelope());

    database
      .prepare("UPDATE session_events SET row_hash = ? WHERE session_id = ?")
      .run(THIRTY_TWO_CHARACTER_TEXT, SESSION);

    await expect(service.append(makeEnvelope())).rejects.toThrow(
      /session_events\.row_hash for session .+ is not a 32-byte BLOB: got a non-Uint8Array value of type string/,
    );
    expect(readRawRows(SESSION)).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// PII indirection at the persistence boundary
// ----------------------------------------------------------------------------

describe("EventLogService — PII indirection (Spec-006 §Canonical Serialization Rules)", () => {
  it("persists the owner stamp in its durable column and the ciphertext in pii_payload", async () => {
    const { service, encryptor } = buildService();

    const receipt = await service.append(
      // A real `assistant.message` payload rather than `{}`: that type has a
      // registered `SessionEventSchema` variant, and the codec parses the
      // COMPOSED row against it before signing. An empty payload would be
      // refused for the two members the variant requires.
      makeEnvelope({
        category: "assistant_output",
        type: "assistant.message",
        payload: { sessionId: SESSION, runId: "run-1" },
      }),
      { pii: { participantId: PARTICIPANT, piiPayload: { text: "secret prose" } } },
    );

    expect(encryptor.encryptCallCount).toBe(1);
    const [row] = readRawRows(SESSION);
    expect(row).toBeDefined();
    if (row === undefined) return;
    const hydrated = hydrate(row);

    // The durable column carries the SAME id the codec stamped into the payload
    // — the two are what a post-shred verifier joins on, so they must agree.
    expect(hydrated.piiParticipantId).toBe(PARTICIPANT);
    expect(hydrated.envelope.payload[PII_PARTICIPANT_ID_PAYLOAD_KEY]).toBe(PARTICIPANT);
    expect(typeof hydrated.envelope.payload[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe("string");
    expect(hydrated.piiPayload).toBeInstanceOf(Uint8Array);

    // The plaintext never reaches the hashed, signed, un-shreddable column.
    expect(row.payload).not.toContain("secret prose");

    // And the row still verifies against bytes that carry the digest rather
    // than the plaintext.
    expect(verifyRow(hydrated.canonical, hydrated.signedRow, DAEMON_PUBLIC_KEY)).toEqual({
      valid: true,
    });
    expect(receipt.sequence).toBe(0);
  });

  it("leaves both PII columns NULL on a row that carries no partition", async () => {
    const { service, encryptor } = buildService();

    await service.append(makeEnvelope());

    const [row] = readRawRows(SESSION);
    expect(row?.pii_payload).toBeNull();
    expect(row?.pii_participant_id).toBeNull();
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a PII partition when no encryptor is wired, rather than persisting it in the clear", async () => {
    const { service } = buildService({ withoutEncryptor: true });

    await expect(
      service.append(makeEnvelope({ category: "assistant_output" }), {
        pii: { participantId: PARTICIPANT, piiPayload: { text: "secret prose" } },
      }),
    ).rejects.toThrow(/PiiEncryptor/);

    expect(readRawRows(SESSION)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// `daemon.pii_split_bypass` — asserted as the MAPPED envelope
// ----------------------------------------------------------------------------

describe("EventLogService — daemon.pii_split_bypass (Spec-006 §Security Events (security_events))", () => {
  it("refuses a payload carrying the reserved owner stamp, reporting the KEY path", async () => {
    const { service } = buildService();

    const mapped = await mappedRefusalOf(
      service.append(
        makeEnvelope({
          payload: { [PII_PARTICIPANT_ID_PAYLOAD_KEY]: PARTICIPANT, note: "x" },
        }),
      ),
    );

    expect(mapped.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(mapped.error.data?.type).toBe(DAEMON_PII_SPLIT_BYPASS_CODE);
    // A KEY path and never a value: the write is refused BECAUSE it carries PII
    // outside the split, so echoing the value would complete the leak.
    expect(mapped.error.data?.fields).toEqual({
      fieldPath: `payload.${PII_PARTICIPANT_ID_PAYLOAD_KEY}`,
    });
    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("refuses a payload carrying the reserved ciphertext digest", async () => {
    const { service } = buildService();

    const mapped = await mappedRefusalOf(
      service.append(
        makeEnvelope({ payload: { [PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "not-a-real-digest" } }),
      ),
    );

    expect(mapped.error.data?.type).toBe(DAEMON_PII_SPLIT_BYPASS_CODE);
    expect(mapped.error.data?.fields).toEqual({
      fieldPath: `payload.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}`,
    });
    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("reports the owner-stamp path first when a payload carries both reserved keys", async () => {
    const { service } = buildService();

    const mapped = await mappedRefusalOf(
      service.append(
        makeEnvelope({
          payload: {
            [PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "d",
            [PII_PARTICIPANT_ID_PAYLOAD_KEY]: PARTICIPANT,
          },
        }),
      ),
    );

    expect(mapped.error.data?.fields).toEqual({
      fieldPath: `payload.${PII_PARTICIPANT_ID_PAYLOAD_KEY}`,
    });
  });

  it("never echoes the offending payload value into the error envelope", async () => {
    const { service } = buildService();

    const mapped = await mappedRefusalOf(
      service.append(
        makeEnvelope({
          payload: { [PII_PARTICIPANT_ID_PAYLOAD_KEY]: "participant-with-real-pii-in-the-id" },
        }),
      ),
    );

    expect(JSON.stringify(mapped)).not.toContain("participant-with-real-pii-in-the-id");
  });
});

// ----------------------------------------------------------------------------
// The ingest-halt gate — `daemon.ingest_halted`, consulted first, under the lock
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// `daemon.event_canonical_bytes_exceeded` — the `Spec-006 §Canonical
// Serialization Rules` append ceiling, on BOTH branches of the sign step
// ----------------------------------------------------------------------------

describe("EventLogService — daemon.event_canonical_bytes_exceeded (Spec-006 §Canonical Serialization Rules)", () => {
  /**
   * An envelope whose STORED canonical form is exactly `targetBytes` long.
   *
   * Computed from the same storable shape the service canonicalizes — the
   * input plus `sequence` — and padded with an ASCII filler, so every added
   * character is exactly one canonical byte and the arithmetic is byte-exact.
   * `sequence` is a parameter because its DECIMAL WIDTH is inside the
   * canonical form: a fixture computed at sequence 0 is one byte short of its
   * target at sequence 10.
   */
  function envelopeOfCanonicalSize(
    targetBytes: number,
    sequence: number,
    overrides?: Partial<UnsequencedEventEnvelope>,
  ): UnsequencedEventEnvelope {
    const template = makeEnvelope({ ...overrides, payload: { filler: "" } });
    const storable: EventEnvelope = { ...template, sequence };
    const emptyFillerLength = canonicalizeEvent(storable).length;
    return { ...template, payload: { filler: "x".repeat(targetBytes - emptyFillerLength) } };
  }

  it("admits a row whose canonical form sits exactly AT the ceiling", async () => {
    const { service } = buildService();

    const receipt = await service.append(envelopeOfCanonicalSize(EVENT_CANONICAL_BYTES_MAX, 0));

    expect(receipt.sequence).toBe(0);
    const rows = readRawRows(SESSION);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) return;
    // Byte-exact and FROM STORAGE: the stored row re-canonicalizes to exactly
    // the ceiling and still verifies — the bound is inclusive, and an
    // off-by-one here is precisely the defect the exact fixture exists to
    // catch.
    expect(hydrate(row).canonical.length).toBe(EVENT_CANONICAL_BYTES_MAX);
    expect(verifyEveryRow(SESSION)).toEqual([{ valid: true }]);
  });

  it("refuses ONE byte over with the typed 400-equivalent envelope, writing nothing", async () => {
    const { service } = buildService();

    const mapped = await mappedRefusalOf(
      service.append(envelopeOfCanonicalSize(EVENT_CANONICAL_BYTES_MAX + 1, 0)),
    );

    expect(mapped.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(mapped.error.data?.type).toBe(DAEMON_EVENT_CANONICAL_BYTES_EXCEEDED_CODE);
    expect(mapped.error.data?.fields).toEqual({
      canonicalBytes: EVENT_CANONICAL_BYTES_MAX + 1,
      maxCanonicalBytes: EVENT_CANONICAL_BYTES_MAX,
    });
    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("advances no chain head and consumes no sequence on a refused oversized append", async () => {
    const { service } = buildService();
    await service.append(makeEnvelope());

    await expect(
      service.append(envelopeOfCanonicalSize(EVENT_CANONICAL_BYTES_MAX + 1, 1)),
    ).rejects.toThrow(/EVENT_CANONICAL_BYTES_MAX/);

    // No partial row, and the NEXT admitted append takes sequence 1 rather
    // than a number the refusal burned.
    expect(readRawRows(SESSION)).toHaveLength(1);
    const readmitted = await service.append(makeEnvelope());
    expect(readmitted.sequence).toBe(1);
    expect(walkChainLinkage(SESSION)).toBeUndefined();
  });

  it("holds the PII branch to the DIGEST-BEARING form — the identical envelope plain-appends", async () => {
    // The PII split embeds the ciphertext digest and the owner stamp into the
    // canonical member set, so the form THAT branch signs is wider than the
    // caller's payload. An envelope built to sit exactly at the ceiling
    // therefore clears the plain branch and exceeds it on the PII branch —
    // the discriminating fixture: a service that measured the caller's
    // payload instead of the signed form would admit both.
    const { service, encryptor } = buildService();
    // A census type with NO registered `SessionEventSchema` variant, so this
    // arm measures the byte ceiling and nothing else. `assistant.message` would
    // draw the codec's composed-variant refusal first — its variant is strict
    // and declares no `filler` — and this fixture's whole point is a payload
    // padded to an exact canonical width, which no registered variant admits.
    const atCeiling = envelopeOfCanonicalSize(EVENT_CANONICAL_BYTES_MAX, 0, {
      category: "tool_activity",
      type: "tool.replayed",
    });

    const mapped = await mappedRefusalOf(
      service.append(atCeiling, {
        pii: { participantId: PARTICIPANT, piiPayload: { text: "secret prose" } },
      }),
    );

    expect(mapped.error.data?.type).toBe(DAEMON_EVENT_CANONICAL_BYTES_EXCEEDED_CODE);
    const fields = mapped.error.data?.fields as {
      canonicalBytes: number;
      maxCanonicalBytes: number;
    };
    expect(fields.maxCanonicalBytes).toBe(EVENT_CANONICAL_BYTES_MAX);
    // Over by the embedded members' width, not by the fixture's arithmetic.
    expect(fields.canonicalBytes).toBeGreaterThan(EVENT_CANONICAL_BYTES_MAX);
    // One AEAD seal was spent: the refusal is deliberately POST-encrypt (the
    // digest-bearing form exists only downstream of the embed — see
    // `PiiEventWriteResult.canonicalByteLength`) ...
    expect(encryptor.encryptCallCount).toBe(1);
    // ... and NOTHING was persisted: no row, no orphaned PII columns.
    expect(readRawRows(SESSION)).toHaveLength(0);

    // The identical envelope WITHOUT the partition is admissible — its plain
    // canonical form sits exactly at the bound.
    const receipt = await service.append(atCeiling);
    expect(receipt.sequence).toBe(0);
  });

  it("never echoes the oversized payload into the error envelope", async () => {
    const { service } = buildService();

    const mapped = await mappedRefusalOf(
      service.append(envelopeOfCanonicalSize(EVENT_CANONICAL_BYTES_MAX + 1, 0)),
    );

    // The detail is two SIZES and the message names the id and the bound. The
    // filler must appear nowhere: an error envelope echoing a 32 KiB payload
    // would defeat the ceiling at the exact moment it fired.
    expect(JSON.stringify(mapped)).not.toContain("xxxxxxxx");
  });
});

// ----------------------------------------------------------------------------
// PARSE WHAT WILL BE SIGNED, on the branch that seals nothing — the plain-append
// half of the shared `assertRegisteredVariantParses` seam
// ----------------------------------------------------------------------------

describe("EventLogService — the plain branch parses what it signs", () => {
  /** A `session.created` payload its own registered variant accepts. */
  const validSessionCreatedPayload = { sessionId: SESSION, config: {}, metadata: {} };

  it("refuses a REGISTERED type whose payload its own variant rejects", async () => {
    const { service } = buildService();

    await expect(
      service.append(
        makeEnvelope({ type: "session.created", payload: { note: "not the registered shape" } }),
      ),
    ).rejects.toThrow(
      /EventLogService\.append refuses to sign an event of type "session\.created"/,
    );
  });

  it("names the offending members, so the caller can fix the payload", async () => {
    const { service } = buildService();

    await expect(
      service.append(
        makeEnvelope({ type: "session.created", payload: { note: "not the registered shape" } }),
      ),
    ).rejects.toThrow(/payload\.sessionId \(invalid_type\)/);
  });

  it("refuses BEFORE signing — no row, no burnt sequence", async () => {
    // The positional claim, asserted rather than narrated: a refusal that
    // happened after the INSERT would leave the row behind, and one that
    // happened after sequencing would push the next append to 1.
    const { service } = buildService();

    await expect(
      service.append(makeEnvelope({ type: "session.created", payload: { note: "x" } })),
    ).rejects.toThrow();

    expect(readRawRows(SESSION)).toHaveLength(0);
    const readmitted = await service.append(
      makeEnvelope({ type: "session.created", payload: validSessionCreatedPayload }),
    );
    expect(readmitted.sequence).toBe(0);
  });

  it("admits the same REGISTERED type once its payload matches (positive control)", async () => {
    // Without this the refusals above could come from an unsatisfiable rule
    // rather than from the defect.
    const { service } = buildService();

    const receipt = await service.append(
      makeEnvelope({ type: "session.created", payload: validSessionCreatedPayload }),
    );

    expect(receipt.sequence).toBe(0);
    expect(readRawRows(SESSION)).toHaveLength(1);
  });

  it("still signs an UNREGISTERED census type carrying an ad-hoc payload", async () => {
    // THE TOLERANT-CARRIER CONTROL ON THIS PATH. `session.updated` is a census
    // member with no registered payload variant, and `ADR-018 §Decision` #5/#9
    // requires a reader to "persist an envelope whose `type` it cannot
    // interpret as a version stub — never drop or reject it". A guard that
    // refused here would reject exactly the envelopes the stub path exists to
    // preserve.
    const { service } = buildService();

    const receipt = await service.append(
      makeEnvelope({ type: "session.updated", payload: { anything: "at all", n: 7 } }),
    );

    expect(receipt.sequence).toBe(0);
    expect(readRawRows(SESSION)).toHaveLength(1);
  });

  it("leaves the reserved-key refusal FIRST on a registered type (ordering pin)", async () => {
    // The strict layer now REGISTERS both reserved keys as optional members, so
    // this payload parses cleanly and the new guard has nothing to say about
    // it. `#assertNoReservedPiiKeys` is therefore the sole refusal for a
    // caller-embedded owner stamp on this path — and it is the one that names
    // the field path and the remedy. Were the two ever reordered, or the
    // reserved-key guard dropped on the assumption the parse now covers it,
    // this pin fails.
    const { service } = buildService();

    const mapped = await mappedRefusalOf(
      service.append(
        makeEnvelope({
          type: "session.created",
          payload: { ...validSessionCreatedPayload, [PII_PARTICIPANT_ID_PAYLOAD_KEY]: PARTICIPANT },
        }),
      ),
    );

    expect(mapped.error.data?.type).toBe(DAEMON_PII_SPLIT_BYPASS_CODE);
    expect(JSON.stringify(mapped)).not.toContain("SessionEventSchema");
  });
});

// ----------------------------------------------------------------------------
// The codec-owned CONTENT trio on the plain path
// ----------------------------------------------------------------------------
//
// The plain-vs-codec branch is chosen from `options.content`, NOT from the
// payload. A caller that omits `options.content` and seeds
// `contentCiphertextDigest` therefore takes the plain branch, where nothing is
// sealed and the payload the caller supplied is the payload that gets signed —
// minting a row whose signed digest names ciphertext the column does not hold.
// That row reads `digest_unbound` on every read FOREVER: the signature is over
// the forged claim, so nothing can repair it without breaking the chain. The
// read-side binding check detects it and cannot prevent it, which is why the
// refusal is at the write.

describe("EventLogService — codec-owned content keys are refused before the branch", () => {
  const validSessionCreatedPayload = { sessionId: SESSION, config: {}, metadata: {} };

  const forgeableMembers: ReadonlyArray<readonly [string, unknown]> = [
    [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY, "a".repeat(64)],
    [CONTENT_LENGTH_PAYLOAD_KEY, 4096],
    [CONTENT_TRUNCATED_PAYLOAD_KEY, true],
  ];

  it.each(forgeableMembers)("refuses a payload pre-seeding %s", async (key, value) => {
    // ALL THREE, not just the digest: `contentLength` and `contentTruncated` are
    // the row's own account of how much prose there was and whether the bound
    // fired, and a signed lie about either is read back as truth by
    // `SessionContentReader`, which echoes them from the SIGNED payload rather
    // than recomputing them.
    const { service } = buildService();

    await expect(
      service.append(
        makeEnvelope({
          type: "assistant.message",
          category: "assistant_output",
          payload: {
            sessionId: SESSION,
            runId: "run-1",
            contentType: "text/markdown",
            [key]: value,
          },
        }),
      ),
    ).rejects.toThrow(
      new RegExp(`EventLogService\\.append refuses an event whose payload already carries ${key}`),
    );
  });

  it("refuses the SEALING path too — the guard precedes the branch choice", async () => {
    // THE PLACEMENT PIN, and the only arm in this file that can fail if the
    // guard is moved. Every other arm omits `options.content` and therefore
    // takes the PLAIN branch, where a guard sitting inside that branch would be
    // indistinguishable from one sitting above it.
    //
    // Here the sealing branch is live — `options.content` present, a content key
    // source wired — so a plain-branch-only guard would let this reach the
    // codec, whose refusal-2 third arm would still refuse it, but AS
    // `writeEventWithPii`. The refuser name is what separates "refused before
    // the branch" from "refused after it", so this asserts on the name rather
    // than on the mere fact of a refusal.
    const { service } = buildService({ withContentKeySource: true });

    const refusal: unknown = await service
      .append(
        makeEnvelope({
          type: "assistant.message",
          category: "assistant_output",
          payload: {
            sessionId: SESSION,
            runId: "run-1",
            contentType: "text/markdown",
            [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "e".repeat(64),
          },
        }),
        { content: { body: "the body this caller genuinely wanted sealed" } },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // `instanceof` here and nowhere else in this describe. The other arms match
    // on message text because what they pin is the WORDING a caller reads; this
    // one pins the discriminable TYPE, which is the whole reason the class is
    // exported rather than being a bare `Error`.
    expect(refusal).toBeInstanceOf(CodecOwnedContentKeyError);
    const refused = refusal as CodecOwnedContentKeyError;
    expect(refused.message).toContain("EventLogService.append refuses");
    expect(refused.message).not.toContain("writeEventWithPii");
    expect(refused.seededKey).toBe(CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY);
    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("refuses before signing — no row, no burnt sequence", async () => {
    const { service } = buildService();

    await expect(
      service.append(
        makeEnvelope({
          type: "assistant.message",
          category: "assistant_output",
          payload: {
            sessionId: SESSION,
            runId: "run-1",
            contentType: "text/markdown",
            [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "b".repeat(64),
          },
        }),
      ),
    ).rejects.toThrow();

    expect(readRawRows(SESSION)).toHaveLength(0);
    const readmitted = await service.append(
      makeEnvelope({ type: "session.created", payload: validSessionCreatedPayload }),
    );
    expect(readmitted.sequence).toBe(0);
  });

  it("refuses a TOLERANT CARRIER pre-seeding the digest, and says so", async () => {
    // THE DECIDED ARM. `session.updated` is a census member with no registered
    // strict variant, so `ADR-018 §Decision` #5/#9's accept-and-stub tolerance
    // applies to its TYPE — and this guard does not touch types. The binding
    // verifier performs no type check whatsoever, so a forged digest here mints
    // exactly the same permanent `digest_unbound` row as one on a registered
    // type. Refusing a reserved MEMBER is not rejecting an uninterpretable
    // envelope.
    const { service } = buildService();

    await expect(
      service.append(
        makeEnvelope({
          type: "session.updated",
          payload: { note: "ad hoc", [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "c".repeat(64) },
        }),
      ),
    ).rejects.toThrow(/already carries contentCiphertextDigest/);

    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("still admits a tolerant carrier that seeds none of them (positive control)", async () => {
    // Without this the arm above could be refusing the TYPE rather than the
    // member — which is exactly the ADR-018 violation the decision avoided.
    const { service } = buildService();

    const receipt = await service.append(
      makeEnvelope({ type: "session.updated", payload: { anything: "at all", n: 7 } }),
    );

    expect(receipt.sequence).toBe(0);
    expect(readRawRows(SESSION)).toHaveLength(1);
  });

  it("leaves `contentType` alone — it is the producer's member", async () => {
    // The trio is exactly the three the codec DETERMINES. `contentType` is
    // knowable only to the producer, so a guard that swept it would refuse every
    // legitimate body-bearing append.
    const { service } = buildService();

    const receipt = await service.append(
      makeEnvelope({
        type: "assistant.message",
        category: "assistant_output",
        payload: { sessionId: SESSION, runId: "run-1", contentType: "text/markdown" },
      }),
    );

    expect(receipt.sequence).toBe(0);
  });

  it("refuses as an INTERNAL error, never as `daemon.pii_split_bypass`", async () => {
    // The registered code refuses "a write whose `payload` carries a PII-tagged
    // field with no `pii_ciphertext_digest`" and its detail schema is `.strict()`
    // on `fieldPath` alone. Borrowing it for a content-key refusal would make a
    // registered contract describe something it does not describe — so this
    // branch mints no wire code and the refusal stays internal.
    const { service } = buildService();

    const mapped = await mappedRefusalOf(
      service.append(
        makeEnvelope({
          type: "session.updated",
          payload: { note: "x", [CONTENT_TRUNCATED_PAYLOAD_KEY]: true },
        }),
      ),
    );

    expect(mapped.error.data?.type).not.toBe(DAEMON_PII_SPLIT_BYPASS_CODE);
  });

  it("keeps the PII refusal first when a payload seeds both (ordering pin)", async () => {
    // Both guards run in step (2), PII first. The order is observable and this
    // pins it: the PII refusal is the typed wire code with a `fieldPath` and a
    // remedy, and demoting it behind an internal error would degrade what a
    // caller embedding an owner stamp is told.
    const { service } = buildService();

    const mapped = await mappedRefusalOf(
      service.append(
        makeEnvelope({
          type: "session.updated",
          payload: {
            note: "x",
            [PII_PARTICIPANT_ID_PAYLOAD_KEY]: PARTICIPANT,
            [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "d".repeat(64),
          },
        }),
      ),
    );

    expect(mapped.error.data?.type).toBe(DAEMON_PII_SPLIT_BYPASS_CODE);
  });
});

describe("EventLogService — ingest-halt gate (I-006-4-03)", () => {
  it("refuses a halted session with the mapped 409-equivalent envelope", async () => {
    const { service, haltRegistry } = buildService();
    await haltRegistry.halt(SESSION);

    const mapped = await mappedRefusalOf(service.append(makeEnvelope()));

    expect(mapped.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(mapped.error.data?.type).toBe(DAEMON_INGEST_HALTED_CODE);
    expect(mapped.error.data?.fields).toEqual({ sessionId: SESSION });
  });

  it("advances no chain head and consumes no sequence on a refused append", async () => {
    const { service, haltRegistry } = buildService();
    await service.append(makeEnvelope());
    await haltRegistry.halt(SESSION);

    await expect(service.append(makeEnvelope())).rejects.toThrow();

    // No partial row, and the NEXT admitted append gets sequence 1 rather than
    // a number the refusal burned.
    expect(readRawRows(SESSION)).toHaveLength(1);
    await haltRegistry.clear(SESSION);
    const readmitted = await service.append(makeEnvelope());
    expect(readmitted.sequence).toBe(1);
    expect(walkChainLinkage(SESSION)).toBeUndefined();
  });

  it("consults the gate BEFORE canonicalization, signing and the PII codec", async () => {
    // ORDERING PROOF. This envelope would ALSO trip the split-bypass guard, and
    // the guard sits after the gate. A service that checked structure first
    // would report the wrong defect and send the caller to fix a payload whose
    // session is refusing every write regardless of its shape.
    const { service, haltRegistry, keySource, encryptor } = buildService();
    await haltRegistry.halt(SESSION);

    const mapped = await mappedRefusalOf(
      service.append(makeEnvelope({ payload: { [PII_PARTICIPANT_ID_PAYLOAD_KEY]: PARTICIPANT } })),
    );

    expect(mapped.error.data?.type).toBe(DAEMON_INGEST_HALTED_CODE);
    // No signing key was ever unsealed and no plaintext was ever encrypted.
    expect(keySource.readCallCount).toBe(0);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("completes the refuse → clear → re-admit round trip without deadlocking", async () => {
    const { service, haltRegistry } = buildService();
    await service.append(makeEnvelope());

    await haltRegistry.halt(SESSION);
    await expect(service.append(makeEnvelope())).rejects.toThrow();
    await haltRegistry.clear(SESSION);
    const readmitted = await service.append(makeEnvelope());

    expect(readmitted.sequence).toBe(1);
    expect(verifyEveryRow(SESSION)).toEqual([{ valid: true }, { valid: true }]);
  });

  it("leaves an in-flight append that already passed the gate free to commit", async () => {
    // THE INTERLEAVING ARM. The halt publishes while an append is parked in the
    // signing-key unseal — i.e. after it took the lock and after it passed the
    // gate. Admission is decided ONCE, at the gate, so the parked row commits
    // and the halt binds the NEXT append. The alternative reading (a mid-flight
    // halt should abort the in-flight row) would mean tearing down a
    // transaction whose sequence is already allocated, which is how a chain
    // acquires a hole.
    const { service, haltRegistry, keySource } = buildService();
    let releaseKeyRead!: () => void;
    keySource.gate = new Promise<void>((resolve) => {
      releaseKeyRead = resolve;
    });

    const inFlight = service.append(makeEnvelope({ payload: { leg: "in-flight" } }));
    await tick();

    // Issued from OUTSIDE the parked append's async context, so it queues rather
    // than running reentrantly.
    const halting = haltRegistry.halt(SESSION);
    // Publication SERIALIZES on the lock: while the append holds it, the halt
    // has not landed. Without this the arm would pass against a registry that
    // published immediately and merely happened to let the parked row through.
    expect(await settlesWithin(halting, 4)).toBe(false);
    expect(haltRegistry.isHalted(SESSION)).toBe(false);

    releaseKeyRead();
    keySource.gate = undefined;
    await expect(inFlight).resolves.toMatchObject({ sequence: 0 });
    await halting;

    await expect(service.append(makeEnvelope())).rejects.toThrow();
    expect(readRawRows(SESSION)).toHaveLength(1);
  });

  it("refuses to halt the daemon-scope sentinel, loudly and before acquiring anything", async () => {
    const { haltRegistry } = buildService();

    await expect(haltRegistry.halt(DAEMON_SCOPE_SENTINEL_SESSION_ID)).rejects.toThrow(/sentinel/i);
    await expect(haltRegistry.clear(DAEMON_SCOPE_SENTINEL_SESSION_ID)).rejects.toThrow(/sentinel/i);
    expect(haltRegistry.isHalted(DAEMON_SCOPE_SENTINEL_SESSION_ID)).toBe(false);
  });

  it("admits every session under the vacuous default, wired or omitted", async () => {
    // THE DORMANCY CONTROL. `NeverHaltedIngestHaltSource` stands until T4.2's
    // observer wiring replaces it, and the gate ships live NOW — so a default
    // that halted anything would take the whole daemon down before the thing
    // that decides what to halt exists.
    const vacuous = new NeverHaltedIngestHaltSource();
    expect(vacuous.isHalted(SESSION)).toBe(false);
    expect(vacuous.isHalted(DAEMON_SCOPE_SENTINEL_SESSION_ID)).toBe(false);

    // Omitting `haltSource` entirely must land on that same class rather than
    // on an undefined source the gate then has to null-check.
    const service = new EventLogService({
      db: database,
      signingKeySource: buildService().keySource,
    });
    await expect(service.append(makeEnvelope())).resolves.toMatchObject({ sequence: 0 });
  });

  it("halts one session while a sibling appends normally in the same pass", async () => {
    // The halt is SESSION-keyed. A daemon-global reading of the same state would
    // pass every arm above and still take every other session offline.
    const { service, haltRegistry } = buildService();
    await haltRegistry.halt(SESSION);

    await expect(service.append(makeEnvelope())).rejects.toThrow();
    await expect(service.append(makeEnvelope({ sessionId: OTHER_SESSION }))).resolves.toMatchObject(
      {
        sequence: 0,
      },
    );

    expect(readRawRows(SESSION)).toHaveLength(0);
    expect(readRawRows(OTHER_SESSION)).toHaveLength(1);
  });

  it("keeps the node-scope alarm path admissible while an ordinary session is halted", async () => {
    // The carve-out, from the APPEND side. `key_reuse_detected` binds to the
    // sentinel per `Spec-006 §Daemon-Scope Event Binding And Node-Scope
    // Anchoring`, and the halted set can never contain the sentinel — so the
    // alarm that CAUSES halts can never be silenced by one.
    const { service, haltRegistry } = buildService();
    await haltRegistry.halt(SESSION);

    await expect(
      service.append(
        makeEnvelope({
          sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
          category: "audit_integrity",
          type: "key_reuse_detected",
          // A payload its own registered variant accepts — two pairwise-distinct
          // observed identities, which is the condition the alarm reports. The
          // append path parses what it signs, so an ad-hoc shape would be
          // refused here before the halt carve-out could be exercised at all.
          payload: {
            offendingKeyFingerprint: "b3:2f6c1d",
            observedIdentities: [
              { sessionId: SESSION, nodeId: "node-key-reuse-observer" },
              { sessionId: OTHER_SESSION, nodeId: "node-key-reuse-observer" },
            ],
            firstSeenAt: "2026-08-30T00:00:00.000Z",
            rotationInvariantViolated: "refuse_on_rotation",
            detectorNodeId: "node-key-reuse-observer",
          },
        }),
      ),
    ).resolves.toMatchObject({ sequence: 0 });
  });

  it("does not make a halt on one session wait behind another session's parked append", async () => {
    const { service, haltRegistry, keySource } = buildService();
    let releaseKeyRead!: () => void;
    keySource.gate = new Promise<void>((resolve) => {
      releaseKeyRead = resolve;
    });

    const parked = service.append(makeEnvelope());
    await tick();

    // Publication takes the PER-SESSION lock, so a different session's halt is
    // uncontended. A single global lock here would make T4.2's sweep block on
    // whichever session happens to be mid-unseal.
    const haltingOther = haltRegistry.halt(OTHER_SESSION);
    expect(await settlesWithin(haltingOther, 4)).toBe(true);
    expect(haltRegistry.isHalted(OTHER_SESSION)).toBe(true);

    releaseKeyRead();
    keySource.gate = undefined;
    await expect(parked).resolves.toMatchObject({ sequence: 0 });
  });

  it("short-circuits a REPEAT halt before the lock, while clear() waits for it", async () => {
    // F-006-HALT-07's asymmetry, and it is only visible with the lock held by
    // something else. `halt()` decides its no-op on a membership check BEFORE
    // acquisition — T4.2 re-issues it on every sweep while a collision persists,
    // and a no-op that still paid acquisition would serialize the sweep behind
    // an append parked in a human-gated unseal for no state change. `clear()`
    // decides AFTER acquisition, because an un-halt must order against in-flight
    // appends.
    //
    // The hold is taken through `withSessionAppendLock` directly rather than
    // through `append()`: a halted session refuses at the gate, so no append can
    // be parked while its own session is already in the halted set.
    const { haltRegistry } = buildService();
    await haltRegistry.halt(SESSION);

    let releaseHold!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holding = withSessionAppendLock(SESSION, () => held);
    await tick();

    const repeated = haltRegistry.halt(SESSION);
    expect(await settlesWithin(repeated, 4)).toBe(true);

    const clearing = haltRegistry.clear(SESSION);
    expect(await settlesWithin(clearing, 4)).toBe(false);
    expect(haltRegistry.isHalted(SESSION)).toBe(true);

    releaseHold();
    await Promise.all([holding, clearing]);
    expect(haltRegistry.isHalted(SESSION)).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Serialization — the per-session append lock
// ----------------------------------------------------------------------------

describe("EventLogService — the append lock (Plan-006 §Concurrency Model)", () => {
  it("serializes concurrent appends on one session into one gapless chain", async () => {
    const { service } = buildService();

    // Without the lock these interleave in the async signing step and two of
    // them derive the same `sequence` — one losing to
    // `UNIQUE(session_id, sequence)` on a perfectly legitimate write.
    await Promise.all(
      Array.from({ length: 16 }, (_unused, index) =>
        service.append(makeEnvelope({ payload: { index } })),
      ),
    );

    const rows = readRawRows(SESSION);
    expect(rows).toHaveLength(16);
    expect(rows.map((row) => row.sequence)).toEqual(
      Array.from({ length: 16 }, (_unused, index) => index),
    );
    expect(walkChainLinkage(SESSION)).toBeUndefined();
    expect(verifyEveryRow(SESSION).every((verdict) => verdict.valid)).toBe(true);
  });

  it("reuses an existing hold rather than deadlocking on it (owner-scoped reentrancy)", async () => {
    // The producers' shape: read-decide under the lock, then append inside the
    // same hold. A non-reentrant mutex deadlocks here and the arm times out.
    const { service } = buildService();

    const receipt = await withSessionAppendLock(SESSION, async () => {
      return service.append(makeEnvelope());
    });

    expect(receipt.sequence).toBe(0);
  });

  it("does not let one session's hold block another session's append", async () => {
    const { service } = buildService();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withSessionAppendLock(SESSION, async () => {
      await parked;
    });
    await tick();

    // The lock is keyed on `sessionId`; a global mutex would make this pend.
    await expect(service.append(makeEnvelope({ sessionId: OTHER_SESSION }))).resolves.toMatchObject(
      { sequence: 0 },
    );

    release();
    await holding;
  });

  it("makes two parallel holds on one session take turns", async () => {
    // The blocking property at the LOCK's own surface rather than through
    // `append()`. Plan-004's terminal emitter wraps its guard-swap-append in
    // this helper, so "the second one waits" has to hold for an arbitrary
    // critical section, not only for the one `append()` happens to run.
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstParked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withSessionAppendLock(SESSION, async () => {
      order.push("first-enter");
      await firstParked;
      order.push("first-exit");
    });
    const second = withSessionAppendLock(SESSION, () => {
      order.push("second-enter");
      return Promise.resolve();
    });

    expect(await settlesWithin(second, 4)).toBe(false);
    expect(order).toEqual(["first-enter"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("releases the hold to a WAITER when the acquiring critical section rejects", async () => {
    // F-006-HALT-01. The lock state is a module singleton, so a hold leaked on
    // rejection wedges the session for the life of the PROCESS — and the gate
    // refusal throws from INSIDE the critical section while `clear()` acquires
    // the same hold, which means the un-halt path deadlocks against the very
    // failure that leaked it. Nothing recovers without a restart.
    //
    // The waiter queues BEFORE the failure, and that is the whole design of this
    // arm rather than an incidental ordering. A caller arriving AFTER the
    // rejection finds the queue entry already drained and proceeds even from a
    // leaked hold — so an arm that only tried a fresh caller stays green through
    // the exact wedge this invariant exists to prevent. Verified by perturbing
    // the release out of its `finally`: the fresh-caller form survived it, this
    // form does not.
    const { service } = buildService();
    let failCriticalSection!: (reason: Error) => void;
    const criticalOutcome = new Promise<void>((_resolve, reject) => {
      failCriticalSection = reject;
    });

    const rejecting = withSessionAppendLock(SESSION, () => criticalOutcome);
    const queuedBehind = service.append(makeEnvelope());
    expect(await settlesWithin(queuedBehind, 2)).toBe(false);

    failCriticalSection(new Error("producer aborted"));
    await expect(rejecting).rejects.toThrow(/producer aborted/);

    expect(await settlesWithin(queuedBehind, 4)).toBe(true);
    await expect(queuedBehind).resolves.toMatchObject({ sequence: 0 });
  });

  it("releases nothing when a REENTRANT frame rejects and its owner catches it", async () => {
    // The other half of F-006-HALT-01, and the one a naive `finally` gets wrong:
    // only the ACQUIRING frame settles the physical hold. An owner that catches
    // an inner rejection and carries on is still the owner — if the inner
    // rejection had released, the outer frame would be holding a lock it no
    // longer owns, its next nested call would queue behind itself, and the
    // release would fire twice.
    const { service } = buildService();
    let innerRejectionCaught = false;
    let nestedCallProgressed = false;

    const receipt = await withSessionAppendLock(SESSION, async () => {
      try {
        await withSessionAppendLock(SESSION, () => Promise.reject(new Error("inner leg failed")));
      } catch {
        innerRejectionCaught = true;
      }
      const nested = service.append(makeEnvelope());
      nestedCallProgressed = await settlesWithin(nested, 4);
      // ABANDON the nested call rather than awaiting it when it did not get the
      // hold: an over-releasing reentrant frame leaves this append queued behind
      // its own owner, and awaiting it here would hang the owner too — turning a
      // named assertion failure into a suite-wide timeout that says nothing.
      return nestedCallProgressed ? await nested : undefined;
    });

    expect(innerRejectionCaught).toBe(true);
    expect(nestedCallProgressed).toBe(true);
    expect(receipt?.sequence).toBe(0);

    // Released exactly once, on the OWNER's settle — a fresh acquisition now
    // proceeds rather than queueing behind a hold nobody holds.
    const afterOwnerSettled = withSessionAppendLock(SESSION, () => Promise.resolve("free"));
    expect(await settlesWithin(afterOwnerSettled, 4)).toBe(true);
  });

  it("commits a transactionalPrelude atomically with the row, prelude first", async () => {
    const { service } = buildService();
    database.exec("CREATE TABLE prelude_probe (id TEXT PRIMARY KEY, seen_events INTEGER NOT NULL)");

    await service.append(makeEnvelope(), {
      transactionalPrelude: () => {
        // Reading the event count INSIDE the prelude is what proves the ordering:
        // the row this append is writing is not visible yet, so the prelude ran
        // before the INSERT.
        const { count } = database
          .prepare("SELECT COUNT(*) AS count FROM session_events")
          .get() as {
          count: number;
        };
        database.prepare("INSERT INTO prelude_probe VALUES (?, ?)").run("probe", count);
      },
    });

    const probe = database
      .prepare("SELECT seen_events FROM prelude_probe WHERE id = ?")
      .get("probe") as { seen_events: number };
    expect(probe.seen_events).toBe(0);
    expect(readRawRows(SESSION)).toHaveLength(1);
  });

  it("rolls the whole transaction back when the prelude throws, consuming no sequence", async () => {
    const { service } = buildService();
    database.exec("CREATE TABLE prelude_probe (id TEXT PRIMARY KEY, seen_events INTEGER NOT NULL)");
    await service.append(makeEnvelope());

    await expect(
      service.append(makeEnvelope(), {
        transactionalPrelude: () => {
          database.prepare("INSERT INTO prelude_probe VALUES (?, ?)").run("doomed", 1);
          throw new Error("producer detected divergent decision-time state");
        },
      }),
    ).rejects.toThrow(/divergent/);

    // Neither half landed, and the sequence the doomed append allocated is
    // re-derived by the next one from the durable chain head.
    expect(database.prepare("SELECT COUNT(*) AS c FROM prelude_probe").get()).toEqual({ c: 0 });
    expect(readRawRows(SESSION)).toHaveLength(1);
    await expect(service.append(makeEnvelope())).resolves.toMatchObject({ sequence: 1 });
  });
});

// ----------------------------------------------------------------------------
// The run_lifecycle terminal-key backstop — migration 0006, seen from `append()`
// ----------------------------------------------------------------------------

function terminalEnvelope(payload: Record<string, unknown>): UnsequencedEventEnvelope {
  return makeEnvelope({ category: "run_lifecycle", type: "run.completed", payload });
}

describe("EventLogService — terminal-key backstop (Spec-006 §Run Lifecycle (run_lifecycle))", () => {
  it("admits the first terminal event for a run and refuses the second", async () => {
    const { service } = buildService();

    await service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }));

    await expect(
      service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 })),
    ).rejects.toThrow(/UNIQUE/i);

    // Fail-LOUD, and the refusal costs no sequence: the INSERT aborts inside the
    // transaction, so the chain head never moved.
    expect(readRawRows(SESSION)).toHaveLength(1);
    await expect(service.append(makeEnvelope())).resolves.toMatchObject({ sequence: 1 });
  });

  it("admits a second terminal for the same run at a DIFFERENT runVersion", async () => {
    // The key is the PAIR. A re-run is a new `runVersion` and gets its own
    // terminal event; collapsing the key to `runId` alone would refuse it.
    const { service } = buildService();

    await service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }));
    await expect(
      service.append(terminalEnvelope({ runId: "run-1", runVersion: 2 })),
    ).resolves.toMatchObject({ sequence: 1 });
  });

  it("lets a NON-terminal run_lifecycle duplicate through — the index is terminal-scoped", async () => {
    // The scope half. `run_lifecycle` carries 13 types and only three of them
    // are terminal; an index that guarded the whole category would refuse the
    // ordinary progression events a run emits many of.
    const { service } = buildService();
    const runKey = { runId: "run-1", runVersion: 1 };

    await service.append(
      makeEnvelope({ category: "run_lifecycle", type: "run.running", payload: runKey }),
    );
    await expect(
      service.append(
        makeEnvelope({ category: "run_lifecycle", type: "run.running", payload: runKey }),
      ),
    ).resolves.toMatchObject({ sequence: 1 });
  });

  it("refuses a terminal event whose run key is missing or the wrong storage class", async () => {
    // SQLite treats NULLs as DISTINCT in a UNIQUE index, so a terminal row with
    // no `$.runId` conflicts with nothing — including another terminal row for
    // the same run. And `json_extract` returns SQLite values, so a stringified
    // `runVersion` is a DIFFERENT index key from the integer one. The trigger
    // closes both, which is what makes uniqueness a property of the RUN rather
    // than of its JSON spelling.
    const { service } = buildService();
    const refusedPayloads: ReadonlyArray<Record<string, unknown>> = [
      { runVersion: 1 },
      { runId: "run-1" },
      { runId: 7, runVersion: 1 },
      { runId: "run-1", runVersion: "1" },
      { runId: "run-1", runVersion: 1.5 },
      { runId: null, runVersion: 1 },
    ];

    for (const payload of refusedPayloads) {
      await expect(
        service.append(terminalEnvelope(payload)),
        `payload ${JSON.stringify(payload)} must be refused`,
      ).rejects.toThrow(/terminal run_lifecycle requires/);
    }

    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("refuses an UPDATE that promotes a committed non-terminal row into a terminal one", async () => {
    // The PROMOTE leg, and the one the INSERT trigger cannot see: a row that was
    // never in the partial index's predicate is UPDATEd into it, which is an
    // insert through the back door. Terminal rows are INSERT-only.
    const { service } = buildService();
    const receipt = await service.append(
      makeEnvelope({
        category: "run_lifecycle",
        type: "run.running",
        payload: { runId: "run-1", runVersion: 1 },
      }),
    );

    expect(() =>
      database
        .prepare("UPDATE session_events SET category = ?, type = ? WHERE id = ?")
        .run("run_lifecycle", "run.completed", receipt.id),
    ).toThrow(/cannot be promoted to terminal/);
  });

  it("refuses an UPDATE that moves a committed terminal row's run identity", async () => {
    const { service } = buildService();
    const receipt = await service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }));

    // The index constrains the SET of live keys, not their STABILITY: rewriting
    // the key moves it rather than duplicating it, so the index stays satisfied
    // while the durable record now attributes the terminal event to another run.
    // BOTH halves of the pair are pinned — the guard reads `runId` and
    // `runVersion` through independent `IS NOT` comparisons, so an arm that
    // moved only one of them would leave the other's comparison unverified.
    expect(() =>
      database
        .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
        .run(JSON.stringify({ runId: "run-2", runVersion: 1 }), receipt.id),
    ).toThrow(/must preserve runId/);
    expect(() =>
      database
        .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
        .run(JSON.stringify({ runId: "run-1", runVersion: 2 }), receipt.id),
    ).toThrow(/must preserve runId/);

    // De-scoping out of the partial index's predicate is the same defect by
    // another route — it would free the key for reuse. `category` and `type` are
    // independent DISJUNCTS in the guard, so each needs its own leg: with only
    // the `category` half asserted, deleting the `type` disjunct from the
    // trigger leaves this suite green.
    expect(() =>
      database
        .prepare("UPDATE session_events SET category = ? WHERE id = ?")
        .run("session_lifecycle", receipt.id),
    ).toThrow(/must preserve runId/);
    expect(() =>
      database
        .prepare("UPDATE session_events SET type = ? WHERE id = ?")
        .run("run.running", receipt.id),
    ).toThrow(/must preserve runId/);
  });

  it("refuses an UPDATE that DROPS a committed terminal row's run key", async () => {
    // THE STUB-PRESERVATION NEGATIVE CONTROL, and a different predicate from the
    // identity-move above: dropping the key makes both `json_extract`s NULL,
    // which the value-equality check cannot see and the NULL-distinct index
    // welcomes. This is the shape a compactor bug actually takes — a projection
    // that rebuilds `payload` from a key list and forgets to carry the run key
    // forward re-opens the duplicate-terminal bypass for the row's whole
    // retention life, silently. T3.2's projection is what keeps it closed; this
    // arm is what fails if it stops.
    const { service } = buildService();
    const receipt = await service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }));

    for (const droppedPayload of [
      { runVersion: 1 },
      { runId: "run-1" },
      { summary: "compacted" },
    ]) {
      expect(
        () =>
          database
            .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
            .run(JSON.stringify(droppedPayload), receipt.id),
        `payload ${JSON.stringify(droppedPayload)} must be refused`,
      ).toThrow(/must preserve runId/);
    }

    // The row is untouched, so the backstop still holds against a real duplicate.
    await expect(
      service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 })),
    ).rejects.toThrow(/UNIQUE/i);
  });
});

// ----------------------------------------------------------------------------
// `event.shredded` — the emission-seam parse and the post-shred callback
// ----------------------------------------------------------------------------

function shreddedEnvelope(overrides?: Record<string, unknown>): UnsequencedEventEnvelope {
  return makeEnvelope({
    category: "event_maintenance",
    type: "event.shredded",
    payload: {
      nodeId: "node-shred-0001",
      operationId: "op-shred-1",
      occurredAt: "2026-08-04T12:00:00.000Z",
      participantId: PARTICIPANT,
      affectedSessionIds: [SESSION],
      piiPayloadsCleared: 3,
      shredReason: "gdpr_article_17",
      ...overrides,
    },
  });
}

describe("EventLogService — event.shredded emission seam (Plan-022 Path 1)", () => {
  it("hands the callback the PARSED payload and the receipt, after the row is durable", async () => {
    const { service } = buildService();
    const observed: Array<{ readonly rowsVisible: number; readonly receiptSequence: number }> = [];

    service.registerShredCallback((shredded, receipt) => {
      // The parsed value, not the caller's object.
      expect(shredded.shredReason).toBe("gdpr_article_17");
      expect(shredded.piiPayloadsCleared).toBe(3);
      observed.push({
        rowsVisible: readRawRows(SESSION).length,
        receiptSequence: receipt.sequence,
      });
      return Promise.resolve();
    });

    await service.append(shreddedEnvelope());

    expect(observed).toEqual([{ rowsVisible: 1, receiptSequence: 0 }]);
  });

  it("still holds the session's append lock while the callback runs", async () => {
    // "Post-commit UNDER THE LOCK" is what lets a handler observe the shred row
    // and everything before it, and nothing appended after. Observed by racing a
    // second append against a macrotask boundary from OUTSIDE the callback's
    // async context: had the lock been released, it would land.
    const { service } = buildService();
    let releaseCallback!: () => void;
    const callbackParked = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    let secondAppendLanded = false;

    service.registerShredCallback(async () => {
      await callbackParked;
    });

    const shredding = service.append(shreddedEnvelope());
    await tick();

    const second = service.append(makeEnvelope()).then((receipt) => {
      secondAppendLanded = true;
      return receipt;
    });
    await tick();
    expect(secondAppendLanded).toBe(false);

    releaseCallback();
    await shredding;
    await expect(second).resolves.toMatchObject({ sequence: 1 });
  });

  it("refuses a malformed shred payload before the write and never calls the callback", async () => {
    const { service } = buildService();
    let callbackCalls = 0;
    service.registerShredCallback(() => {
      callbackCalls += 1;
      return Promise.resolve();
    });

    await expect(
      service.append(shreddedEnvelope({ shredReason: "because-we-felt-like-it" })),
    ).rejects.toThrow();

    expect(readRawRows(SESSION)).toHaveLength(0);
    expect(callbackCalls).toBe(0);
  });

  it("replaces a previously registered callback rather than fanning out", async () => {
    const { service } = buildService();
    const called: string[] = [];
    service.registerShredCallback(() => {
      called.push("first");
      return Promise.resolve();
    });
    service.registerShredCallback(() => {
      called.push("second");
      return Promise.resolve();
    });

    await service.append(shreddedEnvelope());

    expect(called).toEqual(["second"]);
  });

  it("never invokes the callback for a non-shred append", async () => {
    const { service } = buildService();
    let callbackCalls = 0;
    service.registerShredCallback(() => {
      callbackCalls += 1;
      return Promise.resolve();
    });

    await service.append(makeEnvelope());

    expect(callbackCalls).toBe(0);
  });
});
