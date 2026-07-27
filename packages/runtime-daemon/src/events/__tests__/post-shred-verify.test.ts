// Post-shred signature-verification property suite (Plan-006 T2.5).
//
// THE LOAD-BEARING SAFETY PROOF FOR THE ENTIRE PII DESIGN. Everything else in
// Phase 2 builds the machinery; this file is the only artifact that
// empirically demonstrates the claim the machinery exists to support —
// `Spec-022 §Signature Safety Under Shred`: a `daemon_signature` taken over
// canonical bytes that carry `pii_ciphertext_digest` (and never the ciphertext
// itself) SURVIVES a Plan-022 Path-1 crypto-shred. Delete the participant's
// content key, clear `session_events.pii_payload`, and the row is still
// verifiable while the PII is irrecoverable. If that is not true, the audit log
// and the right-to-erasure obligation are in direct conflict and one of them
// has to be given up.
//
// THREE LEGS, AND THE THIRD IS A NEGATIVE CONTROL THAT IS NOT OPTIONAL.
//
//   1. `writeEventWithPii` produces canonical bytes that INCLUDE
//      `pii_ciphertext_digest` and exclude every trace of the plaintext and of
//      the ciphertext (`Spec-006 §Canonical Serialization Rules`, I-006-2-05).
//   2. After `pii_payload` is set to NULL — the shred — the `daemon_signature`
//      STILL verifies against bytes re-canonicalized from the surviving row.
//   3. Tampering ANY canonical envelope field post-shred makes verification
//      FAIL.
//
// LEG 3 IS WHAT KEEPS LEG 2 HONEST — DO NOT "SIMPLIFY" IT AWAY. Legs 1 and 2
// are both satisfied by a verifier that returns `valid: true` unconditionally,
// so on their own they prove nothing about the shred: a suite holding only
// those two legs would go green against a broken verifier. Leg 3 is the
// control that makes leg 2's `valid: true` mean something, and it is
// deliberately exhaustive over the canonical eleven rather than a single
// representative field, because a verifier that reads ten of eleven members
// passes any smaller matrix.
//
// THE VERIFIED ENVELOPE IS REHYDRATED FROM THE STORED COLUMNS, NEVER REUSED
// FROM THE WRITE. `verifyRow` is never handed `pii_payload` — it takes
// canonical bytes, three integrity columns and a public key — so "shred it
// in memory and verification still passes" is a tautology about a parameter
// that does not exist. What makes leg 2 a real claim is the round trip: the
// row is persisted, the ciphertext column is nulled by SQL, and the bytes fed
// to `verifyRow` are rebuilt from what SURVIVED. That is also why this suite
// runs against a real in-memory SQLite database on the shipped migrations
// rather than against object literals — the `CHECK(length(prev_hash) = 32)` /
// `CHECK(length(daemon_signature) = 64)` clauses in `0001-initial.ts` then
// vouch for the widths on the way in, and the BLOB round trip is the one that
// actually happens in production.
//
// THE INSERT BELOW IS A TEST FIXTURE, NOT AN APPEND PATH. Step 7 of
// `Plan-006 §Encrypt-Then-Digest-Then-Sign Order` — persisting the row under
// the per-session append lock — belongs to T3.1's `EventLogService.append`,
// which does not exist yet. `insertSignedPiiRow` stands in for it for exactly
// as long as that is true, and claims none of its concurrency properties.
//
// THE STUB ENCRYPTOR IS THIS TASK'S, BY ASSIGNMENT. CP-006-1 puts the real
// AES-256-GCM codec in Plan-022 (Tier 5) and says the composition root must
// inject it and must assert against the stub outside tests;
// `pii-indirection.ts`'s header assigns the test-only stub to T2.5. It lives
// here and is exported from nothing.
//
// Refs: `Spec-022 §Signature Safety Under Shred`,
// `Spec-022 §PII Payload Column Pattern`, `Spec-022 §Ordering And Atomicity`,
// `Spec-006 §Canonical Serialization Rules`, `Spec-006 §Integrity Protocol`,
// `Plan-006 §Encrypt-Then-Digest-Then-Sign Order`, `Plan-006 §Hash Chain`,
// `Plan-006 §Audit Integrity Invariant`,
// `Security Architecture §Verification Rules`.
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import {
  EventEnvelopeSchema,
  EventEnvelopeVersionSchema,
  SessionIdSchema,
} from "@ai-sidekicks/contracts";
import type { EventEnvelope, EventEnvelopeVersion, SessionId } from "@ai-sidekicks/contracts";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../session/migration-runner.js";
import { canonicalizeEvent, canonicalizeJson } from "../canonicalizer.js";
import type { CanonicalBytes } from "../canonicalizer.js";
import { PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY, writeEventWithPii } from "../pii-indirection.js";
import type {
  EventWithPiiDigest,
  PiiCarryingEventInput,
  PiiEncryptionRequest,
  PiiEncryptor,
  PiiEventWriteResult,
  PiiPayloadCiphertext,
} from "../pii-indirection.js";
import { GENESIS_PREV_HASH, verifyRow } from "../signer.js";
import type { Ed25519PrivateKey, Ed25519PublicKey, RowVerification, SignedRow } from "../signer.js";

// --------------------------------------------------------------------------
// Helpers.
// --------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * `prev_hash || canonical_bytes(row)` — the BLAKE3 preimage
 * `Plan-006 §Hash Chain` specifies, written out HERE rather than imported.
 * `signer.ts`'s `buildChainInput` is module-private, and re-using it would make
 * the forged-`row_hash` case below circular: the point of that case is that an
 * attacker who can recompute the chain digest independently still cannot
 * produce a signature, so the recomputation must be independent.
 */
function concatenateChainInput(prevHash: Uint8Array, canonical: Uint8Array): Uint8Array {
  const chainInput = new Uint8Array(prevHash.length + canonical.length);
  chainInput.set(prevHash, 0);
  chainInput.set(canonical, prevHash.length);
  return chainInput;
}

// --------------------------------------------------------------------------
// Key material — RFC 8032 §7.1 TEST 1.
// --------------------------------------------------------------------------
//
// The brand casts here are the one thing this suite does that production code
// may not, for the same reason `signer.golden.test.ts` documents:
// `Ed25519PrivateKey` exports no constructor precisely so key material enters
// the type system at exactly one greppable site (T2.7's
// `signing-key-source.ts`), and a test standing in for that custody module has
// to narrow the way T2.7 does. `CanonicalBytes` is NEVER cast here — every
// canonical value comes from `canonicalizeEvent` / `canonicalizeJson`, the way
// production callers must obtain it. Routing through the real
// `OsKeystoreSealedDaemonSigningKeySource` instead was considered and rejected:
// it would add a T2.7 dependency to a task the plan scopes to T2.4, and T2.7's
// own suite already covers custody.

const RFC_8032_TEST_1_SECRET_KEY_HEX =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_8032_TEST_2_SECRET_KEY_HEX =
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

const DAEMON_SIGNING_KEY: Ed25519PrivateKey = hexToBytes(
  RFC_8032_TEST_1_SECRET_KEY_HEX,
) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY: Ed25519PublicKey = ed25519.getPublicKey(
  DAEMON_SIGNING_KEY,
) as Ed25519PublicKey;

/** A second, unrelated daemon identity — the wrong-signer control. */
const OTHER_DAEMON_PUBLIC_KEY: Ed25519PublicKey = ed25519.getPublicKey(
  hexToBytes(RFC_8032_TEST_2_SECRET_KEY_HEX) as Ed25519PrivateKey,
) as Ed25519PublicKey;

// --------------------------------------------------------------------------
// CP-006-1 — the test-only PII encryptor stub.
// --------------------------------------------------------------------------

/**
 * A 12-byte pseudo-nonce prefix, so the stub's output carries the
 * `iv || ciphertext || tag` SHAPE `Spec-022 §PII Payload Column Pattern` fixes
 * for the real codec even though it has none of its properties.
 */
const TEST_NONCE_PREFIX: Uint8Array = utf8Encoder.encode("test-nonce--");

/**
 * The test-only stub `pii-indirection.ts`'s CP-006-1 note assigns to this task.
 *
 * NOT AN AEAD, AND THE DIVERGENCES ARE DELIBERATE. It is an XOR over a BLAKE3
 * keystream keyed by `participantId || eventId`: no confidentiality, no
 * integrity tag, and — the one that matters for a test — DETERMINISTIC, where
 * the real AES-256-GCM codec draws a fresh random 96-bit nonce per write and is
 * therefore `manual_reconcile_only` rather than idempotent. Determinism is
 * bought on purpose: it makes every digest in this file reproducible from the
 * fixture, so an assertion can name the expected bytes instead of re-deriving
 * them from whatever the encryptor happened to return. Nothing under test
 * depends on the cipher being real — `writeEventWithPii` digests whatever bytes
 * it is handed and asserts nothing about their width, exactly as CP-006-1
 * requires of an interface that does not fix an AEAD.
 *
 * The `participantId || eventId` seeding mirrors the real codec's AAD binding
 * in the one observable way a stub can: a ciphertext produced for one
 * (participant, event) pair differs bytewise from every other pair's, so a
 * replayed ciphertext produces a different digest and a different signature.
 *
 * Call accounting is public because it carries an ORDERING proof: the guards
 * `writeEventWithPii` runs BEFORE the irreversible encrypt step are exactly the
 * ones for which `encryptCallCount` must still be 0 after the throw.
 */
class DeterministicTestPiiEncryptor implements PiiEncryptor {
  #encryptCallCount = 0;
  #lastRequest: PiiEncryptionRequest | null = null;

  get encryptCallCount(): number {
    return this.#encryptCallCount;
  }

  get lastRequest(): PiiEncryptionRequest | null {
    return this.#lastRequest;
  }

  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array> {
    this.#encryptCallCount += 1;
    this.#lastRequest = request;
    return Promise.resolve(sealWithTestKeystream(request));
  }
}

function sealWithTestKeystream(request: PiiEncryptionRequest): Uint8Array {
  const associatedData: Uint8Array = utf8Encoder.encode(
    `${request.participantId} ${request.eventId}`,
  );
  const keystream: Uint8Array = blake3(associatedData, {
    dkLen: Math.max(1, request.plaintext.length),
  });
  const sealed = new Uint8Array(TEST_NONCE_PREFIX.length + request.plaintext.length);
  sealed.set(TEST_NONCE_PREFIX, 0);
  for (let index = 0; index < request.plaintext.length; index++) {
    sealed[TEST_NONCE_PREFIX.length + index] =
      (request.plaintext[index] ?? 0) ^ (keystream[index] ?? 0);
  }
  return sealed;
}

/** A stub that returns whatever the test tells it to — the CP-006-1 bad-injection driver. */
class FixedResultPiiEncryptor implements PiiEncryptor {
  #encryptCallCount = 0;
  readonly #result: unknown;

  constructor(result: unknown) {
    this.#result = result;
  }

  get encryptCallCount(): number {
    return this.#encryptCallCount;
  }

  encrypt(_request: PiiEncryptionRequest): Promise<Uint8Array> {
    this.#encryptCallCount += 1;
    // The whole point is to return a value the declared type forbids — that is
    // the CP-006-1 injection bug `writeEventWithPii`'s result guard exists for,
    // and it is reachable in production because the implementation crosses an
    // injection boundary this package neither owns nor imports.
    return Promise.resolve(this.#result as Uint8Array);
  }
}

// --------------------------------------------------------------------------
// Fixtures.
// --------------------------------------------------------------------------

const FIXTURE_SESSION_ID: SessionId = SessionIdSchema.parse("0192f3a4-5b6c-7d8e-9f01-234567890abc");
const FIXTURE_ENVELOPE_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");
const FIXTURE_EVENT_ID = "01960b3c-e1d0-7a41-b2c9-5f8e37d6a204";
const FIXTURE_PARTICIPANT_ID = "participant-3f9a";
const FIXTURE_OCCURRED_AT = "2026-03-04T05:06:07.008Z";
const FIXTURE_MONOTONIC_NS = 1_752_000_000_000_000_000n;

/**
 * A string that appears NOWHERE except inside the PII partition.
 *
 * It is the leak detector: every canonical-bytes assertion in leg 1 checks that
 * neither this value nor the member name carrying it survives into the signed
 * bytes. A single-token regression in `embedCiphertextDigest` — spreading
 * `input` instead of `input.payload` — puts the whole partition inside
 * `payload`, which IS canonical, and this sentinel is what catches it.
 */
const PII_PLAINTEXT_SENTINEL = "sentinel-plaintext-do-not-sign-b7f2c1";
const PII_PLAINTEXT_SENTINEL_KEY = "nationalIdentityNumber";

/**
 * ONE factory for every envelope this suite builds.
 *
 * `EventEnvelope` is contracts-owned and its member set is exactly eleven
 * (I-006-1-03). A twelfth member would break this literal and the rehydrator
 * below, and nothing else in the file — which is why both exist rather than
 * inline object literals per test.
 *
 * `participant_lifecycle` / `participant.exported` is the census pairing whose
 * payload legitimately carries participant PII, so the fixture is a realistic
 * caller rather than an arbitrary category that merely clears the
 * I-006-2-07 refusal.
 */
function buildPiiCarryingEventInput(
  overrides: Partial<PiiCarryingEventInput> = {},
): PiiCarryingEventInput {
  return {
    id: FIXTURE_EVENT_ID,
    sessionId: FIXTURE_SESSION_ID,
    sequence: 0,
    occurredAt: FIXTURE_OCCURRED_AT,
    category: "participant_lifecycle",
    type: "participant.exported",
    actor: FIXTURE_PARTICIPANT_ID,
    payload: { exportFormat: "json", recordCount: 3 },
    correlationId: "correlation-9c2e",
    causationId: "causation-4b1d",
    version: FIXTURE_ENVELOPE_VERSION,
    piiParticipantId: FIXTURE_PARTICIPANT_ID,
    piiPayload: {
      displayName: "Ada Lovelace",
      emailAddress: "ada@example.invalid",
      [PII_PLAINTEXT_SENTINEL_KEY]: PII_PLAINTEXT_SENTINEL,
    },
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Storage fixture — stands in for T3.1's step 7 (see the header).
// --------------------------------------------------------------------------

interface StoredSessionEventRow {
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
}

function insertSignedPiiRow(database: DatabaseType, result: PiiEventWriteResult): void {
  const { envelope, piiPayload, signedRow } = result;
  database
    .prepare(
      `INSERT INTO session_events (
         id, session_id, sequence, occurred_at, monotonic_ns,
         category, type, actor, payload, pii_payload,
         correlation_id, causation_id, version,
         prev_hash, row_hash, daemon_signature, participant_signature
       ) VALUES (
         @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
         @category, @type, @actor, @payload, @pii_payload,
         @correlation_id, @causation_id, @version,
         @prev_hash, @row_hash, @daemon_signature, NULL
       )`,
    )
    .run({
      id: envelope.id,
      session_id: envelope.sessionId,
      sequence: envelope.sequence,
      // The NORMALIZED string off the returned envelope, never the producer's
      // raw input — the caller obligation `PiiEventWriteResult` documents.
      occurred_at: envelope.occurredAt,
      monotonic_ns: FIXTURE_MONOTONIC_NS,
      category: envelope.category,
      type: envelope.type,
      actor: envelope.actor ?? null,
      payload: JSON.stringify(envelope.payload),
      pii_payload: Buffer.from(piiPayload),
      correlation_id: envelope.correlationId ?? null,
      causation_id: envelope.causationId ?? null,
      version: envelope.version,
      prev_hash: Buffer.from(signedRow.prevHash),
      row_hash: Buffer.from(signedRow.rowHash),
      daemon_signature: Buffer.from(signedRow.daemonSignature),
    });
}

/**
 * Reads back THE row (each test's database holds exactly one), deliberately
 * without a WHERE clause: the tamper matrix below rewrites `id`, `session_id`
 * and `sequence`, so any lookup key would be tampered out from under the read.
 */
function readStoredRow(database: DatabaseType): StoredSessionEventRow {
  const rows = database
    .prepare(
      `SELECT id, session_id, sequence, occurred_at, category, type, actor, payload,
              pii_payload, correlation_id, causation_id, version,
              prev_hash, row_hash, daemon_signature
         FROM session_events`,
    )
    .all() as ReadonlyArray<StoredSessionEventRow>;
  expect(rows).toHaveLength(1);
  const row: StoredSessionEventRow | undefined = rows[0];
  if (row === undefined) throw new Error("unreachable: the length was just asserted");
  return row;
}

/**
 * The independent verifier's read path: stored columns → `EventEnvelope`.
 *
 * PARSED, NOT CAST. Going through `EventEnvelopeSchema` is what a real verifier
 * does with a row it did not write, and it keeps `SessionId` /
 * `EventEnvelopeVersion` out of unchecked-cast territory — the casts would be
 * exactly where a rehydration bug could hide.
 *
 * TWO COLUMN GROUPS ARE TWO-STATE IN STORAGE AND MAP DIFFERENTLY, WHICH IS THE
 * SUBTLEST THING IN THIS FILE. `actor` is the canonical set's only NULLABLE
 * member: SQL NULL means present-and-null and must stay `null`, because
 * `canonicalizeEvent` emits `"actor":null` for it and DROPS the key for
 * `undefined` — two different byte strings. `correlationId` / `causationId` are
 * OPTIONAL and not nullable, so their SQL NULL means absent and must become
 * `undefined`. Map either group the other way and the happy path fails with
 * `hash_mismatch` on a row nobody tampered with — at which point the tempting
 * "fix" is to verify against the write-time envelope instead, which would make
 * leg 2 vacuous. Both directions are pinned by dedicated tests below rather
 * than left to this comment.
 */
function rehydrateEnvelope(row: StoredSessionEventRow): EventEnvelope {
  return EventEnvelopeSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    category: row.category,
    type: row.type,
    actor: row.actor,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    correlationId: row.correlation_id ?? undefined,
    causationId: row.causation_id ?? undefined,
    version: row.version,
  });
}

function toSignedRow(row: StoredSessionEventRow): SignedRow {
  return {
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
    daemonSignature: row.daemon_signature,
  };
}

/** The full read-side round trip: stored row → envelope → canonical bytes → verdict. */
function verifyStoredRow(
  database: DatabaseType,
  daemonPublicKey: Ed25519PublicKey = DAEMON_PUBLIC_KEY,
): RowVerification {
  const row: StoredSessionEventRow = readStoredRow(database);
  const canonical: CanonicalBytes = canonicalizeEvent(rehydrateEnvelope(row));
  return verifyRow(canonical, toSignedRow(row), daemonPublicKey);
}

/**
 * PLAN-022 PATH-1 CRYPTO-SHRED, the half this package can perform.
 *
 * The full operation is two writes: DELETE the participant's row from
 * `participant_keys` (the content key — Plan-022 owns that table and that
 * step, and without the key the ciphertext is unrecoverable even from a
 * backup) and clear `pii_payload`. Only the second touches a Plan-006 column,
 * so only the second is modelled here; the first has no effect on any input
 * `verifyRow` reads, which is precisely the property under test.
 */
function shredPiiPayload(database: DatabaseType): void {
  const result = database.prepare("UPDATE session_events SET pii_payload = NULL").run();
  expect(result.changes).toBe(1);
}

// ==========================================================================
// LEG 1 — the signed bytes commit to the DIGEST, never to the ciphertext or
// the plaintext (I-006-2-05, `Spec-006 §Canonical Serialization Rules`).
// ==========================================================================

describe("Plan-006 T2.5 leg 1 — canonical bytes carry pii_ciphertext_digest and nothing PII", () => {
  let encryptor: DeterministicTestPiiEncryptor;

  beforeEach(() => {
    encryptor = new DeterministicTestPiiEncryptor();
  });

  it("embeds BLAKE3(ciphertext) as a lowercase-hex payload member", async () => {
    const input: PiiCarryingEventInput = buildPiiCarryingEventInput();
    const result: PiiEventWriteResult = await writeEventWithPii(
      input,
      GENESIS_PREV_HASH,
      encryptor,
      DAEMON_SIGNING_KEY,
    );

    // Recomputed here from the ciphertext the codec RETURNED, so the assertion
    // cannot be satisfied by a digest over anything else.
    const expectedDigest: string = bytesToHex(blake3(result.piiPayload));
    expect(result.envelope.payload[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe(expectedDigest);
    expect(expectedDigest).toMatch(/^[0-9a-f]{64}$/);

    // The digest is over the CIPHERTEXT, not the plaintext. Both are byte
    // strings of the same provenance, so nothing but this assertion
    // distinguishes a correct implementation from one that digests the input.
    const plaintextDigest: string = bytesToHex(blake3(canonicalizeJson(input.piiPayload)));
    expect(expectedDigest).not.toBe(plaintextDigest);

    const canonicalText: string = utf8Decoder.decode(canonicalizeEvent(result.envelope));
    expect(canonicalText).toContain(`"${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}":"${expectedDigest}"`);
  });

  it("leaks neither the PII plaintext nor the ciphertext into the signed bytes", async () => {
    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput(),
      GENESIS_PREV_HASH,
      encryptor,
      DAEMON_SIGNING_KEY,
    );
    const canonicalText: string = utf8Decoder.decode(canonicalizeEvent(result.envelope));

    // The signed bytes are the ONE place PII must never appear: a shred clears
    // `pii_payload`, but canonical bytes are reproduced from surviving columns
    // forever, so anything that lands here outlives the erasure.
    expect(canonicalText).not.toContain(PII_PLAINTEXT_SENTINEL);
    expect(canonicalText).not.toContain(PII_PLAINTEXT_SENTINEL_KEY);
    expect(canonicalText).not.toContain("Ada Lovelace");
    expect(canonicalText).not.toContain("ada@example.invalid");
    // Nor the ciphertext, in the encoding it would most plausibly take.
    // Ciphertext in the signed bytes would survive the shred and hand an
    // attacker a length-and-structure oracle over the erased data.
    expect(canonicalText).not.toContain(bytesToHex(result.piiPayload));
    expect(canonicalText).not.toContain("piiPayload");
    expect(canonicalText).not.toContain("piiParticipantId");
    expect(canonicalText).not.toContain("pii_payload");

    // The non-PII payload partition IS signed — without this the assertions
    // above could pass on an empty payload.
    expect(canonicalText).toContain('"exportFormat":"json"');
  });

  it("binds the ciphertext to (participant, event) and canonicalizes the partition once", async () => {
    const input: PiiCarryingEventInput = buildPiiCarryingEventInput();
    await writeEventWithPii(input, GENESIS_PREV_HASH, encryptor, DAEMON_SIGNING_KEY);

    // I-006-2-06's sibling property on the encrypt side: exactly one encrypt
    // per row, so the digest cannot describe a ciphertext other than the one
    // heading for the column.
    expect(encryptor.encryptCallCount).toBe(1);
    expect(encryptor.lastRequest?.participantId).toBe(FIXTURE_PARTICIPANT_ID);
    expect(encryptor.lastRequest?.eventId).toBe(FIXTURE_EVENT_ID);
    // The plaintext handed to the AEAD is the RFC 8785 serialization of the
    // partition, which is the convention `PiiEncryptionRequest.plaintext` fixes
    // for the eventual decrypt counterpart.
    expect(encryptor.lastRequest?.plaintext).toEqual(canonicalizeJson(input.piiPayload));
  });
});

// ==========================================================================
// LEG 2 — the signature survives the shred (`Spec-022 §Signature Safety Under
// Shred`, I-006-2-05).
// ==========================================================================

describe("Plan-006 T2.5 leg 2 — daemon_signature still verifies after pii_payload is NULLed", () => {
  let database: DatabaseType;
  let writeResult: PiiEventWriteResult;

  beforeEach(async () => {
    database = openDatabase(":memory:");
    writeResult = await writeEventWithPii(
      buildPiiCarryingEventInput(),
      GENESIS_PREV_HASH,
      new DeterministicTestPiiEncryptor(),
      DAEMON_SIGNING_KEY,
    );
    insertSignedPiiRow(database, writeResult);
  });

  afterEach(() => {
    database.close();
  });

  it("verifies before the shred, with the ciphertext still in the column", () => {
    // The precondition for the whole leg: if this failed, the post-shred
    // `valid: true` below would prove nothing about the shred.
    const storedBeforeShred: StoredSessionEventRow = readStoredRow(database);
    expect(storedBeforeShred.pii_payload).not.toBeNull();
    expect(Uint8Array.from(storedBeforeShred.pii_payload ?? [])).toEqual(
      Uint8Array.from(writeResult.piiPayload),
    );
    expect(verifyStoredRow(database)).toEqual({ valid: true });
  });

  it("still verifies after the shred, over bytes rebuilt from the surviving columns", () => {
    shredPiiPayload(database);

    const storedAfterShred: StoredSessionEventRow = readStoredRow(database);
    // The shred actually happened...
    expect(storedAfterShred.pii_payload).toBeNull();
    // ...the ciphertext is gone from the row entirely...
    expect(storedAfterShred.payload).not.toContain(bytesToHex(writeResult.piiPayload));
    // ...the digest standing in for it survived, inside `payload`...
    const survivingPayload = JSON.parse(storedAfterShred.payload) as Record<string, unknown>;
    expect(survivingPayload[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe(
      bytesToHex(blake3(writeResult.piiPayload)),
    );
    // ...no plaintext survived anywhere in the row...
    expect(storedAfterShred.payload).not.toContain(PII_PLAINTEXT_SENTINEL);
    // ...and the signature still verifies. That is `Spec-022 §Signature Safety
    // Under Shred` in one line.
    expect(verifyStoredRow(database)).toEqual({ valid: true });
  });

  it("does not report signature_placeholder for a shredded GENESIS row", () => {
    shredPiiPayload(database);

    // This assertion exists because of the exact case `signer.ts`'s stage-2
    // note calls non-obvious: a legitimate genesis row carries an ALL-ZERO
    // `prev_hash` beside a real `row_hash` and a real signature, so it sits one
    // conjunct away from the placeholder fingerprint. Drop the `row_hash`
    // clause from that predicate and every genesis row in the database reports
    // `signature_placeholder` — a build-ordering verdict on a correctly signed
    // row, routed to the wrong on-call. Both preconditions are asserted so this
    // test cannot pass vacuously against a non-genesis fixture.
    const stored: StoredSessionEventRow = readStoredRow(database);
    expect(Uint8Array.from(stored.prev_hash)).toEqual(GENESIS_PREV_HASH);
    expect(Uint8Array.from(stored.row_hash).every((byte) => byte === 0)).toBe(false);

    const verification: RowVerification = verifyStoredRow(database);
    expect(verification).toEqual({ valid: true });
    expect(verification).not.toHaveProperty("failureMode");
  });

  it("DOES report signature_placeholder for a Plan-001 zero-filled row (stage-2 control)", () => {
    // The negative control for the assertion above: stage 2 is live, so the
    // shredded row's `valid: true` is a verdict that branch declined to give,
    // not a branch that never runs.
    database
      .prepare(
        `UPDATE session_events
            SET prev_hash = ?, row_hash = ?, daemon_signature = ?`,
      )
      .run(Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(64));

    expect(verifyStoredRow(database)).toEqual({
      valid: false,
      failureMode: "signature_placeholder",
    });
  });

  it("survives a shred on a row whose actor is SQL NULL", async () => {
    // `actor` is the canonical set's only nullable member, and storage collapses
    // absent onto null. A rehydrator that maps SQL NULL to `undefined` drops the
    // key from the canonical bytes and breaks an untampered row — so the round
    // trip is pinned rather than assumed.
    const nullActorDatabase: DatabaseType = openDatabase(":memory:");
    try {
      const nullActorResult: PiiEventWriteResult = await writeEventWithPii(
        buildPiiCarryingEventInput({ actor: null }),
        GENESIS_PREV_HASH,
        new DeterministicTestPiiEncryptor(),
        DAEMON_SIGNING_KEY,
      );
      expect(utf8Decoder.decode(canonicalizeEvent(nullActorResult.envelope))).toContain(
        '"actor":null',
      );
      insertSignedPiiRow(nullActorDatabase, nullActorResult);
      shredPiiPayload(nullActorDatabase);

      expect(readStoredRow(nullActorDatabase).actor).toBeNull();
      expect(verifyStoredRow(nullActorDatabase)).toEqual({ valid: true });
    } finally {
      nullActorDatabase.close();
    }
  });

  it("survives a shred on a row with no correlation/causation pair", async () => {
    // The mirror-image mapping: these two are OPTIONAL and not nullable, so
    // SQL NULL means ABSENT and must rehydrate to `undefined`. Map them to
    // `null` and the canonical bytes gain two members the signature never
    // covered.
    const uncorrelatedDatabase: DatabaseType = openDatabase(":memory:");
    try {
      const uncorrelatedResult: PiiEventWriteResult = await writeEventWithPii(
        buildPiiCarryingEventInput({ correlationId: undefined, causationId: undefined }),
        GENESIS_PREV_HASH,
        new DeterministicTestPiiEncryptor(),
        DAEMON_SIGNING_KEY,
      );
      const canonicalText: string = utf8Decoder.decode(
        canonicalizeEvent(uncorrelatedResult.envelope),
      );
      expect(canonicalText).not.toContain("correlationId");
      expect(canonicalText).not.toContain("causationId");

      insertSignedPiiRow(uncorrelatedDatabase, uncorrelatedResult);
      shredPiiPayload(uncorrelatedDatabase);

      const stored: StoredSessionEventRow = readStoredRow(uncorrelatedDatabase);
      expect(stored.correlation_id).toBeNull();
      expect(stored.causation_id).toBeNull();
      expect(verifyStoredRow(uncorrelatedDatabase)).toEqual({ valid: true });
    } finally {
      uncorrelatedDatabase.close();
    }
  });
});

// ==========================================================================
// LEG 3 — THE NEGATIVE CONTROL. Tampering any canonical field post-shred makes
// verification fail. Without this leg, legs 1 and 2 are satisfied by a verifier
// that returns `valid: true` unconditionally. DO NOT DELETE OR NARROW IT.
// ==========================================================================

/**
 * The eleven canonical envelope members, each paired with the SQL that tampers
 * the column carrying it. Exhaustive on purpose (see the header): a verifier
 * that reads ten of eleven members passes any smaller matrix.
 *
 * Every replacement value is chosen to survive BOTH the `0001-initial.ts` CHECK
 * constraints and `EventEnvelopeSchema`, so each case reaches `verifyRow` and
 * the verdict is the verifier's — a rehydration throw would be a different test
 * failing for a different reason. `monotonic_ns` is absent because it is a
 * storage-only column and not one of the canonical eleven.
 */
const CANONICAL_MEMBER_TAMPERS: ReadonlyArray<{
  readonly member: string;
  readonly sql: string;
}> = [
  { member: "id", sql: "UPDATE session_events SET id = '01960b3c-e1d0-7a41-b2c9-000000000000'" },
  {
    member: "sessionId",
    sql: "UPDATE session_events SET session_id = '0192f3a4-5b6c-7d8e-9f01-ffffffffffff'",
  },
  { member: "sequence", sql: "UPDATE session_events SET sequence = 1" },
  {
    member: "occurredAt",
    sql: "UPDATE session_events SET occurred_at = '2026-03-04T05:06:07.009Z'",
  },
  { member: "category", sql: "UPDATE session_events SET category = 'membership_change'" },
  { member: "type", sql: "UPDATE session_events SET type = 'participant.purged'" },
  { member: "actor", sql: "UPDATE session_events SET actor = 'participant-ffff'" },
  {
    member: "payload (non-digest member)",
    sql: `UPDATE session_events SET payload = json_set(payload, '$.exportFormat', 'csv')`,
  },
  {
    member: `payload.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}`,
    // The Spec-022 core: swapping the digest for the digest of DIFFERENT
    // ciphertext is how an attacker would try to re-point a shredded row at
    // PII the signer never saw.
    sql: `UPDATE session_events SET payload = json_set(payload, '$.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}', '${bytesToHex(blake3(utf8Encoder.encode("some other ciphertext")))}')`,
  },
  {
    member: `payload.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY} (removed)`,
    // ABSENCE, which the substitution above cannot cover: a verifier comparing
    // the digest only where the member is PRESENT passes that case and waves
    // this row through. It is also the read side's only way to state the
    // sign-before-embed half of I-006-2-01 — bytes signed before the digest was
    // embedded are indistinguishable at rest from a digest deleted afterwards,
    // and a shredded row carrying neither has nothing left tying it to the
    // ciphertext it once held.
    sql: `UPDATE session_events SET payload = json_remove(payload, '$.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}')`,
  },
  {
    member: "correlationId",
    sql: "UPDATE session_events SET correlation_id = 'correlation-ffff'",
  },
  { member: "causationId", sql: "UPDATE session_events SET causation_id = 'causation-ffff'" },
  // `CHECK(version GLOB '[0-9]*.[0-9]*')` admits this, so the tamper reaches
  // the verifier rather than bouncing off the column constraint.
  { member: "version", sql: "UPDATE session_events SET version = '2.0'" },
];

describe("Plan-006 T2.5 leg 3 — post-shred tamper detection (negative control)", () => {
  let database: DatabaseType;

  beforeEach(async () => {
    database = openDatabase(":memory:");
    insertSignedPiiRow(
      database,
      await writeEventWithPii(
        buildPiiCarryingEventInput(),
        GENESIS_PREV_HASH,
        new DeterministicTestPiiEncryptor(),
        DAEMON_SIGNING_KEY,
      ),
    );
    shredPiiPayload(database);
    // The row is shredded AND verifying — the state every case below tampers
    // away from. Asserting it here is what makes each failure below
    // attributable to the tamper.
    expect(verifyStoredRow(database)).toEqual({ valid: true });
  });

  afterEach(() => {
    database.close();
  });

  it.each(CANONICAL_MEMBER_TAMPERS)(
    "reports hash_mismatch when $member is tampered in the shredded row",
    ({ sql }) => {
      const result = database.prepare(sql).run();
      expect(result.changes).toBe(1);

      expect(verifyStoredRow(database)).toEqual({
        valid: false,
        failureMode: "hash_mismatch",
      });
    },
  );

  it("covers every canonical member exactly once", () => {
    // Guards against a row being dropped during an edit: a shorter matrix would
    // otherwise just be a quieter suite, not a failing one. Eleven members plus
    // the two further `payload` cases that target the digest specifically — one
    // replacing it, one removing it.
    expect(CANONICAL_MEMBER_TAMPERS).toHaveLength(13);
    expect(new Set(CANONICAL_MEMBER_TAMPERS.map((tamper) => tamper.member)).size).toBe(13);
  });

  it("reports signature_mismatch when the attacker also recomputes row_hash", () => {
    // LEG 3 IN ITS STRONGEST FORM. An at-rest adversary with write access to the
    // database can recompute `BLAKE3(prev_hash || canonical)` — the formula is
    // published in `Plan-006 §Hash Chain` — so stage 3 alone is not tamper
    // evidence. Only the Ed25519 signature is, because forging it needs the
    // daemon's private key, which is sealed in the OS keystore (T2.7). This case
    // is what proves the signature is doing work post-shred rather than riding
    // along behind a hash comparison.
    database.prepare("UPDATE session_events SET type = 'participant.purged'").run();
    const tamperedRow: StoredSessionEventRow = readStoredRow(database);
    const tamperedCanonical: CanonicalBytes = canonicalizeEvent(rehydrateEnvelope(tamperedRow));
    const forgedRowHash: Uint8Array = blake3(
      concatenateChainInput(tamperedRow.prev_hash, tamperedCanonical),
    );
    database.prepare("UPDATE session_events SET row_hash = ?").run(Buffer.from(forgedRowHash));

    // Stage 3 now passes on the forged chain digest...
    const refreshedRow: StoredSessionEventRow = readStoredRow(database);
    expect(Uint8Array.from(refreshedRow.row_hash)).toEqual(forgedRowHash);
    // ...and stage 4 is what catches the row.
    expect(verifyStoredRow(database)).toEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
  });

  it("reports signature_mismatch for a shredded row checked against another daemon's key", () => {
    // The signature is bound to ONE daemon identity. Nothing about the shred
    // loosens that binding — an untampered shredded row must still fail against
    // the wrong public key.
    expect(verifyStoredRow(database, OTHER_DAEMON_PUBLIC_KEY)).toEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
  });

  it("reports signature_mismatch when the stored signature itself is flipped", () => {
    const original: StoredSessionEventRow = readStoredRow(database);
    const corruptedSignature = Uint8Array.from(original.daemon_signature);
    corruptedSignature[0] = (corruptedSignature[0] ?? 0) ^ 0x01;
    database
      .prepare("UPDATE session_events SET daemon_signature = ?")
      .run(Buffer.from(corruptedSignature));

    expect(verifyStoredRow(database)).toEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
  });

  it("reports hash_mismatch when a chain column is tampered to a 32-CHARACTER string", () => {
    // The at-rest adversary's cheapest move against a BLOB column: SQLite's
    // BLOB affinity does not coerce, and `length()` counts characters for TEXT,
    // so 32 characters satisfy `CHECK(length(row_hash) = 32)` while
    // better-sqlite3 hands back a JS string. Unguarded that throws out of
    // `verifyRow` and the tamper goes UNREPORTED. It must be a verdict.
    database
      .prepare("UPDATE session_events SET row_hash = '00000000000000000000000000000000'")
      .run();
    expect(typeof readStoredRow(database).row_hash).toBe("string");

    expect(verifyStoredRow(database)).toEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });

  it("THROWS instead of reporting a verdict when the stored sequence is past the ceiling", () => {
    // CHARACTERIZATION, NOT ENDORSEMENT — the one place this suite pins a HOLE
    // rather than a guarantee, and the exact mirror of the case above.
    // `RowVerification` promises "a verdict, and never a throw, for every input
    // the ROW itself supplies", because a throw means T4.1 emits no
    // `audit_integrity_failed` and the tamper goes UNREPORTED. A 32-character
    // chain column is that promise kept; a `sequence` past the safe-integer
    // range is the same promise broken, reached through a column nobody
    // shape-guards.
    //
    // WHICH LAYER THROWS — the attribution matters more than the assertion.
    // It is `rehydrateEnvelope`'s `EventEnvelopeSchema.parse`, as a `ZodError`:
    // the schema bounds `sequence` at `EVENT_ENVELOPE_SEQUENCE_MAX` and its
    // `.int()` independently bounds the safe-integer range, so the parse
    // refuses the collapsed value before any canonicalization runs. It is NOT
    // `canonicalizer.ts`'s `assertRepresentableSequence`, and that guard is not
    // dead either: it is unreachable from any path that PARSES, and it is the
    // ONLY guard for a caller that builds an envelope literal instead — the
    // shape `SessionService.hydrateRow` already uses, narrowing a
    // `safeIntegers(true)` bigint with `Number(row.sequence)`. So the two
    // guards cover disjoint read paths, and this one — the parsing one — is the
    // path with the throw. The final assertion pins WHICH message escaped,
    // because "it throws" is true of both and only one of them is the layer
    // T4.1 has to route around.
    //
    // T4.1'S OBLIGATION, recorded here because this is where it gets
    // rediscovered: pre-check representability ahead of the parse and report
    // `hash_mismatch` — the verdict this module already gives every other
    // malformed stored row, because
    // `Spec-006 §Audit Integrity (audit_integrity)`'s enum has no
    // malformed-stored-row arm.
    //
    // THIS TEST IS EXPECTED TO CHANGE WHEN THAT LANDS, and its failure is the
    // SIGNAL rather than a regression: swap the throw assertions for the
    // `hash_mismatch` verdict and keep the control below.
    database.prepare("UPDATE session_events SET sequence = 9007199254740993").run();

    // Genuinely a stored-data shape rather than a caller-constructed one:
    // SQLite's INTEGER is 64-bit and holds the tampered value EXACTLY...
    const storedSequenceText = database
      .prepare("SELECT CAST(sequence AS TEXT) AS stored_sequence FROM session_events")
      .get() as { readonly stored_sequence: string };
    expect(storedSequenceText.stored_sequence).toBe("9007199254740993");
    // ...and the READ is where fidelity is lost, on both read paths: this
    // statement gets the collapsed double straight from better-sqlite3, and the
    // `safeIntegers(true)` route lands on the identical value the moment
    // `Number(...)` narrows the bigint. Neither recovers the stored integer.
    const tamperedRow: StoredSessionEventRow = readStoredRow(database);
    expect(tamperedRow.sequence).toBe(Number(9007199254740993n));
    expect(Number.isSafeInteger(tamperedRow.sequence)).toBe(false);

    let thrownByVerification: unknown;
    try {
      verifyStoredRow(database);
    } catch (error) {
      thrownByVerification = error;
    }
    // A verdict would leave this `undefined`, which is the assertion that fails
    // the day the pre-check lands.
    expect(thrownByVerification).toBeInstanceOf(Error);
    expect((thrownByVerification as Error).name).toBe("ZodError");
    // Positive evidence of the layer, pinned version-tolerantly: Zod issue
    // CODES and wording are its own formatting detail, while the offending
    // member's path is the contract. Without this, a parse failing for an
    // unrelated reason would keep the test green and the characterization would
    // silently drift.
    const zodIssues = (
      thrownByVerification as {
        readonly issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey> }>;
      }
    ).issues;
    expect(zodIssues.map((issue) => String(issue.path[0]))).toContain("sequence");
    // `assertRepresentableSequence` throws a plain `Error` carrying this
    // wording, so its ABSENCE is what attributes the failure to the parse.
    expect((thrownByVerification as Error).message).not.toContain("canonicalization refused");
  });

  it("still verifies a row minted at the sequence ceiling (representability control)", async () => {
    // THE CONTROL FOR THE CASE ABOVE, and it is load-bearing: without it that
    // throw is equally consistent with "a large sequence breaks this fixture".
    // `Number.MAX_SAFE_INTEGER` is the largest value the canonical bytes can
    // carry faithfully, and it survives the INTEGER column, the parse, and the
    // canonicalizer untouched — so the boundary sits exactly where the previous
    // test says it does, one integer above.
    //
    // MINTED at the ceiling, never TAMPERED to it. The matrix above rewrites
    // `sequence` precisely BECAUSE that changes the canonical bytes, so an
    // UPDATE here would report `hash_mismatch` and prove nothing about
    // representability.
    //
    // IT CLAIMS NOTHING ABOUT LINKAGE. The fixture keeps `GENESIS_PREV_HASH` at
    // a non-zero sequence, which I-006-2-04's `prev_hash[n] = row_hash[n-1]`
    // would refuse; `verifyRow` is an intra-row check handed no neighbours (its
    // SCOPE note), so that walk is T4.1's and this control is scoped to what
    // `verifyRow` actually decides.
    const ceilingDatabase: DatabaseType = openDatabase(":memory:");
    try {
      insertSignedPiiRow(
        ceilingDatabase,
        await writeEventWithPii(
          buildPiiCarryingEventInput({ sequence: Number.MAX_SAFE_INTEGER }),
          GENESIS_PREV_HASH,
          new DeterministicTestPiiEncryptor(),
          DAEMON_SIGNING_KEY,
        ),
      );
      shredPiiPayload(ceilingDatabase);

      const stored: StoredSessionEventRow = readStoredRow(ceilingDatabase);
      expect(stored.sequence).toBe(Number.MAX_SAFE_INTEGER);
      expect(Number.isSafeInteger(stored.sequence)).toBe(true);
      expect(verifyStoredRow(ceilingDatabase)).toEqual({ valid: true });
    } finally {
      ceilingDatabase.close();
    }
  });
});

// ==========================================================================
// The second acceptance criterion — a deliberately misordered write path is
// rejected. T2.4 enforces encrypt → digest → embed → canonicalize → sign at
// COMPILE time via the brand chain (I-006-2-01); these are the RUNTIME
// counterparts, for the values that reach the codec without ever passing a
// TypeScript check.
// ==========================================================================

describe("Plan-006 T2.5 — a misordered PII write path is refused at runtime (I-006-2-01)", () => {
  it("refuses a payload that already carries the digest, BEFORE spending the nonce", async () => {
    // Signing before digest-embedding, spelled the way it would actually
    // arrive: a caller that computed and embedded its own digest and now wants
    // the codec to rubber-stamp it. The codec is the ONLY producer of that
    // member, so a pre-existing one means either a re-run (which cannot
    // reproduce the first ciphertext) or a producer-supplied value the
    // signature would then vouch for with nothing having verified it.
    const encryptor = new DeterministicTestPiiEncryptor();
    const forgedInput: PiiCarryingEventInput = buildPiiCarryingEventInput({
      payload: {
        exportFormat: "json",
        [PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: bytesToHex(new Uint8Array(32)),
      },
    });

    await expect(
      writeEventWithPii(forgedInput, GENESIS_PREV_HASH, encryptor, DAEMON_SIGNING_KEY),
    ).rejects.toThrow(/refuses an event whose payload already carries pii_ciphertext_digest/);

    // THE ORDER ASSERTION, not a bonus. The refusal must land before the
    // encrypt step, because encryption is the one irreversible stage: the real
    // codec consumes a random nonce there and the codec is
    // `manual_reconcile_only`, so a post-encrypt throw leaves a half-built
    // commitment for an operator to reconcile.
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a non-canonical occurredAt before the encrypt step", async () => {
    // `normalizeOccurredAt` runs ahead of the encrypt call for the same reason.
    // Sub-millisecond precision is the refusal that cannot be folded away: the
    // canonical form cannot represent it, and truncating would leave
    // `daemon_signature` not committing to the recorded timestamp.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ occurredAt: "2026-03-04T05:06:07.0081Z" }),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/sub-millisecond precision/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses an audit_integrity event before the encrypt step (I-006-3-01 layer 2)", async () => {
    // T2.4's own cite, exercised once from the shred side because it is the
    // reason the category exists: `audit_integrity` rows are never shredded, so
    // a PII payload attached to one would be permanent. The compile-time half
    // (`piiPayload?: never`) is T2.4's; the runtime half is what catches a value
    // that arrived across a serialization boundary or an `as` cast, which is the
    // only way this call can be made at all.
    const encryptor = new DeterministicTestPiiEncryptor();
    const refusedCategoryInput = {
      ...buildPiiCarryingEventInput(),
      category: "audit_integrity",
    } as unknown as PiiCarryingEventInput;

    await expect(
      writeEventWithPii(refusedCategoryInput, GENESIS_PREV_HASH, encryptor, DAEMON_SIGNING_KEY),
    ).rejects.toThrow(/refuses category "audit_integrity"/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses an empty ciphertext rather than digesting nothing", async () => {
    // The one guard that CANNOT precede the encrypt step — it judges a value
    // that does not exist until the encryptor has run. No AEAD emits a
    // zero-length output, so this means the injected implementation returned
    // nothing while claiming success.
    const encryptor = new FixedResultPiiEncryptor(new Uint8Array(0));

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput(),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/must return non-empty Uint8Array ciphertext/);
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses a non-Uint8Array ciphertext rather than signing a digest of coerced bytes", async () => {
    // A hex STRING is the realistic shape of this bug — it is what a codec
    // round-tripping through a text column or a JSON boundary hands back — and
    // it is silent without the guard: BLAKE3 would digest whatever it coerces
    // to, and the row would commit to bytes that are not the stored ciphertext.
    const encryptor = new FixedResultPiiEncryptor("6465616462656566");

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput(),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/received a non-Uint8Array value of type string/);
  });

  it("refuses a prev_hash that is not 32 bytes, so no doomed signature is minted", async () => {
    // Inherited from T2.2 rather than duplicated in the codec. A wrong-width
    // link hashes happily and produces an UNTAMPERED row that can never verify
    // — the failure mode with no recovery path, since the signature is over
    // bytes no verifier can reconstruct.
    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput(),
        new Uint8Array(31),
        new DeterministicTestPiiEncryptor(),
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/signRow requires a 32-byte Uint8Array prev_hash/);
  });

  it("keeps the misordering a COMPILE error too — the brands admit no shortcut", () => {
    // Self-verifying: an UNUSED `@ts-expect-error` is itself a TS2578 error, so
    // if any of these brands ever gained an exported constructor — or an
    // implicit-any escape hatch — the `tsc -p tsconfig.test.json` pass fails.
    // No `as never` / `as any` is used on the branded assignment itself: that
    // would silence the very error each case exists to surface. Together these
    // three are the compile-time half of I-006-2-01 that the runtime cases above
    // cannot reach, because a caller that jumps a stage cannot even be written.
    const bareCiphertext: Uint8Array = new Uint8Array([1, 2, 3]);
    const plainEnvelope: EventEnvelope = buildPiiCarryingEventInput();
    const bareKeyBytes: Uint8Array = new Uint8Array(32);

    // @ts-expect-error a bare Uint8Array is not PiiPayloadCiphertext — the encrypt stage mints that brand at exactly one site inside pii-indirection.ts, so no caller can jump straight to the digest stage
    const forgedCiphertext: PiiPayloadCiphertext = bareCiphertext;
    // @ts-expect-error a plain EventEnvelope is not EventWithPiiDigest — the embed stage mints that brand, so no caller can canonicalize-and-sign a payload that never gained the digest
    const forgedDigestBearingEnvelope: EventWithPiiDigest = plainEnvelope;
    // @ts-expect-error a bare Uint8Array is not Ed25519PrivateKey — key material enters the type system only through T2.7's custody module
    const forgedSigningKey: Ed25519PrivateKey = bareKeyBytes;

    // Runtime reads keep the bindings used for lint and anchor the type proof
    // to an executing assertion; the load-bearing check is the compile.
    expect(forgedCiphertext.length).toBe(3);
    expect(forgedDigestBearingEnvelope.id).toBe(FIXTURE_EVENT_ID);
    expect(forgedSigningKey.length).toBe(32);
  });
});
