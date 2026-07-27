// Post-shred signature-verification property suite (Plan-006 T2.5).
//
// THE LOAD-BEARING SAFETY PROOF FOR THE ENTIRE PII DESIGN. Everything else in
// Phase 2 builds the machinery; this file is the only artifact that
// empirically demonstrates the claim the machinery exists to support —
// `Spec-022 §Signature Safety Under Shred`: a `daemon_signature` taken over
// canonical bytes that carry `pii_ciphertext_digest` (and never the ciphertext
// itself) SURVIVES a Plan-022 Path-1 crypto-shred. Destroy the participant's
// content key and the row is still verifiable while the PII is irrecoverable.
// If that is not true, the audit log and the right-to-erasure obligation are in
// direct conflict and one of them has to be given up.
//
// A PATH-1 SHRED IS A KEY DELETION AND OVERWRITES NO COLUMN — the single fact
// this suite is easiest to get wrong about. `Spec-022 §Shred Fan-Out` Path 1's
// mechanism is `DELETE FROM participant_keys` (plus `artifact_encryption_keys`,
// Plan-014's and not in this schema); its scope selector is the durable
// participant-id stamp on the event row, NOT the ciphertext, which is opaque.
// The ciphertext bytes STAY in `session_events.pii_payload` after the shred —
// unreadable forever, because the only key that could decrypt them is gone, but
// bytewise intact and still hashing to the digest the signature committed to.
// Modelling the shred as `UPDATE … SET pii_payload = NULL` would be a different
// operation with a different postcondition: that state is EVIDENCE DESTRUCTION,
// which `isCiphertextDigestBound` classifies as UNBOUND (see the last describe
// in this file). {@link nullPiiPayloadColumn} exists to produce it deliberately,
// as a negative — never as a stand-in for a shred.
//
// THREE LEGS, AND THE THIRD IS A NEGATIVE CONTROL THAT IS NOT OPTIONAL.
//
//   1. `writeEventWithPii` produces canonical bytes that INCLUDE
//      `pii_ciphertext_digest` and exclude every trace of the plaintext and of
//      the ciphertext (`Spec-006 §Canonical Serialization Rules`, I-006-2-05).
//   2. After the participant's content key is DELETEd — the shred — the
//      `daemon_signature` STILL verifies against bytes re-canonicalized from the
//      row AND the retained ciphertext STILL binds to its signed digest. The
//      CONJUNCTION is the claim: the verify half alone is nearly vacuous across
//      an operation that writes no column, and the binding half is what
//      separates a shredded row from an evidence-destroyed one.
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
// FROM THE WRITE — and the reason is REHYDRATION FIDELITY, not the shred.
// Verifying the write-time envelope would test the canonicalizer against
// itself: the bytes would never have crossed the column types, so every
// storage-shaped divergence would be invisible. SQL NULL collapsing `actor`'s
// present-and-null onto `correlationId`'s absent is the live instance — two
// column groups that must rehydrate DIFFERENTLY to reproduce the signed bytes
// (see {@link rehydrateEnvelope}), pinned by dedicated cases in leg 2. Rebuild
// them the same way and an UNTAMPERED row reports `hash_mismatch`, at which
// point the tempting "fix" is to verify the write-time envelope and lose the
// whole leg. That is also why this suite runs against a real in-memory SQLite
// database on the shipped migrations rather than against object literals — the
// `CHECK(length(prev_hash) = 32)` / `CHECK(length(daemon_signature) = 64)`
// clauses in `0001-initial.ts` then vouch for the widths on the way in, and the
// BLOB round trip is the one that actually happens in production.
//
// THE ROUND TRIP IS ALSO WHAT LETS LEG 2 SAY ANYTHING ABOUT THE CIPHERTEXT.
// `verifyRow` is never handed `pii_payload` — it takes canonical bytes, three
// integrity columns and a public key — so it is structurally incapable of
// noticing what the ciphertext column holds, and no arrangement of its
// arguments will make it notice. Since a Path-1 shred writes no column at all,
// a leg 2 built on `verifyRow` alone would be asserting that nothing changed
// after nothing happened. `isCiphertextDigestBound` is the second reader, over
// the stored column the verifier cannot see, and running BOTH over the SAME
// persisted row is what makes the leg a claim rather than a restatement.
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
import {
  isCiphertextDigestBound,
  isPiiOwnerStampBound,
  PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  PII_PARTICIPANT_ID_PAYLOAD_KEY,
  writeEventWithPii,
} from "../pii-indirection.js";
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

const RFC_8032_TEST_1_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_8032_TEST_2_SEED_HEX = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

const DAEMON_SIGNING_KEY: Ed25519PrivateKey = hexToBytes(
  RFC_8032_TEST_1_SEED_HEX,
) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY: Ed25519PublicKey = ed25519.getPublicKey(
  DAEMON_SIGNING_KEY,
) as Ed25519PublicKey;

/** A second, unrelated daemon identity — the wrong-signer control. */
const OTHER_DAEMON_PUBLIC_KEY: Ed25519PublicKey = ed25519.getPublicKey(
  hexToBytes(RFC_8032_TEST_2_SEED_HEX) as Ed25519PrivateKey,
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

/**
 * A stub that hands back ONE buffer to every caller and rewrites it afterwards —
 * the reusable-scratch implementation CP-006-1 permits.
 *
 * `PiiEncryptor` fixes a return TYPE and says nothing about the lifetime of the
 * memory behind it, so an implementation that keeps a scratch array and
 * overwrites it on the next encrypt conforms to the interface completely. This
 * stub exists because the hazard is otherwise untestable: it is a statement about
 * what the CONTRACT allows, not about what any shipped code does.
 *
 * NO IN-REPO IMPLEMENTATION MUTATES A RETURNED BUFFER TODAY, and saying so is
 * part of the test's honesty. `DeterministicTestPiiEncryptor` allocates a fresh
 * array per call; `FixedResultPiiEncryptor` does return the same object every
 * call — the aliasing half of the hazard, already in this file — but never writes
 * through it; and Plan-022's real AES-256-GCM codec is a Tier-5 module that does
 * not exist yet, which is precisely why this module cannot wait to find out.
 */
class ScratchBufferPiiEncryptor implements PiiEncryptor {
  readonly #scratch: Uint8Array;

  constructor(byteLength: number) {
    this.#scratch = new Uint8Array(byteLength).fill(0xa5);
  }

  /** The array every call returns — the alias the codec must not carry forward. */
  get scratch(): Uint8Array {
    return this.#scratch;
  }

  /** Stands in for the NEXT encryption writing through the same memory. */
  overwriteScratch(fillByte: number): void {
    this.#scratch.fill(fillByte);
  }

  encrypt(_request: PiiEncryptionRequest): Promise<Uint8Array> {
    return Promise.resolve(this.#scratch);
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
 * (I-006-1-03). A twelfth member would break this literal, the rehydrator below
 * and leg 3's `CANONICAL_ENVELOPE_MEMBERS` — which breaks BY DESIGN, as the
 * compile-time drift guard — and nothing else in the file, which is why the
 * first two exist rather than inline object literals per test.
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

/**
 * `canonicalizer.ts`'s `CANONICAL_JSON_MAX_DEPTH`, RESTATED RATHER THAN
 * IMPORTED — and not only because the const is module-private there. Same
 * argument that module makes for not importing `EVENT_ENVELOPE_SEQUENCE_MAX`:
 * a shared const would make the two surfaces agree BY CONSTRUCTION, including
 * agreeing on a value that drifted. The paired cases below — a row minted AT
 * this depth verifies, a row tampered one level past it throws — are the drift
 * guard a shared const could not be.
 */
const CANONICAL_JSON_MAX_DEPTH = 64;

/**
 * Builds a `payload` whose DEEPEST container sits at `canonicalDepth`, counted
 * exactly the way `canonicalizer.ts` counts: the projected envelope
 * `canonicalizeEvent` hands the serializer is depth 1, `payload` itself is
 * depth 2, and each further nesting level adds one. So a flat payload is
 * `canonicalDepth = 2`, and the payload tree contributes `canonicalDepth - 2`
 * levels below itself.
 *
 * Counting in the CEILING'S OWN UNIT rather than in payload-local levels is
 * deliberate: the off-by-two between the two framings is exactly the mistake
 * that would turn the boundary control below into a second throw case.
 */
function buildPayloadNestedToCanonicalDepth(canonicalDepth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {};
  for (let depth = canonicalDepth; depth > 2; depth--) {
    node = { nested: node };
  }
  return node;
}

// --------------------------------------------------------------------------
// Storage fixture — stands in for T3.1's step 7 (see the header).
// --------------------------------------------------------------------------

/**
 * The raw better-sqlite3 row shape.
 *
 * THE THREE INTEGRITY COLUMNS ARE `unknown` BECAUSE THIS FILE DISPROVES ANY
 * NARROWER DECLARATION. SQLite's `BLOB` declared type gives BLOB AFFINITY with
 * no coercion, so the 32-CHARACTER tamper case below writes a TEXT value that
 * satisfies `CHECK(length(row_hash) = 32)` and asserts, on the way back out,
 * that `typeof row.row_hash === "string"`. Declaring `Uint8Array` here would be
 * a claim the suite itself falsifies one assertion later. Same register — and
 * the same reasoning — as `signing-key-source.ts`'s
 * `readonly sealed_private_key: unknown`: the column declaration is a claim
 * TypeScript never checked, so the type says `unknown` and the narrowing
 * happens where the CHECK happens (`verifyRow`'s stage-1 shape guard, reached
 * through {@link toSignedRow}).
 *
 * The scalar columns keep their declared types, which is not an inconsistency:
 * nothing in this suite disproves them, and declaring unverified scalar column
 * types is the established register in this package
 * (`session/session-service.ts`'s `SessionEventRow` does exactly that).
 * `pii_payload` likewise — it is only ever read back as the bytes the encryptor
 * produced or as SQL NULL, and no case tampers it.
 */
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
  readonly prev_hash: unknown;
  readonly row_hash: unknown;
  readonly daemon_signature: unknown;
}

/**
 * The custody row a sealed `pii_payload` implies, and the row Path 1 DELETEs.
 *
 * PROVISIONED HERE RATHER THAN AT EACH CALL SITE because it is not a second
 * step: a `session_events` row holding ciphertext sealed under a participant's
 * content key and NO `participant_keys` row for that participant is a state
 * Plan-022 does not admit, so the two rows are one fixture state. Splitting them
 * would leave every future test author one forgotten call away from a shred that
 * reports `changes === 0` for a reason nothing in this file explains.
 *
 * THE TABLE IS REAL AND SHIPPED, WHICH IS WHY THE SHRED CAN BE. `0001-initial.ts`
 * CREATEs `participant_keys` under `-- Owner: Spec-022 (GDPR)` — Plan-001 makes
 * the empty table so downstream plans need not ALTER its shape, and Plan-022 owns
 * the wrapping and the DELETE-as-crypto-shred lifecycle. So this suite invents no
 * DDL; it writes a fixture row into shipped DDL, exactly as {@link
 * insertSignedPiiRow} does for `session_events`.
 *
 * THE BLOB IS NOT A WRAPPED KEY AND NOTHING HERE PRETENDS OTHERWISE. Real
 * custody is an AES-256 key envelope-encrypted under the daemon master key
 * (`Spec-022 §PII Payload Column Pattern`); this suite's encryptor is the
 * CP-006-1 stub, which derives its keystream from `participantId || eventId` and
 * never reads this table. The row therefore models Plan-022's CUSTODY RECORD,
 * not its cryptography — see {@link applyPath1CryptoShred} for what that does and
 * does not license this suite to claim.
 *
 * ONE CUSTODY ROW PER PARTICIPANT, ONE EVENT ROW PER EVENT — the two are NOT
 * 1:1, which is why this is idempotent rather than a bare INSERT.
 * `participant_keys.participant_id` is `TEXT NOT NULL PRIMARY KEY`, and a second
 * PII event from the same participant seals under the SAME content key (that is
 * what makes a single DELETE erase a participant's whole history rather than one
 * row of it). An unconditional INSERT survives only because every fixture here
 * writes one event into a fresh `:memory:` database; the first two-event chain
 * for one participant — the ordinary shape, and the one T3.1's
 * `EventLogService.append` produces — would throw
 * `SQLITE_CONSTRAINT_PRIMARYKEY` out of {@link insertSignedPiiRow}, where it
 * would read as a `session_events` defect.
 */
function provisionParticipantContentKey(database: DatabaseType, participantId: string): void {
  const custodyRow = database
    .prepare("SELECT encrypted_key_blob FROM participant_keys WHERE participant_id = ?")
    .get(participantId) as { readonly encrypted_key_blob: Uint8Array } | undefined;

  // NOT `INSERT OR IGNORE`, which absorbs every conflict including the ones worth
  // hearing about: a custody row whose blob is not the one this fixture writes has
  // been rotated or overwritten by something else, and a shred asserted against it
  // would be asserting over a key nothing in this file put there.
  if (custodyRow !== undefined) {
    // ASSERTED AS DECODED TEXT FIRST so the failure explains itself without anyone
    // opening this helper. The blob is `test-wrapped-content-key-for-<id>`, so a
    // fixture that provisioned two different content keys under one participant id
    // prints those two ids side by side — where comparing the raw bytes would print
    // two anonymous `Uint8Array`s and send the reader here to find out why.
    expect(utf8Decoder.decode(Uint8Array.from(custodyRow.encrypted_key_blob))).toBe(
      utf8Decoder.decode(participantContentKeyFixtureBlob(participantId)),
    );
    // AND AS BYTES, because the decode above is lossy: `TextDecoder` substitutes
    // U+FFFD rather than throwing, so two DIFFERENT non-UTF-8 blobs can decode to
    // the same replacement characters. The readable assertion catches the case that
    // actually happens; this one closes the case that would otherwise pass.
    expect(Uint8Array.from(custodyRow.encrypted_key_blob)).toEqual(
      participantContentKeyFixtureBlob(participantId),
    );
    return;
  }

  const provisioning = database
    .prepare(
      `INSERT INTO participant_keys (participant_id, encrypted_key_blob, key_version, created_at)
         VALUES (@participant_id, @encrypted_key_blob, 1, @created_at)`,
    )
    .run({
      participant_id: participantId,
      encrypted_key_blob: Buffer.from(participantContentKeyFixtureBlob(participantId)),
      created_at: FIXTURE_OCCURRED_AT,
    });
  expect(provisioning.changes).toBe(1);
}

/**
 * The stand-in for Plan-022's envelope-encrypted key material, derived from the
 * participant id so {@link provisionParticipantContentKey} can recognize its own
 * row on a re-provision without holding state between calls.
 */
function participantContentKeyFixtureBlob(participantId: string): Uint8Array {
  return utf8Encoder.encode(`test-wrapped-content-key-for-${participantId}`);
}

/**
 * Persists three of the write unit's four members into `session_events` —
 * `piiParticipantId` is the one it drops, and the omission is the schema's, not
 * this helper's — plus the {@link provisionParticipantContentKey} custody row.
 *
 * `0001-initial.ts` gives `session_events` no participant-id column for the PII
 * owner, and `actor` is a different value (it may be an agent id or NULL). So
 * there is nowhere to put the stamp today, and inventing a column here would be
 * this suite writing DDL for a table Plan-001 owns and a migration Phase 3 owns.
 * `pii-indirection.ts`'s header names T3.1 as the phase that adds it. Until then
 * these tests exercise the shred-SIGNATURE property, which needs the ciphertext
 * and the signed columns; the shred SELECTOR property is Phase-3's to test,
 * because it is Phase 3 that will have a column to select on. The stamp is bound
 * inside the SIGNED PAYLOAD in this phase (leg 1 asserts it), which is a
 * different claim from a stored column and does not substitute for one.
 */
function insertSignedPiiRow(database: DatabaseType, result: PiiEventWriteResult): void {
  const { envelope, piiPayload, signedRow } = result;
  provisionParticipantContentKey(database, result.piiParticipantId);
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

/**
 * THE FILE'S ONE NARROWING SITE for the three integrity columns.
 *
 * `SignedRow` declares three `Uint8Array`s and storage supplies three
 * `unknown`s (see above), so SOMETHING has to assert across that gap — and the
 * honest place is here, because this cast IS the claim the production read path
 * makes. `verifyRow` guards both chain columns at stage 1 and the signature at
 * stage 2 precisely because its own parameter declaration is unchecked, so
 * handing it the unnarrowed value is what exercises those guards. Casting at
 * each call site instead would spread the same unchecked claim over a dozen
 * places and let one of them narrow to something production never sees; every
 * case below that needs raw integrity bytes reads them off this function's
 * result.
 */
function toSignedRow(row: StoredSessionEventRow): SignedRow {
  return {
    prevHash: row.prev_hash as Uint8Array,
    rowHash: row.row_hash as Uint8Array,
    daemonSignature: row.daemon_signature as Uint8Array,
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
 * Runs {@link verifyStoredRow} and returns whatever ESCAPED it — or `undefined`
 * when it produced a verdict instead.
 *
 * Used only by the characterization block at the end of leg 3, and shaped this
 * way rather than as `expect(...).toThrow()` because every case there has to
 * attribute WHICH LAYER threw: a `ZodError` and the `issues[].path` naming the
 * offending member, or a plain `Error` and the wording naming the guard.
 * `toThrow` matches a message and hands the caller no error object to inspect,
 * so it cannot separate the three layers this suite exists to separate.
 */
function captureReadPathThrow(database: DatabaseType): unknown {
  try {
    verifyStoredRow(database);
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Reads the stored ciphertext column back as plain bytes, or `null`.
 *
 * `Uint8Array.from` rather than the raw better-sqlite3 `Buffer`, because these
 * values are compared with `toEqual` across a shred and a `Buffer` compares
 * equal to a `Uint8Array` of different contents under some matchers. Normalising
 * at the read keeps the comparison about the BYTES.
 */
function readStoredCiphertext(database: DatabaseType): Uint8Array | null {
  const stored: Uint8Array | null = readStoredRow(database).pii_payload;
  return stored === null ? null : Uint8Array.from(stored);
}

/**
 * Does the stored ciphertext column still hash to the digest the SIGNATURE
 * committed to? The read-side binding `verifyRow` structurally cannot make.
 *
 * Composed over the SAME persisted row the verifier reads, so the two verdicts
 * are about one row rather than two fixtures. `payload` is parsed from the
 * column rather than taken off the write-time envelope for {@link
 * rehydrateEnvelope}'s reason: the write-time object would make the digest agree
 * with itself.
 */
function isStoredCiphertextDigestBound(database: DatabaseType): boolean {
  const row: StoredSessionEventRow = readStoredRow(database);
  return isCiphertextDigestBound(
    row.pii_payload,
    JSON.parse(row.payload) as Record<string, unknown>,
  );
}

/** Whether `participant_keys` still holds a custody row for the participant. */
/**
 * Row counts for the two tables this suite writes.
 *
 * The table name is interpolated rather than bound because SQLite binds VALUES
 * and never identifiers — and the parameter is a two-member literal union, so
 * the only strings that reach the SQL are the two written here. A reviewer
 * scanning for interpolated SQL should stop at this comment rather than at the
 * template literal.
 */
function countRows(
  database: DatabaseType,
  tableName: "session_events" | "participant_keys",
): number {
  const { rowCount } = database.prepare(`SELECT COUNT(*) AS rowCount FROM ${tableName}`).get() as {
    readonly rowCount: number;
  };
  return rowCount;
}

function hasParticipantContentKey(database: DatabaseType, participantId: string): boolean {
  const custodyRow = database
    .prepare("SELECT participant_id FROM participant_keys WHERE participant_id = ?")
    .get(participantId);
  return custodyRow !== undefined;
}

/**
 * PLAN-022 PATH-1 CRYPTO-SHRED — A KEY DELETION. IT OVERWRITES NO COLUMN.
 *
 * `Spec-022 §Shred Fan-Out` Path 1's mechanism is `DELETE FROM participant_keys`
 * — destroying the random per-participant AES-256 key whose only persisted copy
 * was that row, which is what makes the deletion a true cryptographic erasure —
 * plus the same DELETE against `artifact_encryption_keys` on every node the
 * participant runs. Its scope selector is the durable participant-id stamp on
 * the event row, NOT the ciphertext, which is opaque. Nothing in Path 1 writes to
 * `session_events`: the ciphertext bytes stay exactly where they were,
 * permanently unreadable but bytewise intact, which is why the digest a
 * pre-shred signature committed to still describes them.
 *
 * THE FIRST DELETE IS EXECUTED FOR REAL AGAINST SHIPPED DDL. `0001-initial.ts`
 * CREATEs `participant_keys` (`-- Owner: Spec-022 (GDPR)`; Plan-001 makes the
 * empty table, Plan-022 owns the lifecycle), so Path 1's primary mechanism is
 * not hypothetical here — it runs, and `changes === 1` is the evidence it ran.
 * `artifact_encryption_keys` is Plan-014's and no migration creates it, so that
 * half stays unmodelled; it is a second key custody table and likewise writes no
 * `session_events` column, so its absence changes nothing this suite observes.
 *
 * WHAT THIS DELETE DOES **NOT** PROVE, STATED SO NOBODY READS MORE INTO IT.
 * The CP-006-1 stub encryptor derives its keystream from `participantId ||
 * eventId` and never reads `participant_keys`, so the DELETE is causally inert
 * with respect to every value this suite can observe. The irreversibility
 * argument is Plan-022's (`Spec-022 §Signature Safety Under Shred`, steps 4-5),
 * not something a test with a stub cipher can demonstrate. What IS demonstrated
 * here is the property Plan-006 owns and I-006-2-05 asserts: the audit-integrity
 * surface — signature, hash chain, and the ciphertext's digest binding — is
 * INVARIANT across the operation, and the assertion below is what fires the day
 * someone reintroduces a `pii_payload` write into this helper.
 *
 * THE TEETH ARE IN THE PAIRING, NOT IN THIS FUNCTION. A test that only asserts
 * "still verifies after an operation that writes no column" is close to vacuous
 * on its own. {@link nullPiiPayloadColumn} is its discriminating negative: the
 * same row, the same verifier, a genuinely different postcondition.
 */
function applyPath1CryptoShred(database: DatabaseType, participantId: string): void {
  const ciphertextBeforeShred: Uint8Array | null = readStoredCiphertext(database);
  // A shred against a participant with no custody row is a no-op that would let
  // every assertion below pass without the erasure ever happening.
  expect(hasParticipantContentKey(database, participantId)).toBe(true);

  const deletion = database
    .prepare("DELETE FROM participant_keys WHERE participant_id = ?")
    .run(participantId);
  expect(deletion.changes).toBe(1);
  expect(hasParticipantContentKey(database, participantId)).toBe(false);

  // PATH 1 OVERWRITES NO COLUMN — the invariant this helper exists to hold, and
  // the one a "shred clears pii_payload" rewrite breaks on its first run.
  expect(readStoredCiphertext(database)).toEqual(ciphertextBeforeShred);
}

/**
 * NULLs `session_events.pii_payload`. THIS IS NOT A SHRED — do not rename it
 * into one.
 *
 * Deliberately named for the column write it performs rather than for any
 * policy operation, because two DIFFERENT operations reach this state and
 * neither of them is Path 1:
 *
 *   * `Spec-006 §Compacted Event Format` — compaction NULLs the column and
 *     replaces `payload` with a stub projection carrying no digest, so the
 *     post-state is BOTH-ABSENT and stays digest-bound.
 *   * An at-rest adversary destroying evidence — the column NULLed while the
 *     signed digest survives inside `payload`. That post-state is UNBOUND, and
 *     `isCiphertextDigestBound` classifying it so is the whole reason the
 *     predicate exists.
 *
 * Modelling a shred with this call collapses the second state onto Path 1's and
 * asserts that evidence destruction is a legitimate, verifying end state. It is
 * used below only as the negative that keeps {@link applyPath1CryptoShred}'s
 * green verdicts meaningful.
 */
function nullPiiPayloadColumn(database: DatabaseType): void {
  const update = database.prepare("UPDATE session_events SET pii_payload = NULL").run();
  expect(update.changes).toBe(1);
}

// ==========================================================================
// LEG 1 — the signed bytes commit to the DIGEST, never to the ciphertext or
// the plaintext (I-006-2-05, `Spec-006 §Canonical Serialization Rules`).
// ==========================================================================
//
// "NOTHING PII" MEANS THE PII PARTITION'S CONTENT, NOT IDENTIFIERS — A SCOPE
// CLARIFICATION, NOT AN INVARIANT AMENDMENT. I-006-2-05 states that
// `daemon_signature` covers canonical bytes that include the digest and exclude
// `pii_payload`; the excluded thing it names is the PARTITION — plaintext and
// ciphertext — and the leg's title is read against that. It has never meant
// "carries no participant identifier": `actor` was in the canonical eleven from
// Plan-001 and holds exactly such an identifier (`0001-initial.ts`'s
// `session_events.actor` column comment: "participant_id or agent_id or NULL for
// system"), and the projection literal in `pii-indirection.ts` has always
// included it. So the PII owner stamp now riding inside `payload` as
// `pii_participant_id` adds an identifier of a class the signed bytes already
// carried, and it must: the Path-1 selector matches on the durable stamp
// (`Spec-022 §Shred Fan-Out` Path 1 Scope), and an unsigned stamp is one an
// at-rest adversary can rewrite to point the row at a participant who will never
// be erased. Recorded here so this is not re-opened as a leak.

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

    // The signed bytes are the ONE place PII must never appear. A Path-1 shred
    // writes no column, so the ciphertext survives at rest, and canonical bytes
    // are reproducible from the surviving row forever — plaintext that lands
    // here is signed into the audit record for as long as the row exists, past
    // any erasure, and no later operation can take it back out without breaking
    // every signature over it.
    expect(canonicalText).not.toContain(PII_PLAINTEXT_SENTINEL);
    expect(canonicalText).not.toContain(PII_PLAINTEXT_SENTINEL_KEY);
    expect(canonicalText).not.toContain("Ada Lovelace");
    expect(canonicalText).not.toContain("ada@example.invalid");
    // Nor the ciphertext, in the encoding it would most plausibly take.
    // Ciphertext in the signed bytes would hand an attacker a
    // length-and-structure oracle over data the shred rendered unreadable.
    expect(canonicalText).not.toContain(bytesToHex(result.piiPayload));
    expect(canonicalText).not.toContain("piiPayload");
    expect(canonicalText).not.toContain("pii_payload");

    // THE OWNER STAMP IS SIGNED, AND THE TWO SPELLINGS SAY DIFFERENT THINGS —
    // this pair replaces a bare `not.toContain("piiParticipantId")` that stayed
    // green for the wrong reason once the stamp landed, since it happened to
    // test the camelCase spelling of a member that arrived in snake_case.
    //
    //   * `pii_participant_id` (WIRE) MUST be present. It is the Path-1 selector
    //     (`Spec-022 §Shred Fan-Out` Path 1 Scope) and the AAD's participant
    //     half, and only a signed stamp is one an at-rest adversary cannot
    //     rewrite to make the row unreachable by the erasure sweep. This is not
    //     a leak: see the scope clarification on this leg's header.
    //   * `piiParticipantId` (INPUT) MUST be absent, and the claim is unchanged
    //     by the stamp landing. It is `PiiCarryingEventInput`'s member name, and
    //     it can only reach the canonical bytes if `embedCiphertextDigest`
    //     spreads `input` instead of projecting member by member — the
    //     single-token regression that would carry `piiPayload` along with it.
    //     So this assertion is a leak detector for the SPREAD, and the sentinel
    //     assertions above are what catch the partition it would drag in.
    expect(canonicalText).toContain(
      `"${PII_PARTICIPANT_ID_PAYLOAD_KEY}":"${FIXTURE_PARTICIPANT_ID}"`,
    );
    expect(canonicalText).not.toContain("piiParticipantId");
    // The wire spelling is pinned at exactly one site, because it is the byte
    // string every independent verifier and every row on disk depends on — a
    // constant renamed to a different value is a silent contract break that the
    // assertion above, reading through the constant, could never see.
    expect(PII_PARTICIPANT_ID_PAYLOAD_KEY).toBe("pii_participant_id");

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

  it("returns the PII owner's participant id, on an event whose actor is not that owner", async () => {
    // The stamp is the only carrier of the PII owner on the persistence unit,
    // and both things that need it later need it as an INPUT: the AAD is
    // `participant_id || event_id`, which no decrypt can rebuild from the
    // ciphertext, and the Path-1 selector in `Spec-022 §Shred Fan-Out` matches
    // "the durable participant-id stamp on the event row, not the ciphertext
    // (which is opaque)".
    //
    // `actor` IS NOT A SUBSTITUTE, which is why this case is built on the
    // divergence rather than on the default fixture where the two coincide.
    // `PiiEncryptionRequest.participantId` documents that `actor` may be an
    // agent id or `null`; here it is `null`, so an implementation that stamped
    // rows from `actor` would record no owner at all and lose the row to the
    // shred selector forever.
    //
    // Leg 2's "survives a shred on a row whose actor is SQL NULL" reuses this
    // same fixture shape for an unrelated claim — that the SQL-NULL round trip
    // still reproduces the canonical bytes. Neither test subsumes the other.
    const input: PiiCarryingEventInput = buildPiiCarryingEventInput({ actor: null });
    const result: PiiEventWriteResult = await writeEventWithPii(
      input,
      GENESIS_PREV_HASH,
      encryptor,
      DAEMON_SIGNING_KEY,
    );

    expect(result.piiParticipantId).toBe(FIXTURE_PARTICIPANT_ID);
    // The divergence is real on this fixture and not incidental: without this,
    // the assertion above would also pass on an implementation that returned
    // `actor`, since the default fixture sets both members to the same id.
    expect(result.envelope.actor).toBeNull();
    // And it is the value that was actually bound into the AEAD's associated
    // data, not a second reading of the input taken after the encrypt.
    expect(result.piiParticipantId).toBe(encryptor.lastRequest?.participantId);

    // AND IT REACHES THE SIGNED BYTES, which is the half a returned field cannot
    // stand in for. `PiiEventWriteResult.piiParticipantId` is a value T3.1 reads
    // to fill a column; only the canonical text is what `daemon_signature`
    // commits to, so only this assertion distinguishes a stamp an at-rest
    // adversary can rewrite from one they cannot.
    //
    // ON THIS FIXTURE SPECIFICALLY, because the divergence has to be visible
    // INSIDE the bytes: a verifier reading them finds `"actor":null` beside a
    // populated stamp, so the two are demonstrably different members carrying
    // different values. The leak test above pins the same wire spelling on the
    // default fixture, where `actor` and the stamp coincide — and on that
    // fixture alone, a projection that read `actor` would produce byte-identical
    // output and pass. This one closes that.
    const canonicalText: string = utf8Decoder.decode(canonicalizeEvent(result.envelope));
    expect(canonicalText).toContain(
      `"${PII_PARTICIPANT_ID_PAYLOAD_KEY}":"${FIXTURE_PARTICIPANT_ID}"`,
    );
    expect(canonicalText).toContain('"actor":null');
    // The read-side predicate names the value T3.1's column will have to hold,
    // and the second line is the same divergence read from the other end: a T3.1
    // that filled the column from `actor` would land a row this predicate reports
    // UNBOUND. Called directly, because it is deliberately not wired into
    // `canonicalizeEvent` or `verifyRow` (the I-006-2-10 pattern — a Phase-2
    // module must not emit a T4.1 verdict), so it fires nowhere on this path.
    expect(isPiiOwnerStampBound(FIXTURE_PARTICIPANT_ID, result.envelope.payload)).toBe(true);
    expect(isPiiOwnerStampBound(result.envelope.actor, result.envelope.payload)).toBe(false);
  });

  it("copies the encryptor's ciphertext, so a reused scratch buffer cannot break the digest", async () => {
    // CP-006-1 fixes a return TYPE and no buffer lifetime, so an implementation
    // may hand back scratch memory and overwrite it on its next call. The digest
    // and the signature commit to the bytes as of the encrypt; if the returned
    // array were the encryptor's own, a later write through it would leave the
    // caller persisting different bytes into `pii_payload` — an honest row that
    // fails verification forever, defective in a module no verifier ever reads.
    const encryptorWithScratch = new ScratchBufferPiiEncryptor(48);
    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput(),
      GENESIS_PREV_HASH,
      encryptorWithScratch,
      DAEMON_SIGNING_KEY,
    );
    const digestAtSigning: unknown = result.envelope.payload[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY];

    encryptorWithScratch.overwriteScratch(0x5a);

    // THE INVARIANT: the ciphertext the caller holds still hashes to the digest
    // the signature commits to. This is the assertion that fails if the copy is
    // ever reverted to an alias.
    expect(bytesToHex(blake3(result.piiPayload))).toBe(digestAtSigning);

    // The structural reason it holds, pinned separately — the assertion above
    // would keep passing under an alias in any test that happened not to mutate,
    // so ownership is stated directly rather than inferred from agreement.
    expect(result.piiPayload).not.toBe(encryptorWithScratch.scratch);
    expect(result.piiPayload).not.toEqual(encryptorWithScratch.scratch);
    // A copy, not a re-encryption: the bytes are the ones the encryptor returned.
    expect(result.piiPayload).toEqual(new Uint8Array(48).fill(0xa5));
  });
});

// ==========================================================================
// LEG 2 — the signature survives the shred (`Spec-022 §Signature Safety Under
// Shred`, I-006-2-05).
// ==========================================================================

describe("Plan-006 T2.5 leg 2 — the audit surface is invariant across a Path-1 key deletion", () => {
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

  it("verifies before the shred, with the ciphertext and its custody key both present", () => {
    // The precondition for the whole leg: if this failed, the post-shred
    // `valid: true` below would prove nothing about the shred. The custody row
    // is part of it — a shred against a participant holding no key deletes
    // nothing, and every assertion downstream would pass anyway.
    const storedBeforeShred: StoredSessionEventRow = readStoredRow(database);
    expect(storedBeforeShred.pii_payload).not.toBeNull();
    expect(Uint8Array.from(storedBeforeShred.pii_payload ?? [])).toEqual(
      Uint8Array.from(writeResult.piiPayload),
    );
    expect(hasParticipantContentKey(database, FIXTURE_PARTICIPANT_ID)).toBe(true);
    expect(isStoredCiphertextDigestBound(database)).toBe(true);
    expect(verifyStoredRow(database)).toStrictEqual({ valid: true });
  });

  it("still verifies after the shred, over bytes rebuilt from the surviving columns", () => {
    const ciphertextBeforeShred: Uint8Array | null = readStoredCiphertext(database);
    applyPath1CryptoShred(database, FIXTURE_PARTICIPANT_ID);

    const storedAfterShred: StoredSessionEventRow = readStoredRow(database);
    // The shred actually happened — the key is gone...
    expect(hasParticipantContentKey(database, FIXTURE_PARTICIPANT_ID)).toBe(false);
    // ...and the ciphertext is RETAINED, bytewise unchanged, which is the half
    // of Path 1 a NULLing model gets backwards. It is now undecryptable rather
    // than deleted, and that distinction is the entire content of this leg: the
    // signature commits to a digest of these bytes, so bytes that survived are
    // bytes the signature still describes.
    expect(readStoredCiphertext(database)).toEqual(ciphertextBeforeShred);
    expect(readStoredCiphertext(database)).toEqual(Uint8Array.from(writeResult.piiPayload));
    // ...the ciphertext never appeared inside the signed payload...
    expect(storedAfterShred.payload).not.toContain(bytesToHex(writeResult.piiPayload));
    // ...the digest standing in for it is there, inside `payload`...
    const survivingPayload = JSON.parse(storedAfterShred.payload) as Record<string, unknown>;
    expect(survivingPayload[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe(
      bytesToHex(blake3(writeResult.piiPayload)),
    );
    // ...no plaintext is anywhere in the row...
    expect(storedAfterShred.payload).not.toContain(PII_PLAINTEXT_SENTINEL);
    // ...the retained ciphertext STILL hashes to that signed digest — the
    // conjunct that keeps the verdict below from being a statement about
    // nothing, and the one that separates this row from the NULLed row two
    // cases down...
    expect(isStoredCiphertextDigestBound(database)).toBe(true);
    // ...and the signature still verifies. That is `Spec-022 §Signature Safety
    // Under Shred` in one line.
    expect(verifyStoredRow(database)).toStrictEqual({ valid: true });
  });

  it("goes UNBOUND when the ciphertext column is NULLed instead — the shred's discriminating negative", () => {
    // THE CASE THAT GIVES THE ONE ABOVE ITS TEETH, and the reason this file
    // stopped modelling a shred as a column NULL. Both operations leave
    // `verifyRow` saying `valid: true` — it is handed canonical bytes, three
    // integrity columns and a public key, and `pii_payload` is not among them,
    // so no ciphertext state can move that verdict. If "still verifies" were the
    // whole claim, the two operations would be indistinguishable and the claim
    // would hold for an operation that DESTROYS the evidence.
    //
    // `isCiphertextDigestBound` is what tells them apart, and the split is the
    // point: RETAINED-AND-BOUND after Path 1, UNBOUND after the NULL. A row
    // carrying a signed digest whose subject was deleted at rest has nothing
    // left tying it to the ciphertext it once held — a plain recompute-and-
    // compare never reaches that state, because there is nothing to recompute
    // over. `Spec-006 §Compacted Event Format` reaches the same NULL column
    // LEGITIMATELY by also replacing `payload` with a digest-free stub, which is
    // why the predicate keys on the PAIR and not on the column alone.
    nullPiiPayloadColumn(database);

    expect(readStoredCiphertext(database)).toBeNull();
    // The signature is genuinely untouched. This verdict is correct, and it is
    // exactly why it cannot be the only thing leg 2 checks.
    expect(verifyStoredRow(database)).toStrictEqual({ valid: true });
    // And this is the evidence destruction the green verdict cannot see.
    expect(isStoredCiphertextDigestBound(database)).toBe(false);
  });

  it("does not report signature_placeholder for a shredded GENESIS row", () => {
    applyPath1CryptoShred(database, FIXTURE_PARTICIPANT_ID);

    // This assertion exists because of the exact case `signer.ts`'s stage-2
    // note calls non-obvious: a legitimate genesis row carries an ALL-ZERO
    // `prev_hash` beside a real `row_hash` and a real signature, so it sits one
    // conjunct away from the placeholder fingerprint. Drop the `row_hash`
    // clause from that predicate and every genesis row in the database reports
    // `signature_placeholder` — a build-ordering verdict on a correctly signed
    // row, routed to the wrong on-call. Both preconditions are asserted so this
    // test cannot pass vacuously against a non-genesis fixture.
    const storedChainColumns: SignedRow = toSignedRow(readStoredRow(database));
    expect(Uint8Array.from(storedChainColumns.prevHash)).toEqual(GENESIS_PREV_HASH);
    expect(Uint8Array.from(storedChainColumns.rowHash).every((byte) => byte === 0)).toBe(false);

    // THE BINDING CONJUNCT EVERY OTHER CASE IN THIS LEG CARRIES, and this one
    // was the odd one out. Its subject is the placeholder arm, but it is still a
    // leg-2 case, and leg 2's subject is the binding: `verifyStoredRow` is
    // structurally blind to `pii_payload`, so on its own the verdict below would
    // stay green over a row whose ciphertext had come unbound. Asserting the
    // shred left the row BOUND is what makes "no placeholder verdict" a
    // statement about a genesis row that is still whole.
    expect(isStoredCiphertextDigestBound(database)).toBe(true);

    // `toStrictEqual`, not `toEqual`, for the reason every `RowVerification`
    // assertion in this file uses it: `toEqual` ignores `undefined`-valued
    // properties, so a `{ valid: true, failureMode: undefined }` would pass on
    // a union whose whole purpose is WHICH ARM you landed on. The strict form
    // subsumes the `not.toHaveProperty("failureMode")` this case used to carry
    // alongside it.
    expect(verifyStoredRow(database)).toStrictEqual({ valid: true });
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

    expect(verifyStoredRow(database)).toStrictEqual({
      valid: false,
      failureMode: "signature_placeholder",
    });
  });

  it("survives a shred on a row whose actor is SQL NULL", async () => {
    // `actor` is the canonical set's only nullable member, and storage collapses
    // absent onto null. A rehydrator that maps SQL NULL to `undefined` drops the
    // key from the canonical bytes and breaks an untampered row — so the round
    // trip is pinned rather than assumed. THAT mapping is what this case tests;
    // the shred is the state it is tested in, and it is also the fixture where
    // `actor` and the PII owner diverge, so a row the shred selector must find
    // through its stamp is exactly the row whose `actor` names nobody.
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
      applyPath1CryptoShred(nullActorDatabase, FIXTURE_PARTICIPANT_ID);

      expect(readStoredRow(nullActorDatabase).actor).toBeNull();
      expect(isStoredCiphertextDigestBound(nullActorDatabase)).toBe(true);
      expect(verifyStoredRow(nullActorDatabase)).toStrictEqual({ valid: true });
    } finally {
      nullActorDatabase.close();
    }
  });

  it("shares ONE custody row across a two-event chain, so a second append cannot collide", async () => {
    // THE SHAPE T3.1 PRODUCES AND NOTHING ELSE IN THIS FILE BUILDS: two PII
    // events from the SAME participant, chained. It is worth a case precisely
    // because every other test writes one row into a fresh `:memory:` database,
    // so `participant_keys.participant_id TEXT NOT NULL PRIMARY KEY` is never
    // approached and their passing says nothing about it. A provisioning helper
    // that INSERTed unconditionally would throw `SQLITE_CONSTRAINT_PRIMARYKEY`
    // here — from inside {@link insertSignedPiiRow}, where it would read as a
    // `session_events` defect rather than a custody one.
    //
    // ONE KEY PER PARTICIPANT IS THE MECHANISM, not an optimization: both rows
    // seal under the same content key, which is what makes a single DELETE erase
    // the participant's whole history instead of one row of it.
    //
    // Its own database because leg 2's shared fixture is single-row by
    // construction — {@link readStoredRow} and {@link nullPiiPayloadColumn} both
    // assume exactly one row and would misreport against two.
    const chainDatabase: DatabaseType = openDatabase(":memory:");
    try {
      const firstEvent: PiiEventWriteResult = await writeEventWithPii(
        buildPiiCarryingEventInput(),
        GENESIS_PREV_HASH,
        new DeterministicTestPiiEncryptor(),
        DAEMON_SIGNING_KEY,
      );
      insertSignedPiiRow(chainDatabase, firstEvent);

      const secondEvent: PiiEventWriteResult = await writeEventWithPii(
        buildPiiCarryingEventInput({ id: "01960b3c-e1d0-7a41-b2c9-5f8e37d6a205", sequence: 1 }),
        firstEvent.signedRow.rowHash,
        new DeterministicTestPiiEncryptor(),
        DAEMON_SIGNING_KEY,
      );
      // The append that a bare INSERT made impossible. Asserted as a non-throw
      // ahead of the counts, because a throw here would abort them unread.
      expect(() => {
        insertSignedPiiRow(chainDatabase, secondEvent);
      }).not.toThrow();

      expect(countRows(chainDatabase, "session_events")).toBe(2);
      expect(countRows(chainDatabase, "participant_keys")).toBe(1);

      // AND ONE DELETE STRANDS BOTH CIPHERTEXTS — the property the shared key
      // buys, and the reason Path 1 needs no per-row work. Run inline rather than
      // through {@link applyPath1CryptoShred}, whose ciphertext assertion reads a
      // single row; the counts here are what that helper cannot express.
      const deletion = chainDatabase
        .prepare("DELETE FROM participant_keys WHERE participant_id = ?")
        .run(FIXTURE_PARTICIPANT_ID);
      expect(deletion.changes).toBe(1);
      expect(hasParticipantContentKey(chainDatabase, FIXTURE_PARTICIPANT_ID)).toBe(false);
      // Both event rows survive the erasure intact, which is the whole of what
      // Path 1 does to `session_events`: nothing.
      expect(countRows(chainDatabase, "session_events")).toBe(2);
    } finally {
      chainDatabase.close();
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
      applyPath1CryptoShred(uncorrelatedDatabase, FIXTURE_PARTICIPANT_ID);

      const stored: StoredSessionEventRow = readStoredRow(uncorrelatedDatabase);
      expect(stored.correlation_id).toBeNull();
      expect(stored.causation_id).toBeNull();
      expect(isStoredCiphertextDigestBound(uncorrelatedDatabase)).toBe(true);
      expect(verifyStoredRow(uncorrelatedDatabase)).toStrictEqual({ valid: true });
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
 * The canonical eleven as a RUNTIME value that cannot drift from
 * `keyof EventEnvelope`.
 *
 * The `-?` mapped annotation is the same drift guard `canonicalizeEvent`'s
 * projection literal uses, and it pins both directions at compile time: a
 * twelfth contracts member leaves this literal incomplete (TS2741) and a member
 * contracts drops makes it excessive (TS2353). So the key set below is a
 * PROJECTION of the contracts type rather than a hand-maintained list that
 * happens to agree with it today — which is what lets the tamper matrix be
 * checked against it instead of against a number.
 */
const CANONICAL_ENVELOPE_MEMBERS: { readonly [MemberName in keyof EventEnvelope]-?: true } = {
  id: true,
  sessionId: true,
  sequence: true,
  occurredAt: true,
  category: true,
  type: true,
  actor: true,
  payload: true,
  correlationId: true,
  causationId: true,
  version: true,
};

/** Sorted for the both-direction set comparisons below. */
const CANONICAL_ENVELOPE_MEMBER_NAMES: ReadonlyArray<string> = Object.keys(
  CANONICAL_ENVELOPE_MEMBERS,
).sort();

/**
 * The eleven canonical envelope members, each paired with the SQL that tampers
 * the column carrying it. Exhaustive on purpose (see the header): a verifier
 * that reads ten of eleven members passes any smaller matrix.
 *
 * FIFTEEN ROWS OVER ELEVEN MEMBERS — `payload` carries five, because four cases
 * attack a value INSIDE the member rather than the member itself. The count is
 * ten single-member rows (`id`, `sessionId`, `sequence`, `occurredAt`,
 * `category`, `type`, `actor`, `correlationId`, `causationId`, `version`) plus
 * those five: one ordinary non-PII payload member, then SUBSTITUTION and REMOVAL
 * for each of the two PII control values the signature carries —
 * `pii_ciphertext_digest` (the ciphertext's only integrity binding) and
 * `pii_participant_id` (the Path-1 shred selector). Both control values need
 * both attacks for the same reason: a verifier comparing a member only where it
 * is PRESENT waves the deletion straight through.
 *
 * ELEVEN IS THE ENVELOPE'S MEMBER COUNT AND DOES NOT MOVE WITH THIS MATRIX. The
 * PII stamp landed inside `payload`, not beside it — no envelope member was
 * added (`Spec-006 §Canonical Serialization Rules`' canonical set is unchanged),
 * so what grew is the number of ROWS attacking `payload`, never the member
 * census that {@link CANONICAL_ENVELOPE_MEMBER_NAMES} derives from contracts.
 *
 * `member` is the case LABEL (what `it.each` prints) and is free-form
 * for that reason; `canonicalMember` is the machine-checkable half, typed
 * `keyof EventEnvelope` so a case naming a field the envelope does not have is
 * a compile error rather than a matrix that quietly covers ten members. The
 * exhaustiveness test below compares the `canonicalMember` SET against
 * {@link CANONICAL_ENVELOPE_MEMBER_NAMES}; a label alone could never support
 * that comparison. Each case then diffs the canonical bytes across its OWN
 * tamper and asserts the changed-member set is exactly its `canonicalMember`,
 * so the annotation is checked against the SQL beside it and not only against
 * the member census.
 *
 * Every replacement value is chosen to survive BOTH the `0001-initial.ts` CHECK
 * constraints and `EventEnvelopeSchema`, so each case reaches `verifyRow` and
 * the verdict is the verifier's — a rehydration throw would be a different test
 * failing for a different reason (the characterization block at the end of this
 * leg is where the throwing shapes live).
 *
 * `monotonic_ns` IS ABSENT, AND "IT IS NOT ONE OF THE ELEVEN" IS NOT THE REASON.
 * That answer restates the fact it is asked to justify, and it is the same move
 * ("it is row metadata") that failed for the owner stamp one round ago. Nothing
 * signs `monotonic_ns` — that much is true and is exactly the property the three
 * cases below make dangerous elsewhere — so the question is what a tamper of it
 * makes FALSE. Nothing, and the reason is that it was never an ordering authority
 * a reader could rely on across restarts: its "zero point is unspecified and
 * changes on every daemon restart" (`Spec-015 §Clock Handling`), which also makes
 * it "not a cross-daemon ordering primitive" there. A reader comparing two values
 * of it from different daemon lifetimes is already wrong with no attacker
 * involved. The durable per-session order is `sequence`, which IS one of the
 * eleven, IS signed, and carries `UNIQUE(session_id, sequence)` in
 * `0001-initial.ts` behind it. So no signed artifact and no retained compliance
 * evidence changes truth value when `monotonic_ns` moves — which is precisely
 * what separates it from the three real instances of the unsigned-value class:
 *
 *   1. `occurred_at` — signed, and the one signed column an at-rest respelling
 *      rewrites while verification stays GREEN, because the canonical bytes carry
 *      the NORMALIZED instant and every spelling of that instant verifies.
 *      `isCanonicalOccurredAt` is the binding that closes it.
 *   2. `pii_ciphertext_digest` — evidence destruction that still verifies green,
 *      because `verifyRow` never receives `pii_payload`.
 *      {@link isCiphertextDigestBound} is the binding that closes it.
 *   3. The owner stamp — a falsified Path-1 SELECTOR, which mis-scopes an erasure
 *      and then certifies the mis-scoping: `event.shredded` carries an
 *      `affectedSessionIds` / `piiPayloadsCleared` census and is "retained
 *      indefinitely" (`Spec-022 §Shred Fan-Out`). `isPiiOwnerStampBound` is the
 *      binding that closes it, and the two rows below are its tamper cases.
 */
const CANONICAL_MEMBER_TAMPERS: ReadonlyArray<{
  readonly member: string;
  readonly canonicalMember: keyof EventEnvelope;
  readonly sql: string;
}> = [
  {
    member: "id",
    canonicalMember: "id",
    sql: "UPDATE session_events SET id = '01960b3c-e1d0-7a41-b2c9-000000000000'",
  },
  {
    member: "sessionId",
    canonicalMember: "sessionId",
    sql: "UPDATE session_events SET session_id = '0192f3a4-5b6c-7d8e-9f01-ffffffffffff'",
  },
  {
    member: "sequence",
    canonicalMember: "sequence",
    sql: "UPDATE session_events SET sequence = 1",
  },
  {
    member: "occurredAt",
    canonicalMember: "occurredAt",
    sql: "UPDATE session_events SET occurred_at = '2026-03-04T05:06:07.009Z'",
  },
  {
    member: "category",
    canonicalMember: "category",
    sql: "UPDATE session_events SET category = 'membership_change'",
  },
  {
    member: "type",
    canonicalMember: "type",
    sql: "UPDATE session_events SET type = 'participant.purged'",
  },
  {
    member: "actor",
    canonicalMember: "actor",
    sql: "UPDATE session_events SET actor = 'participant-ffff'",
  },
  {
    member: "payload (non-digest member)",
    canonicalMember: "payload",
    sql: `UPDATE session_events SET payload = json_set(payload, '$.exportFormat', 'csv')`,
  },
  {
    member: `payload.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}`,
    canonicalMember: "payload",
    // The Spec-022 core: swapping the digest for the digest of DIFFERENT
    // ciphertext is how an attacker would try to re-point a shredded row at
    // PII the signer never saw.
    sql: `UPDATE session_events SET payload = json_set(payload, '$.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}', '${bytesToHex(blake3(utf8Encoder.encode("some other ciphertext")))}')`,
  },
  {
    member: `payload.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY} (removed)`,
    canonicalMember: "payload",
    // ABSENCE, which the substitution above cannot cover: a verifier comparing
    // the digest only where the member is PRESENT passes that case and waves
    // this row through. It is also the read side's only way to state the
    // sign-before-embed half of I-006-2-01 — bytes signed before the digest was
    // embedded are indistinguishable at rest from a digest deleted afterwards,
    // and a row carrying neither has nothing tying its signature to the
    // ciphertext still sitting in its `pii_payload` column.
    sql: `UPDATE session_events SET payload = json_remove(payload, '$.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}')`,
  },
  {
    member: `payload.${PII_PARTICIPANT_ID_PAYLOAD_KEY}`,
    canonicalMember: "payload",
    // THE SHRED SELECTOR, ATTACKED. `Spec-022 §Shred Fan-Out` Path 1 matches on
    // the durable participant-id stamp, so repointing it at another participant
    // is how an at-rest adversary makes a row survive the erasure sweep of the
    // person it holds PII about — and lands it in the sweep of someone else,
    // whose own shred then reports a row it has no key for. The stamp is also
    // the AAD's participant half, so a rewritten stamp describes a decrypt no
    // key can perform. Neither failure is visible to any other check in this
    // file: the digest still matches, the ciphertext is untouched, and the
    // chain relinks under any recomputation. Only the signature catches it, and
    // only because the stamp is INSIDE the signed bytes.
    sql: `UPDATE session_events SET payload = json_set(payload, '$.${PII_PARTICIPANT_ID_PAYLOAD_KEY}', 'participant-ffff')`,
  },
  {
    member: `payload.${PII_PARTICIPANT_ID_PAYLOAD_KEY} (removed)`,
    canonicalMember: "payload",
    // ABSENCE, and the sharper of the two: a row with no stamp names no owner,
    // so no participant's Path-1 selector will ever match it and the PII it
    // holds is unreachable by every future erasure request — permanently, and
    // silently. It is the at-rest spelling of the defect refusal 7 refuses at
    // write time (see "refuses an empty piiParticipantId BEFORE spending the
    // nonce"), which is why both sides are pinned.
    sql: `UPDATE session_events SET payload = json_remove(payload, '$.${PII_PARTICIPANT_ID_PAYLOAD_KEY}')`,
  },
  {
    member: "correlationId",
    canonicalMember: "correlationId",
    sql: "UPDATE session_events SET correlation_id = 'correlation-ffff'",
  },
  {
    member: "causationId",
    canonicalMember: "causationId",
    sql: "UPDATE session_events SET causation_id = 'causation-ffff'",
  },
  // `CHECK(version GLOB '[0-9]*.[0-9]*')` admits this, so the tamper reaches
  // the verifier rather than bouncing off the column constraint.
  {
    member: "version",
    canonicalMember: "version",
    sql: "UPDATE session_events SET version = '2.0'",
  },
];

/**
 * The stored row's canonical members, each mapped to its SERIALIZED value.
 *
 * SERIALIZED RATHER THAN REFERENCED, BECAUSE `payload` IS AN OBJECT. Two reads
 * of the same untampered row rebuild two distinct object identities, so an
 * identity comparison would report `payload` as changed on every case and the
 * attribution below would be worthless. The values come off the same canonical
 * bytes `verifyRow` is handed, through the same read path the rest of this leg
 * uses, so a member that differs here is a member the signature stopped
 * covering.
 */
function readCanonicalMemberSerializations(database: DatabaseType): Record<string, string> {
  const canonicalMembers = JSON.parse(
    utf8Decoder.decode(canonicalizeEvent(rehydrateEnvelope(readStoredRow(database)))),
  ) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(canonicalMembers).map(([memberName, memberValue]) => [
      memberName,
      JSON.stringify(memberValue),
    ]),
  );
}

/**
 * The canonical members whose serialized value differs across a tamper, sorted.
 *
 * PRESENCE IS A DIFFERENCE HERE, NOT ONLY VALUE. `correlationId` /
 * `causationId` are optional and NOT nullable, so {@link rehydrateEnvelope}
 * maps their SQL NULL to `undefined` and `canonicalizeEvent` drops the key
 * rather than emitting it — presence moves with the column. `actor` is optional
 * AND nullable, and its SQL NULL rehydrates to `null`, which canonicalizes to
 * `"actor":null`: on this read path it changes VALUE while staying present.
 * That split is what {@link rehydrateEnvelope} calls the subtlest thing in this
 * file, and conflating the two groups here would mis-describe both.
 *
 * THE UNION BUYS THE AFTER-ONLY MEMBER SPECIFICALLY. A loop over the
 * before-side keys alone already catches a VANISHING member — the key is on the
 * before side, and the after side's `undefined` differs from its serialization.
 * What such a loop cannot visit is a key that did not exist before the tamper:
 * a non-NULL write into a column the fixture left NULL, reachable from the
 * `correlationId: undefined` / `causationId: undefined` fixture leg 2 already
 * builds. Every row in {@link CANONICAL_MEMBER_TAMPERS} today overwrites a
 * non-NULL column with another non-NULL value, so this arm is unexercised by
 * the current matrix; it is here so that a later row writing INTO a NULL column
 * is attributed to the member it brought into the bytes rather than dropped
 * from the diff.
 */
function diffCanonicalMembers(
  canonicalBeforeTamper: Record<string, string>,
  canonicalAfterTamper: Record<string, string>,
): ReadonlyArray<string> {
  return [...new Set([...Object.keys(canonicalBeforeTamper), ...Object.keys(canonicalAfterTamper)])]
    .filter((memberName) => canonicalBeforeTamper[memberName] !== canonicalAfterTamper[memberName])
    .sort();
}

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
    applyPath1CryptoShred(database, FIXTURE_PARTICIPANT_ID);
    // The row is shredded AND verifying AND digest-bound — the state every case
    // below tampers away from. Asserting it here is what makes each failure
    // below attributable to the tamper. The binding conjunct matters because a
    // Path-1 shred retains the ciphertext: these cases attack a row that still
    // HOLDS its (now unreadable) PII, which is the state a real post-shred
    // database is in, not a hollowed-out one.
    expect(hasParticipantContentKey(database, FIXTURE_PARTICIPANT_ID)).toBe(false);
    expect(isStoredCiphertextDigestBound(database)).toBe(true);
    expect(verifyStoredRow(database)).toStrictEqual({ valid: true });
  });

  afterEach(() => {
    database.close();
  });

  it.each(CANONICAL_MEMBER_TAMPERS)(
    "reports hash_mismatch when $member is tampered in the shredded row",
    ({ canonicalMember, sql }) => {
      // WHICH MEMBER THE SQL ACTUALLY MOVED, NOT WHICH ONE THE ROW CLAIMS IT
      // MOVED. Without this, `canonicalMember` is read only by the coverage
      // guard below, and that guard set-compares the ANNOTATIONS — so a row
      // whose `canonicalMember` disagrees with the SQL beside it clears every
      // other check in this file for as long as the annotation SET is left
      // intact. Swapping the SQL between the `actor` and `category` rows leaves
      // it intact: all eleven names are still annotated, `changes === 1` still
      // holds because a row WAS updated, and the verdict is still
      // `hash_mismatch` because SOME canonical member moved — while NEITHER ROW
      // ATTACKS THE MEMBER IT NAMES, which is what stops the annotation being
      // evidence of anything. That is the same ten-of-eleven hole the derived
      // set equality was introduced to close, relocated from WHICH MEMBERS ARE
      // LISTED to WHICH MEMBERS ARE HIT.
      //
      // The capture has to sit HERE rather than in `beforeEach`: that hook ends
      // by asserting the row is shredded and verifying, and this is the state
      // the tamper moves away from.
      const canonicalBeforeTamper: Record<string, string> =
        readCanonicalMemberSerializations(database);

      const result = database.prepare(sql).run();
      expect(result.changes).toBe(1);

      // Sorted-array equality against the ONE-ELEMENT set, in the same register
      // as the coverage guard below and for the same reason: it states both
      // directions at once — the annotated member WAS attacked, and nothing else
      // was collaterally attacked beside it.
      const canonicalAfterTamper: Record<string, string> =
        readCanonicalMemberSerializations(database);
      expect(diffCanonicalMembers(canonicalBeforeTamper, canonicalAfterTamper)).toEqual([
        canonicalMember,
      ]);

      expect(verifyStoredRow(database)).toStrictEqual({
        valid: false,
        failureMode: "hash_mismatch",
      });
    },
  );

  it("attacks every canonical envelope member, and no member the envelope lacks", () => {
    // THE DRIFT GUARD, AND IT IS A SET COMPARISON RATHER THAN A COUNT — the
    // distinction is the whole point. A hand-bumped `toHaveLength(13)` passes on
    // a SAME-SIZE SWAP: rename one case onto a field the envelope no longer has
    // while another member loses its only case, and the count is still 13 while
    // the matrix now covers ten of eleven — exactly the verifier this leg exists
    // to catch. Sorted-array equality states both directions in one assertion:
    // every canonical member attacked (⊇) and no case naming a non-member (⊆).
    // Same register as
    // `packages/contracts/src/__tests__/event-disposition.test.ts`'s
    // registry-vs-census check, which rejects bare size comparisons for this
    // reason.
    const attackedMembers: ReadonlyArray<string> = [
      ...new Set(CANONICAL_MEMBER_TAMPERS.map((tamper) => tamper.canonicalMember)),
    ].sort();
    expect(attackedMembers).toEqual(CANONICAL_ENVELOPE_MEMBER_NAMES);

    // FIXTURE COMPLETENESS, WHICH THE TYPE CANNOT SUPPLY.
    // `CANONICAL_ENVELOPE_MEMBERS` is compile-bound to `keyof EventEnvelope`,
    // but a TYPE says nothing about which members reach the signed BYTES: the
    // three optional ones vanish from the canonical output when absent, so a
    // fixture that omitted `correlationId` would leave that member's tamper case
    // attacking a key the verifier never reads, and the assertion above would
    // stay green. Reading the members back off this suite's actual canonical
    // bytes closes that gap.
    //
    // AND THAT READ IS SPELLED OUT HERE RATHER THAN ROUTED THROUGH
    // `readCanonicalMemberSerializations`. That helper returns member →
    // serialization PAIRS and this assertion wants the key set alone, so calling
    // it here would discard the value half of its record at its own call site.
    // The two spellings run the same chain and so agree by construction — this
    // is NOT a second, independent derivation — but the literal one anchors what
    // THIS assertion reads, so a later change to the helper's path cannot
    // silently retarget a fixture-completeness claim the helper is not party to.
    const serializedMembers: ReadonlyArray<string> = Object.keys(
      JSON.parse(
        utf8Decoder.decode(canonicalizeEvent(rehydrateEnvelope(readStoredRow(database)))),
      ) as Record<string, unknown>,
    ).sort();
    expect(serializedMembers).toEqual(CANONICAL_ENVELOPE_MEMBER_NAMES);

    // The five `payload` rows are NOT interchangeable and the set check above
    // cannot tell them apart — all five report `canonicalMember: "payload"`.
    // Pinning their labels is what stops the four PII-specific cases (Spec-022's
    // digest-substitution core, the shred selector, and each one's absence
    // counterpart) from being deleted behind a still-green `payload` entry.
    expect(
      CANONICAL_MEMBER_TAMPERS.filter((tamper) => tamper.canonicalMember === "payload")
        .map((tamper) => tamper.member)
        .sort(),
    ).toEqual(
      [
        "payload (non-digest member)",
        `payload.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}`,
        `payload.${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY} (removed)`,
        `payload.${PII_PARTICIPANT_ID_PAYLOAD_KEY}`,
        `payload.${PII_PARTICIPANT_ID_PAYLOAD_KEY} (removed)`,
      ].sort(),
    );

    // Labels are what `it.each` prints, so a duplicated one reports as the same
    // test twice and hides which case was lost.
    expect(new Set(CANONICAL_MEMBER_TAMPERS.map((tamper) => tamper.member)).size).toBe(
      CANONICAL_MEMBER_TAMPERS.length,
    );

    // DELIBERATELY NO ROW-COUNT ASSERTION. The three checks above already catch
    // every DROPPED row (a missing member fails the set equality; a missing
    // `payload` case fails the label pin) and every row naming a dead member.
    // What a `toHaveLength(13)` would add is a failure on a legitimately ADDED
    // second case for an already-covered member — coverage growth, not drift —
    // and that false positive is precisely what trains the number to be
    // hand-bumped until it means nothing. The
    // `event-disposition.test.ts` precedent keeps its length pin because it ties
    // to an EXTERNAL plan-table `Count` row; this matrix has no such anchor.
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
      concatenateChainInput(toSignedRow(tamperedRow).prevHash, tamperedCanonical),
    );
    database.prepare("UPDATE session_events SET row_hash = ?").run(Buffer.from(forgedRowHash));

    // Stage 3 now passes on the forged chain digest...
    const refreshedRow: StoredSessionEventRow = readStoredRow(database);
    expect(Uint8Array.from(toSignedRow(refreshedRow).rowHash)).toEqual(forgedRowHash);
    // ...and stage 4 is what catches the row.
    expect(verifyStoredRow(database)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
  });

  it("reports signature_mismatch for a shredded row checked against another daemon's key", () => {
    // The signature is bound to ONE daemon identity. Nothing about the shred
    // loosens that binding — an untampered shredded row must still fail against
    // the wrong public key.
    expect(verifyStoredRow(database, OTHER_DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
  });

  it("reports signature_mismatch when the stored signature itself is flipped", () => {
    const original: StoredSessionEventRow = readStoredRow(database);
    const corruptedSignature = Uint8Array.from(toSignedRow(original).daemonSignature);
    corruptedSignature[0] = (corruptedSignature[0] ?? 0) ^ 0x01;
    database
      .prepare("UPDATE session_events SET daemon_signature = ?")
      .run(Buffer.from(corruptedSignature));

    expect(verifyStoredRow(database)).toStrictEqual({
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

    expect(verifyStoredRow(database)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });

  // ========================================================================
  // THE CHARACTERIZED HOLE — STORED-ROW SHAPES THAT THROW INSTEAD OF
  // RETURNING A VERDICT. CHARACTERIZATION, NOT ENDORSEMENT.
  // ========================================================================
  //
  // Everything above this point is `RowVerification`'s promise KEPT: "a verdict,
  // and never a throw, for every input the ROW itself supplies" — the
  // 32-CHARACTER chain-column case is that promise at its sharpest. This block
  // is the same promise BROKEN, and it is broken as a CLASS rather than at one
  // value, which is why the block is plural.
  //
  // WHY A THROW IS WORSE THAN A WRONG VERDICT. A throw means T4.1's verifier
  // emits no `audit_integrity_failed`, so the poisoned row goes UNREPORTED —
  // and because T4.1 walks a RANGE, one throwing row aborts the walk and
  // suppresses verification of every row after it. An attacker who cannot forge
  // a signature can still write one such row and silence the audit of the whole
  // tail. That escalation — one row's malformed shape into a range-wide blind
  // spot — is why the hole is characterized loudly here instead of left to be
  // rediscovered at T4.1.
  //
  // THREE LAYERS THROW, AND THEY SHARE NO CHOKE POINT. That is the fact T4.1's
  // design has to start from:
  //
  //   1. THE PARSE — `rehydrateEnvelope`'s `EventEnvelopeSchema.parse`, as a
  //      `ZodError`. A `sequence` past `EVENT_ENVELOPE_SEQUENCE_MAX` is the
  //      reachable instance.
  //   2. `normalizeOccurredAt`, INSIDE `canonicalizeEvent` and strictly AFTER a
  //      clean parse. `0001-initial.ts` declares `occurred_at TEXT NOT NULL`
  //      with no format CHECK, and the wire schema is
  //      `z.iso.datetime({ offset: true })` with no `precision` argument and no
  //      year-range narrowing — so a sub-millisecond fraction (guard 2) and an
  //      offset that folds outside the four-digit year (guard 4) both PARSE and
  //      are refused later.
  //   3. `canonicalizeJson`'S GENERIC GUARDS — TWO of them reachable from a
  //      stored row, out of the THREE refusals the entry point now carries, and
  //      the layer is stated over the set rather than over any one member,
  //      because a fix aimed at one leaves the others live. The payload schema is
  //      `z.unknown().superRefine(…).pipe(z.record(z.string(), z.unknown()))`,
  //      which bounds no nesting depth AND requires no Unicode well-formedness.
  //      So a payload nested past `CANONICAL_JSON_MAX_DEPTH` parses cleanly and
  //      `assertWithinCanonicalDepth` refuses it; and a payload carrying an
  //      unpaired UTF-16 surrogate in a string or a KEY parses cleanly too —
  //      `\ud800` rides through the wire text as a six-ASCII-character escape —
  //      and `assertWellFormedStrings` refuses it per RFC 8785 §3.2.2.2.
  //
  //      THE THIRD REFUSAL IS `assertNoToJsonOverride`, AND ITS ABSENCE FROM THIS
  //      BLOCK IS THE FINDING, not an omission. It refuses any value carrying a
  //      callable `toJSON` at any depth — which `canonicalize@3.0.0` would invoke
  //      and serialize INSTEAD of the value — and a stored row cannot supply one:
  //      the read path rebuilds `payload` with `JSON.parse`, whose output holds no
  //      function-valued member at any depth for any input text. The guard is
  //      therefore live on the WRITE path, where a caller can hand over a `Date`
  //      or a class instance, and unsatisfiable from the column.
  //
  //      THE `Buffer`S IN THIS FILE ARE NOT A COUNTEREXAMPLE, and the reason is
  //      the boundary a future reader is most likely to get wrong. Every `Buffer`
  //      here is built for a SQLite BLOB bind — `pii_payload`, the three integrity
  //      columns, the custody blob — so it enters better-sqlite3 BELOW the codec
  //      and the canonicalizer never walks it. That matters because `Buffer` WOULD
  //      be refused if one were ever routed THROUGH the codec:
  //      `Buffer.prototype.toJSON` is real and callable, and it is inherited, so
  //      an own-property check would miss it while the prototype-chain read this
  //      guard performs catches it. If a fixture ever needs a `Buffer` inside a
  //      `payload` or a `piiPayload`, convert it explicitly and pass plain JSON —
  //      routing around the refusal would sign bytes from a tree no guard
  //      inspected. ONE RESIDUAL,
  //      stated rather than glossed: the check is a prototype-chain read (
  //      deliberately — that is the only read that sees `Date.prototype.toJSON`),
  //      so a process that pollutes `Object.prototype.toJSON` makes it fire on
  //      parsed output too. That is a process-global condition, not a byte an
  //      attacker writes into a row, so it falls outside the promise this block
  //      characterizes: "for every input the ROW itself supplies".
  //
  //      ITS POSITION IS A CORRECTNESS CONSTRAINT IN BOTH DIRECTIONS, not a
  //      diagnostic preference, which is why the order is recorded here rather
  //      than left to be inferred. `assertWithinCanonicalDepth` MUST run first —
  //      the `toJSON` walk carries no cycle detection of its own and the depth
  //      ceiling is what reports a cycle as exhaustion — and it MUST run before
  //      `assertWellFormedStrings`, whose verdict describes the bytes that will
  //      actually be serialized only once no `toJSON` can divert them.
  //      `canonicalizeJson` runs exactly that order.
  //
  //      THREE REFUSALS ON THE ENTRY POINT IS NOT THREE CP-006-3 OBLIGATIONS —
  //      the counts are different quantities and conflating them is the error to
  //      avoid. Plan-027 still inherits TWO, by the same reachability argument:
  //      the Spec-024 request bodies it hands this entry point also arrive via
  //      `JSON.parse`, so the `toJSON` predicate is unsatisfiable on them.
  //
  // T4.1'S OBLIGATION, RECORDED HERE BECAUSE THIS IS WHERE IT GETS
  // REDISCOVERED — and stated over the CLASS, because a fix aimed at any single
  // case leaves the others live. WRAP THE WHOLE READ PATH — rehydrate,
  // canonicalize, `verifyRow` — IN ONE `try`, AND MAP ANY THROW TO
  // `hash_mismatch`: the verdict this module already gives every other
  // malformed stored row, because
  // `Spec-006 §Audit Integrity (audit_integrity)`'s enum has no
  // malformed-stored-row arm. A PER-CASE PRE-CHECK IS THE WRONG SHAPE, and the
  // narrower "pre-check `sequence` representability ahead of the parse" this
  // block used to record is the worked example of why: it closes case 1 and
  // leaves cases 2 and 3 throwing. The single `try` is also the only form that
  // STAYS closed as contracts and the canonicalizer gain guards — every future
  // refusal in either module lands inside it by construction, where a census of
  // pre-checks would have to be re-derived on every schema edit.
  //
  // EVERY TEST IN THIS BLOCK IS EXPECTED TO CHANGE WHEN T4.1 LANDS, and its
  // failure is the SIGNAL rather than a regression: swap each throw assertion
  // for the `hash_mismatch` verdict and keep every control exactly as it stands.
  //
  // EACH THROW CASE HAS A PASSING CONTROL ONE STEP AWAY FROM IT. That pairing is
  // not decoration: a throw assertion with no adjacent passing control proves
  // the input is bad, never that the BOUNDARY sits where the case claims. The
  // sequence ceiling, the third fractional digit, an in-range offset fold, and
  // the depth ceiling each get one.
  describe("stored-row shapes that THROW instead of reporting a verdict (T4.1)", () => {
    it("LAYER 1 — the PARSE throws a ZodError when the stored sequence is past the ceiling", () => {
      // The layer boundary here runs the OTHER way from cases 2 and 3: this
      // value never reaches the canonicalizer at all.
      //
      // WHICH LAYER THROWS — the attribution matters more than the assertion.
      // It is `rehydrateEnvelope`'s `EventEnvelopeSchema.parse`, as a
      // `ZodError`: the schema bounds `sequence` at
      // `EVENT_ENVELOPE_SEQUENCE_MAX` and its `.int()` independently bounds the
      // safe-integer range, so the parse refuses the collapsed value before any
      // canonicalization runs. It is NOT `canonicalizer.ts`'s
      // `assertRepresentableSequence`, and that guard is not dead either: it is
      // unreachable from any path that PARSES, and it is the ONLY guard for a
      // caller that builds an envelope literal instead — the shape
      // `SessionService.hydrateRow` already uses, narrowing a
      // `safeIntegers(true)` bigint with `Number(row.sequence)`. So the two
      // guards cover disjoint read paths, and this one — the parsing one — is
      // the path with the throw. The final assertion pins WHICH message
      // escaped, because "it throws" is true of both and only one of them is
      // the layer T4.1 has to route around.
      database.prepare("UPDATE session_events SET sequence = 9007199254740993").run();

      // Genuinely a stored-data shape rather than a caller-constructed one:
      // SQLite's INTEGER is 64-bit and holds the tampered value EXACTLY...
      const storedSequenceText = database
        .prepare("SELECT CAST(sequence AS TEXT) AS stored_sequence FROM session_events")
        .get() as { readonly stored_sequence: string };
      expect(storedSequenceText.stored_sequence).toBe("9007199254740993");
      // ...and the READ is where fidelity is lost, on both read paths: this
      // statement gets the collapsed double straight from better-sqlite3, and
      // the `safeIntegers(true)` route lands on the identical value the moment
      // `Number(...)` narrows the bigint. Neither recovers the stored integer.
      const tamperedRow: StoredSessionEventRow = readStoredRow(database);
      expect(tamperedRow.sequence).toBe(Number(9007199254740993n));
      expect(Number.isSafeInteger(tamperedRow.sequence)).toBe(false);
      // The parse REFUSES this row, which is what makes it layer 1 and what
      // separates it from every case below.
      expect(() => rehydrateEnvelope(tamperedRow)).toThrow();

      const thrown: unknown = captureReadPathThrow(database);
      // A verdict would leave this `undefined`, which is the assertion that
      // fails the day T4.1's single `try` lands.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("ZodError");
      // Positive evidence of the layer, pinned version-tolerantly: Zod issue
      // CODES and wording are its own formatting detail, while the offending
      // member's path is the contract. Without this, a parse failing for an
      // unrelated reason would keep the test green and the characterization
      // would silently drift.
      const zodIssues = (
        thrown as {
          readonly issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey> }>;
        }
      ).issues;
      expect(zodIssues.map((issue) => String(issue.path[0]))).toContain("sequence");
      // `assertRepresentableSequence` throws a plain `Error` carrying this
      // wording, so its ABSENCE is what attributes the failure to the parse.
      expect((thrown as Error).message).not.toContain("canonicalization refused");
    });

    it("CONTROL — still verifies a row minted at the sequence ceiling", async () => {
      // THE CONTROL FOR THE CASE ABOVE, and it is load-bearing: without it that
      // throw is equally consistent with "a large sequence breaks this
      // fixture". `Number.MAX_SAFE_INTEGER` is the largest value the canonical
      // bytes can carry faithfully, and it survives the INTEGER column, the
      // parse, and the canonicalizer untouched — so the boundary sits exactly
      // where the previous test says it does, one integer above.
      //
      // MINTED at the ceiling, never TAMPERED to it. The matrix above rewrites
      // `sequence` precisely BECAUSE that changes the canonical bytes, so an
      // UPDATE here would report `hash_mismatch` and prove nothing about
      // representability.
      //
      // IT CLAIMS NOTHING ABOUT LINKAGE. The fixture keeps `GENESIS_PREV_HASH`
      // at a non-zero sequence, which I-006-2-04's `prev_hash[n] =
      // row_hash[n-1]` would refuse; `verifyRow` is an intra-row check handed
      // no neighbours (its SCOPE note), so that walk is T4.1's and this control
      // is scoped to what `verifyRow` actually decides.
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
        applyPath1CryptoShred(ceilingDatabase, FIXTURE_PARTICIPANT_ID);

        const stored: StoredSessionEventRow = readStoredRow(ceilingDatabase);
        expect(stored.sequence).toBe(Number.MAX_SAFE_INTEGER);
        expect(Number.isSafeInteger(stored.sequence)).toBe(true);
        expect(verifyStoredRow(ceilingDatabase)).toStrictEqual({ valid: true });
      } finally {
        ceilingDatabase.close();
      }
    });

    it("LAYER 2 — normalizeOccurredAt throws on a stored sub-millisecond occurredAt", () => {
      // THE CASE THAT KILLS THE PARSE-LAYER-ONLY FIX. Nothing between the
      // column and the canonicalizer objects to this value: `occurred_at TEXT`
      // carries no format CHECK, and `z.iso.datetime({ offset: true })` takes no
      // `precision` argument, so an arbitrary number of fractional digits
      // parses. `normalizeOccurredAt`'s guard 2 then refuses it, because the
      // canonical form holds exactly three fractional digits and TRUNCATING the
      // fourth would leave `daemon_signature` not committing to the recorded
      // timestamp.
      //
      // The write path already refuses this input at emit time (leg 4's
      // "refuses a non-canonical occurredAt before the encrypt step"). That is
      // the same guard reached from the other side, and it is exactly why the
      // stored form is reachable only by TAMPER — which is the threat model
      // this leg is written against.
      database.prepare("UPDATE session_events SET occurred_at = '2026-03-04T05:06:07.0081Z'").run();

      // THE LAYER BOUNDARY, ASSERTED RATHER THAN ASSUMED: the parse SUCCEEDS
      // and hands back the tampered string verbatim. That single fact is what
      // makes a pre-check sited at the parse boundary insufficient.
      const rehydrated: EventEnvelope = rehydrateEnvelope(readStoredRow(database));
      expect(rehydrated.occurredAt).toBe("2026-03-04T05:06:07.0081Z");

      const thrown: unknown = captureReadPathThrow(database);
      expect(thrown).toBeInstanceOf(Error);
      // A plain `Error`, NOT a `ZodError` — the discriminator between this
      // layer and layer 1, and the reason both assertions are here.
      expect((thrown as Error).name).toBe("Error");
      expect((thrown as Error).message).toContain("sub-millisecond precision");
    });

    it("CONTROL — still verifies when the stored occurredAt gains a trailing-zero digit", () => {
      // THE BOUNDARY CONTROL FOR THE CASE ABOVE, and sharper than an
      // exactly-three-digit control would be: three digits is the FIXTURE, whose
      // clean verification `beforeEach` already asserts. This value carries a
      // FOURTH digit and still verifies, because a zero past the third is pure
      // notation — it folds away instant-preserved onto the identical canonical
      // string the row was signed over. So the refusal above is attributable to
      // sub-millisecond TIME specifically: not to digit COUNT, and not to the
      // column having been rewritten at all (the tamper matrix's own
      // `occurredAt` case already shows a rewrite producing a VERDICT).
      //
      // It is also the read side of the canonicalizer's many-to-one note, and
      // that note calls this a documented RESIDUAL rather than a win:
      // `daemon_signature` commits to the INSTANT, never to the bytes in
      // `session_events.occurred_at`, so an at-rest attacker can respell the
      // column and keep verification green while dropping the row out of every
      // lexical date-range scan. Catching that is not `verifyRow`'s job — it is
      // handed one row and decides hash and signature, and BOTH are genuinely
      // intact here, which is why the verdict below stays `valid: true` and must.
      // Nor does the append path close it, and reading it as the mitigation is
      // the non-sequitur worth naming: persisting the NORMALIZED string fixes the
      // column's DEFAULT state and binds nobody who writes to that column
      // AFTERWARDS — which is the entire definition of this adversary. The read
      // side is where it is caught, by `isCanonicalOccurredAt` (see
      // `canonicalizer.ts`), which rejects this exact string; composed with a
      // green verdict it says the stored bytes ARE NOT the signed bytes, which
      // neither check says on its own. T4.1's range-walk is its consumer.
      database.prepare("UPDATE session_events SET occurred_at = '2026-03-04T05:06:07.0080Z'").run();
      expect(readStoredRow(database).occurred_at).toBe("2026-03-04T05:06:07.0080Z");

      expect(verifyStoredRow(database)).toStrictEqual({ valid: true });
    });

    it("LAYER 2 — normalizeOccurredAt throws when the stored occurredAt folds out of range", () => {
      // THE SAME LAYER THROUGH A DIFFERENT GUARD, and it earns its own case
      // because nothing about the input resembles the one above: no fractional
      // digits at all, and the refusal comes from guard 4 rather than guard 2.
      // `0000-01-01T00:00:00+05:00` is wire-legal (the schema's `\d{4}` year
      // admits `0000`; `{ offset: true }` admits `+05:00`) and names a real
      // instant — but folding the offset to UTC lands in year −1, which
      // `toISOString()` renders `-000001-12-31T19:00:00.000Z`. The instant
      // survived the fold; the canonical `YYYY-MM-DDTHH:MM:SS.sssZ` form simply
      // cannot spell it, so the canonicalizer refuses rather than sign a shape
      // the spec does not define.
      //
      // Two guards from ONE module reaching this block is the load-bearing
      // observation, not a duplicate case: it is the direct evidence that
      // enumerating throw sites does not converge, and therefore that T4.1 must
      // catch rather than pre-check.
      database.prepare("UPDATE session_events SET occurred_at = '0000-01-01T00:00:00+05:00'").run();

      const rehydrated: EventEnvelope = rehydrateEnvelope(readStoredRow(database));
      expect(rehydrated.occurredAt).toBe("0000-01-01T00:00:00+05:00");

      const thrown: unknown = captureReadPathThrow(database);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("Error");
      expect((thrown as Error).message).toContain("does not fold into the canonical form");
      // NOT the sub-millisecond guard — the two share a layer and a module, so
      // without this the case above could be re-run here and nothing would
      // notice.
      expect((thrown as Error).message).not.toContain("sub-millisecond precision");
    });

    it("CONTROL — still verifies when the stored occurredAt is respelled with an in-range offset", () => {
      // THE BOUNDARY CONTROL FOR GUARD 4: a numeric offset is not what guard 4
      // refuses — landing OUTSIDE the four-digit-year range is.
      // `2026-03-04T00:06:07.008-05:00` folds to exactly the signed instant
      // `2026-03-04T05:06:07.008Z`, so the offset arm is exercised end to end
      // and the row still verifies.
      //
      // IT IS ALSO THE SHARPEST FORM OF THE RESPELLING RESIDUAL the control two
      // cases up describes, which is why the pointer is repeated rather than
      // cross-referenced: the trailing-zero case moves one notational digit,
      // while this UPDATE rewrites the stored HOUR from `05` to `00` and still
      // verifies — because the hour digits are not what `daemon_signature`
      // commits to. Lexically the row now sorts and compares as if it happened at
      // 00:06, so any `ORDER BY occurred_at` misplaces it and any window narrower
      // than the day (`BETWEEN '2026-03-04T05:00:00.000Z' AND …`) drops it. The
      // day survives only because `-05:00` was the offset chosen; `-10:00` names
      // the same instant on 2026-03-03 and moves the date too. The green verdict
      // below is correct and stays — `verifyRow` decides hash and signature, both
      // intact. `isCanonicalOccurredAt` (see `canonicalizer.ts`) is the read-side
      // check that rejects this spelling, and T4.1's range-walk is where the two
      // compose into a verdict.
      database
        .prepare("UPDATE session_events SET occurred_at = '2026-03-04T00:06:07.008-05:00'")
        .run();
      expect(readStoredRow(database).occurred_at).toBe("2026-03-04T00:06:07.008-05:00");

      expect(verifyStoredRow(database)).toStrictEqual({ valid: true });
    });

    it("LAYER 3 — the canonicalizer's depth ceiling throws on an over-deep stored payload", () => {
      // THE THIRD LAYER, AND THE ONLY ONE WHOSE THROW IS NOT ENVELOPE-SPECIFIC:
      // it comes from `canonicalizeJson`, the generic entry point CP-006-3 also
      // hands untrusted Spec-024 request bodies. The payload schema bounds NO
      // nesting depth — it is `z.unknown().superRefine(…).pipe(z.record(…))` —
      // so this row rehydrates perfectly and dies one call later, in
      // `assertWithinCanonicalDepth`. The ceiling exists because
      // `canonicalize@3.0.0` recurses once per level, making unbounded nesting a
      // stack-overflow denial of service.
      //
      // The tamper writes RAW JSON rather than going through `json_set`: the
      // column is `payload TEXT NOT NULL` with no JSON-validity CHECK, and the
      // shape wanted here is a whole tree, not an edit to one path.
      database
        .prepare("UPDATE session_events SET payload = ?")
        .run(JSON.stringify(buildPayloadNestedToCanonicalDepth(CANONICAL_JSON_MAX_DEPTH + 1)));

      // Parse clean, as with layer 2 — stated as an assertion because it is the
      // claim, not the setup.
      const rehydrated: EventEnvelope = rehydrateEnvelope(readStoredRow(database));
      expect(rehydrated.payload).toStrictEqual(
        buildPayloadNestedToCanonicalDepth(CANONICAL_JSON_MAX_DEPTH + 1),
      );

      const thrown: unknown = captureReadPathThrow(database);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("Error");
      expect((thrown as Error).message).toContain(
        `nests containers deeper than ${String(CANONICAL_JSON_MAX_DEPTH)} levels`,
      );
    });

    it("CONTROL — still verifies a row minted with a payload AT the depth ceiling", async () => {
      // THE BOUNDARY CONTROL FOR LAYER 3, and it pins the ceiling's VALUE as
      // well as its existence: a payload one level shallower than the throwing
      // one survives the write path, the column, the parse, and the
      // canonicalizer, and verifies. Move `CANONICAL_JSON_MAX_DEPTH` in
      // `canonicalizer.ts` without touching the local restatement and exactly
      // one of this pair fails.
      //
      // MINTED, not tampered, for the sequence-ceiling control's reason: an
      // UPDATE would change the canonical bytes and report `hash_mismatch`,
      // which says nothing about whether the depth was serializable. Minting is
      // also the stronger claim — it proves the WRITE path accepts the ceiling
      // depth too, so the two paths agree on the boundary.
      const ceilingDatabase: DatabaseType = openDatabase(":memory:");
      try {
        insertSignedPiiRow(
          ceilingDatabase,
          await writeEventWithPii(
            buildPiiCarryingEventInput({
              payload: buildPayloadNestedToCanonicalDepth(CANONICAL_JSON_MAX_DEPTH),
            }),
            GENESIS_PREV_HASH,
            new DeterministicTestPiiEncryptor(),
            DAEMON_SIGNING_KEY,
          ),
        );
        applyPath1CryptoShred(ceilingDatabase, FIXTURE_PARTICIPANT_ID);

        expect(verifyStoredRow(ceilingDatabase)).toStrictEqual({ valid: true });
      } finally {
        ceilingDatabase.close();
      }
    });
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

  it("refuses a payload that already carries the OWNER STAMP, BEFORE spending the nonce", async () => {
    // Refusal 2's second arm, and it answers for a different thing than the
    // digest arm one step above. A stale digest is a claim about BYTES; a
    // caller-supplied stamp is a claim about WHOSE data the row holds — and
    // since the embed step projects `input.piiParticipantId` into this member so
    // the signature binds it, a pre-seeded value would be SIGNED IN PLACE of the
    // projection. That is the signed-but-unchecked hole the projection exists to
    // close, reopened from the input side: the row would carry a signature
    // vouching for an owner nothing checked, and `isPiiOwnerStampBound` would
    // then report it divergent against whatever T3.1 wrote into the column.
    //
    // The forged value is a DIFFERENT participant from the fixture's, which is
    // the attack rather than a duplicate: refusing only a value that disagrees
    // with `piiParticipantId` would leave a caller free to pre-seed the matching
    // one and have the codec silently accept a member it must be the sole
    // producer of.
    const encryptor = new DeterministicTestPiiEncryptor();
    const forgedInput: PiiCarryingEventInput = buildPiiCarryingEventInput({
      payload: {
        exportFormat: "json",
        [PII_PARTICIPANT_ID_PAYLOAD_KEY]: "participant-ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
    });

    await expect(
      writeEventWithPii(forgedInput, GENESIS_PREV_HASH, encryptor, DAEMON_SIGNING_KEY),
    ).rejects.toThrow(/refuses an event whose payload already carries pii_participant_id/);

    // Same order assertion as the digest arm, for the same reason: a refusal
    // that lands after the encrypt has already burnt a nonce on a write the
    // codec then abandons.
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("reports the STAMP refusal for an input defective in both the stamp and prev_hash", async () => {
    // THE OBSERVABLE ORDER, pinned because the stamp arm MOVED it. The arm sits
    // inside refusal 2, so it now answers first for every input that is also
    // defective at refusals 3-7 — this pairing used to report the prev_hash
    // refusal (refusal 5) and now reports the stamp. Without this case the
    // reordering is a claim the implementation comment makes and nothing checks.
    //
    // Reporting the EARLIER defect is the right answer, not merely the observed
    // one: refusals run cheapest-and-most-structural first, and a caller handed
    // "your prev_hash is the wrong length" would fix the prev_hash and hit the
    // stamp refusal on the next call anyway.
    const encryptor = new DeterministicTestPiiEncryptor();
    const doublyDefectiveInput: PiiCarryingEventInput = buildPiiCarryingEventInput({
      payload: {
        exportFormat: "json",
        [PII_PARTICIPANT_ID_PAYLOAD_KEY]: "participant-ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
    });

    await expect(
      writeEventWithPii(doublyDefectiveInput, new Uint8Array(31), encryptor, DAEMON_SIGNING_KEY),
    ).rejects.toThrow(/refuses an event whose payload already carries pii_participant_id/);
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
    // The OTHER direction of the ordering contract: this refusal legitimately
    // costs a nonce, because there is no value to judge until the encryptor has
    // run. Pinned as 1 rather than left unasserted so the encrypt-then-throw
    // class is a documented member of the contract and not an omission.
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses a prev_hash that is not 32 bytes BEFORE spending the nonce", async () => {
    // HOISTED out of T2.2 in the Phase-D fix round, and the reason is the call
    // site: T3.1 supplies this argument by reading the previous row's
    // `row_hash` back out of SQLite, and a `BLOB` column can hand back a JS
    // string. A wrong-width link hashes happily and produces an UNTAMPERED row
    // that can never verify — the failure mode with no recovery path, since the
    // signature is over bytes no verifier can reconstruct. `signRow` still
    // refuses it, but only after the nonce is spent, and this codec is
    // `manual_reconcile_only`.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput(),
        new Uint8Array(31),
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/writeEventWithPii requires a 32-byte Uint8Array prev_hash/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a 32-CHARACTER string prev_hash before spending the nonce", async () => {
    // BYTE-NESS, not just width — the conjunction `signRow` documents and the
    // hoisted copy reproduces. 32 characters clear a bare length check and then
    // coerce to near-zero bytes through `TypedArray.prototype.set`, which is the
    // silent spelling of the same doomed row. It is also exactly what a `BLOB`
    // column hands back once anything with write access leaves TEXT in it.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput(),
        "0".repeat(32) as unknown as Uint8Array,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/received a non-Uint8Array value of type string/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a daemon signing key that is not 32 bytes BEFORE spending the nonce", async () => {
    // HOISTED OUT OF A LIBRARY GUARD RATHER THAN A SIBLING MODULE'S, which is
    // what makes this the last refusal to move: `signRow` guards `prevHash` and
    // NOTHING ELSE, so an ill-shaped key travelled un-inspected from the
    // parameter all the way down to `ed25519.sign`'s `abytes(key, 32)` at recipe
    // step 6. The throw was always correct and the TIMING never was — it landed
    // past the encrypt, and on a `manual_reconcile_only` codec a burnt nonce is
    // a half-built commitment an operator has to reconcile by hand. `abytes`
    // still runs and stays authoritative.
    //
    // REACHABLE ONLY THROUGH A CAST, WHICH IS THE POINT RATHER THAN AN
    // OBJECTION. `Ed25519PrivateKey` is a compile-time brand with exactly one
    // mint site in the workspace (T2.7's `signing-key-source.ts`, which already
    // validates byte-ness and width), so a mis-shaped key reaching production
    // arrived through precisely this assertion at a custody or routing site that
    // went around that mint. The cast here is this suite standing in for T2.7,
    // the same licence the key-material block at the top of the file documents.
    const truncatedDaemonSigningKey: Ed25519PrivateKey = new Uint8Array(31) as Ed25519PrivateKey;
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput(),
        GENESIS_PREV_HASH,
        encryptor,
        truncatedDaemonSigningKey,
      ),
    ).rejects.toThrow(
      /writeEventWithPii requires a 32-byte Uint8Array daemon signing key per RFC 8032 §5.1.5; received 31 bytes/,
    );
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a 32-CHARACTER string daemon signing key before spending the nonce", async () => {
    // BYTE-NESS, NOT WIDTH — the guard's other conjunct, and the one a bare
    // length check silently admits: 32 characters give `.length === 32`, so
    // width alone says yes and the value goes on to `abytes`, which says no for
    // a reason a width-only message would never name. Pinned separately from the
    // 31-byte case because a single test cannot distinguish the two conjuncts,
    // and the `received ...` clause each case asserts is what keeps them apart.
    //
    // The `as unknown` step is not test scaffolding — it is the shape of the
    // real bug. A key that round-trips through TEXT (a keystore column, an
    // environment variable, a JSON boundary) arrives as a `string` and has to be
    // asserted through `unknown` to reach this parameter at all, which is
    // exactly what a routing site that skipped T2.7's mint would have to write.
    const thirtyTwoCharacterDaemonSigningKey: Ed25519PrivateKey = "0".repeat(
      32,
    ) as unknown as Ed25519PrivateKey;
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput(),
        GENESIS_PREV_HASH,
        encryptor,
        thirtyTwoCharacterDaemonSigningKey,
      ),
    ).rejects.toThrow(
      /daemon signing key per RFC 8032 §5.1.5; received a non-Uint8Array value of type string/,
    );
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("reports the PREV_HASH refusal for an input defective in both prev_hash and the signing key", async () => {
    // Refusal order is observable, and hoisting the key check ahead of the
    // encrypt must not ALSO promote it past a refusal that already preceded it.
    // Before the hoist it fired dead last of every refusal on this path, being
    // the deepest call on the sign path, so it belongs last among the
    // pre-encrypt refusals — otherwise one doubly-defective append changes which
    // bug the operator is told about, for a change that was supposed to move
    // only the TIMING of a refusal and never its identity.
    //
    // Both defects are spelled as 31 bytes deliberately: the two messages then
    // differ only in the member they name, so the assertion below discriminates
    // on the guard that fired and on nothing else.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput(),
        new Uint8Array(31),
        encryptor,
        new Uint8Array(31) as Ed25519PrivateKey,
      ),
    ).rejects.toThrow(/writeEventWithPii requires a 32-byte Uint8Array prev_hash/);
    expect(encryptor.encryptCallCount).toBe(0);

    // THE OVER-REFUSAL CONTROL FOR ALL THREE KEY CASES IS ALREADY IN THIS FILE
    // and is deliberately not duplicated here: "still admits a valid input at
    // the sequence ceiling" hands this codec a valid `DAEMON_SIGNING_KEY` and
    // pins `encryptCallCount` at 1, as does every write in legs 1 and 2. A
    // refusal 6 that refused EVERY key — the degenerate implementation the three
    // cases above would otherwise all pass against — turns that control and both
    // of those legs red.
  });

  it("refuses a NaN sequence before the encrypt step", async () => {
    // HOISTED out of T2.1's `assertRepresentableSequence`. `Number.isSafeInteger`
    // is the predicate on both sides, and it is total, so the early copy cannot
    // disagree with the late one — `NaN` is refused here rather than one stage
    // past the point where the nonce is gone.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ sequence: Number.NaN }),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/writeEventWithPii refuses sequence NaN/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a sequence past the safe-integer ceiling before the encrypt step", async () => {
    // The collision case the guard actually exists for, as distinct from `NaN`:
    // `9007199254740993` collapses onto `9007199254740992`, so two different
    // events would canonicalize to identical bytes and share a `row_hash`. The
    // interpolated value in the message is already the COLLAPSED one, which is
    // the failure made visible rather than a reporting defect.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ sequence: Number.MAX_SAFE_INTEGER + 2 }),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/writeEventWithPii refuses sequence 9007199254740992/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("reports the SEQUENCE refusal for an input defective in both sequence and occurredAt", async () => {
    // Refusal order is observable, and the hoisted sequence guard is placed
    // ahead of `normalizeOccurredAt` on purpose: `canonicalizeEvent`'s own
    // REFUSAL ORDER note fixes that precedence, so the PII write path and the
    // plain one must not answer differently for one doubly-defective row. Before
    // the hoist this input reported the timestamp refusal on this path and the
    // sequence refusal on the plain one.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({
          sequence: Number.NaN,
          occurredAt: "2026-03-04T05:06:07.0081Z",
        }),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/writeEventWithPii refuses sequence NaN/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("still admits a valid input at the sequence ceiling (over-refusal control)", async () => {
    // THE CONTROL FOR THE TWO CASES ABOVE. A guard that refused everything would
    // satisfy them both, so the boundary is pinned from the accepting side too:
    // `Number.MAX_SAFE_INTEGER` is representable, must pass, and must reach the
    // encryptor exactly once.
    const encryptor = new DeterministicTestPiiEncryptor();

    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput({ sequence: Number.MAX_SAFE_INTEGER }),
      GENESIS_PREV_HASH,
      encryptor,
      DAEMON_SIGNING_KEY,
    );

    expect(result.envelope.sequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses an empty piiParticipantId BEFORE spending the nonce", async () => {
    // REFUSAL 7, and the only guard on this path that fronts nothing: no later
    // stage re-checks this value. `signRow` never sees it, step 5 keeps it out
    // of the canonical bytes by design, and the one component that consumes it
    // is across CP-006-1. So the failure it refuses is invisible to every other
    // check here — the digest agrees, the signature verifies, the chain links,
    // and the row holds PII sealed against an AAD no decrypt can rebuild while
    // being unreachable by the `Spec-022 §Shred Fan-Out` Path-1 selector that
    // matches on this stamp.
    //
    // An EMPTY string is the case with no type-system defence at all: it
    // satisfies `PiiCarryingEventInput` completely and names no key holder.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ piiParticipantId: "" }),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/requires a non-empty piiParticipantId/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a non-string piiParticipantId before spending the nonce", async () => {
    // The other half of the predicate, reachable the same way refusal 6's is:
    // through a cast or an untyped boundary, since the input type declares the
    // member a required `string`. The message reports a TYPE and never the
    // value.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ piiParticipantId: null as unknown as string }),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/received a non-string value of type object/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("still admits an unusual but well-shaped piiParticipantId (over-refusal control)", async () => {
    // THE CONTROL FOR THE TWO CASES ABOVE, and it discriminates more than a
    // refuses-everything guard: a one-character id passes, because refusal 7 is
    // a SHAPE check and nothing more. Whether `participant_keys` actually holds
    // a row for an id is answerable only across CP-006-1, inside a module this
    // one neither owns nor imports — a well-shaped id naming no key holder is
    // the encryptor's verdict to give, not this guard's.
    const encryptor = new DeterministicTestPiiEncryptor();

    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput({ piiParticipantId: "x" }),
      GENESIS_PREV_HASH,
      encryptor,
      DAEMON_SIGNING_KEY,
    );

    expect(encryptor.encryptCallCount).toBe(1);
    expect(encryptor.lastRequest?.participantId).toBe("x");
    expect(result.piiParticipantId).toBe("x");
  });

  it("reports the PREV_HASH refusal for an input defective in both prev_hash and piiParticipantId", async () => {
    // Refusal 7 was added LAST of the pre-encrypt guards so that introducing it
    // reordered nothing already shipped, and refusal order is observable — the
    // first to fire is the only one the caller sees. This is the assertion that
    // claim rests on rather than the docstring's reasoning: a doubly-defective
    // append must still report the bug it reported before the guard existed.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ piiParticipantId: "" }),
        new Uint8Array(31),
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/writeEventWithPii requires a 32-byte Uint8Array prev_hash/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses an over-deep payload only AFTER the encrypt, and is off by one from a standalone walk", async () => {
    // THE NARROWED HALF OF THE ORDERING CONTRACT, pinned rather than left as
    // prose, together with the discriminator that decided the narrowing.
    //
    // `input.payload`'s nesting IS answerable from the input, and it is refused
    // late anyway. T2.1 exports no depth-only checker, so a pre-check would be
    // either a second full canonicalization of the row or a duplicate of T2.1's
    // walk carrying a depth-offset correction — and the offset is real: the
    // first assertion below shows this payload canonicalizing CLEANLY on its
    // own, because a standalone walk seeds at the payload while
    // `canonicalizeEvent` seeds at the envelope, one level up. A pre-check
    // spelled `canonicalizeJson(input.payload)` would therefore ADMIT this
    // input pre-encrypt and let the real guard refuse it post-encrypt, making
    // the ordering claim false for exactly this row.
    //
    // The `encryptCallCount` assertion is what keeps the docstring's "two
    // classes remain behind the encrypt" honest: hoist this refusal and the
    // expectation fails, so the docstring gets revisited with the code.
    const boundaryPayload: Record<string, unknown> = buildPayloadNestedToCanonicalDepth(
      CANONICAL_JSON_MAX_DEPTH + 1,
    );
    expect(() => canonicalizeJson(boundaryPayload)).not.toThrow();
    // ...and the offset is EXACTLY one, not merely non-zero: one level deeper
    // and the standalone walk refuses too. Without this the assertion above
    // would also pass against a depth guard that never fired at all.
    expect(() =>
      canonicalizeJson(buildPayloadNestedToCanonicalDepth(CANONICAL_JSON_MAX_DEPTH + 2)),
    ).toThrow(
      new RegExp(`nests containers deeper than ${String(CANONICAL_JSON_MAX_DEPTH)} levels`),
    );

    const encryptor = new DeterministicTestPiiEncryptor();
    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ payload: boundaryPayload }),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(
      new RegExp(`nests containers deeper than ${String(CANONICAL_JSON_MAX_DEPTH)} levels`),
    );
    expect(encryptor.encryptCallCount).toBe(1);

    // The accepting side of this boundary is already pinned, on the read path:
    // "CONTROL — still verifies a row minted with a payload AT the depth
    // ceiling" MINTS one level shallower through this same write path, so this
    // case is a boundary rather than "deep payloads are rejected".
  });

  it("refuses a NaN inside payload only AFTER the encrypt, from the library's own guard", async () => {
    // The second member of the post-encrypt class, and a different layer from
    // the depth ceiling: this throw is `canonicalize@3.0.0`'s, with its bare
    // wording. `NaN` is a SCALAR, so T2.1's depth walk never queues it and no
    // depth pre-check would catch it either — only serialization does, and
    // serialization of the envelope needs the digest, which needs the
    // ciphertext.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ payload: { exportFormat: "json", ratio: Number.NaN } }),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/NaN is not allowed/);
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses a NaN inside the PII partition BEFORE the encrypt (the mirror control)", async () => {
    // The mirror of the case above, and what makes it a statement about WHERE
    // the value sits rather than about `NaN`: the PII partition is serialized at
    // step 2, ahead of the encrypt, so the identical defect one member over is
    // refused for free.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ piiPayload: { displayName: "Ada", ratio: Number.NaN } }),
        GENESIS_PREV_HASH,
        encryptor,
        DAEMON_SIGNING_KEY,
      ),
    ).rejects.toThrow(/NaN is not allowed/);
    expect(encryptor.encryptCallCount).toBe(0);
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

// ---------------------------------------------------------------------------
// I-006-2-11 — the signed pii_ciphertext_digest is CHECKED, not merely minted.
// ---------------------------------------------------------------------------
//
// The suite above proves a post-shred row still VERIFIES. That is the property
// the digest exists to protect, and `verifyRow` alone can never be the whole of
// it: it is not handed `pii_payload`, so its verdict is blind to what the
// ciphertext column holds. Leg 2 composes THIS predicate over the same stored
// row for exactly that reason — a Path-1 shred writes no column, so
// "still verifies" is a claim about the operation only when paired with a
// binding check that a column NULL would break. The cases here are the
// predicate's own contract at unit granularity: every column/payload pair it
// must classify, including the two the DB-level cases cannot reach — a
// substituted ciphertext, and a compacted stub.
describe("isCiphertextDigestBound — the ciphertext column's only integrity binding", () => {
  const ciphertext = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
  const digestOf = (bytes: Uint8Array): string => bytesToHex(blake3(bytes));
  const payloadWith = (digest: unknown): Record<string, unknown> => ({
    kind: "message",
    [PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: digest,
  });

  it("binds a live PII row whose ciphertext still hashes to the signed digest", () => {
    expect(isCiphertextDigestBound(ciphertext, payloadWith(digestOf(ciphertext)))).toBe(true);
  });

  it("catches a substituted ciphertext that leaves hash and signature green", () => {
    const substituted = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01, 0x02, 0x03]);
    expect(isCiphertextDigestBound(substituted, payloadWith(digestOf(ciphertext)))).toBe(false);
  });

  it("catches a truncated ciphertext", () => {
    expect(isCiphertextDigestBound(ciphertext.slice(0, 3), payloadWith(digestOf(ciphertext)))).toBe(
      false,
    );
  });

  // The state a plain "recompute and compare" never reaches, because there is
  // nothing left to recompute over. A digest whose subject was deleted after
  // signing still verifies as part of the canonical bytes.
  it("catches ciphertext deleted at rest while its signed digest survives", () => {
    expect(isCiphertextDigestBound(null, payloadWith(digestOf(ciphertext)))).toBe(false);
    expect(isCiphertextDigestBound(undefined, payloadWith(digestOf(ciphertext)))).toBe(false);
  });

  it("catches a non-NULL ciphertext carrying no digest at all", () => {
    expect(isCiphertextDigestBound(ciphertext, { kind: "message" })).toBe(false);
  });

  it("passes an ordinary no-PII row: neither column nor digest present", () => {
    expect(isCiphertextDigestBound(null, { kind: "message" })).toBe(true);
  });

  // Spec-006 §Compacted Event Format NULLs pii_payload and replaces payload
  // with a stub projection carrying no digest — the both-absent state, which is
  // why the check needs no retention-class branch.
  it("passes a compacted audit stub", () => {
    const stubProjection = {
      id: FIXTURE_EVENT_ID,
      retentionClass: "audit_stub",
      summary: "a compacted event",
    };
    expect(isCiphertextDigestBound(null, stubProjection)).toBe(true);
  });

  // Spec-022 §Shred Fan-Out Path 1 destroys the key and overwrites no column,
  // so the retained ciphertext still hashes to its digest. This is the test
  // that would fail if a shred-state carve-out were ever added on the theory
  // that shredding clears the column.
  it("passes a crypto-shredded row, whose ciphertext Path 1 retains intact", () => {
    const afterKeyDeletion = ciphertext;
    expect(isCiphertextDigestBound(afterKeyDeletion, payloadWith(digestOf(ciphertext)))).toBe(true);
  });

  // SQLite BLOB affinity can hand back a string; noble's abytes throws on one.
  // A verifier that cannot confirm the binding has not confirmed it.
  it("fails closed on a column shape it cannot digest, without throwing", () => {
    expect(() =>
      isCiphertextDigestBound("deadbeef", payloadWith(digestOf(ciphertext))),
    ).not.toThrow();
    expect(isCiphertextDigestBound("deadbeef", payloadWith(digestOf(ciphertext)))).toBe(false);
    expect(isCiphertextDigestBound(42, payloadWith(digestOf(ciphertext)))).toBe(false);
  });

  it("treats a non-string digest member as no digest", () => {
    expect(isCiphertextDigestBound(ciphertext, payloadWith(12345))).toBe(false);
    expect(isCiphertextDigestBound(null, payloadWith(12345))).toBe(true);
  });

  it("holds lowercase hex as the contract embedCiphertextDigest pins", () => {
    const uppercased = digestOf(ciphertext).toUpperCase();
    expect(isCiphertextDigestBound(ciphertext, payloadWith(uppercased))).toBe(false);
  });

  it("distinguishes an empty ciphertext from a missing one", () => {
    const empty = new Uint8Array(0);
    expect(isCiphertextDigestBound(empty, payloadWith(digestOf(empty)))).toBe(true);
    expect(isCiphertextDigestBound(empty, payloadWith(digestOf(ciphertext)))).toBe(false);
  });

  // Never-throwing is a contract, not defensive style: T4.1 consumes this
  // inside a range walk, where one throw aborts the walk and silences audit of
  // the entire remaining tail.
  it("returns a verdict for every hostile input pair rather than throwing", () => {
    const columnValues: unknown[] = [
      null,
      undefined,
      0,
      "",
      "zz",
      42,
      true,
      {},
      [],
      new Uint8Array(0),
      ciphertext,
    ];
    const payloadValues: unknown[] = [
      null,
      undefined,
      0,
      "",
      "not-an-object",
      [],
      {},
      payloadWith(null),
      payloadWith(digestOf(ciphertext)),
    ];
    for (const columnValue of columnValues) {
      for (const payloadValue of payloadValues) {
        expect(typeof isCiphertextDigestBound(columnValue, payloadValue)).toBe("boolean");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The owner stamp is CHECKED too — the read half of the Path-1 selector.
// ---------------------------------------------------------------------------
//
// The sibling predicate above binds the ciphertext to its signed digest. This
// one binds the SELECTOR: `Spec-022 §Shred Fan-Out` Path 1 chooses which rows an
// erasure covers by matching the durable participant-id stamp on the event row,
// never the ciphertext, which is opaque. So a stamp the signature does not
// vouch for is a selector an at-rest adversary can rewrite — and rewriting it
// does not corrupt the erasure quietly, it CERTIFIES the corruption: the
// `event.shredded` audit artifact carries an `affectedSessionIds` /
// `piiPayloadsCleared` census and is retained indefinitely, so a row moved out
// of the sweep's reach leaves behind a permanent record saying it was covered.
//
// TWO HALVES, AND THIS FILE NOW HOLDS BOTH. Leg 1 proves the stamp reaches the
// canonical bytes (the write half); these cases are the read half at unit
// granularity, over the column T3.1 will add. Neither half is the binding on its
// own: a signed stamp nobody compares against the column, or a column compared
// against nothing signed, each leave the selector unprotected.
//
// THE COLUMN DOES NOT EXIST YET, and these cases are written so that stays
// visible. `0001-initial.ts` gives `session_events` no owner-stamp column —
// `pii_payload BLOB` is the whole of its PII surface — so every case here passes
// the stored value as a plain argument rather than reading it back from SQLite.
// The DB-level counterparts belong to T3.1, which inherits the column.
describe("isPiiOwnerStampBound — the Path-1 selector's only integrity binding", () => {
  const ownerParticipantId = FIXTURE_PARTICIPANT_ID;
  const otherParticipantId = "participant-ffffffff-ffff-4fff-8fff-ffffffffffff";
  const payloadWithStamp = (stamp: unknown): Record<string, unknown> => ({
    exportFormat: "json",
    [PII_PARTICIPANT_ID_PAYLOAD_KEY]: stamp,
  });
  const payloadWithoutStamp: Record<string, unknown> = { exportFormat: "json" };

  // STATE 1 of four — column present, claim present, and they agree.
  it("binds a live PII row whose stored stamp matches the signed one", () => {
    expect(isPiiOwnerStampBound(ownerParticipantId, payloadWithStamp(ownerParticipantId))).toBe(
      true,
    );
  });

  // STATE 1's failing half, and the tamper the predicate exists for: hash and
  // signature both stay green, because neither commits to the column.
  it("catches a stored stamp substituted to a DIFFERENT participant", () => {
    expect(isPiiOwnerStampBound(otherParticipantId, payloadWithStamp(ownerParticipantId))).toBe(
      false,
    );
  });

  // STATE 2 — the ordinary no-PII row. Both absent is BOUND, which is what lets
  // T4.1 run this over every row in a range instead of over a filtered subset.
  it("passes an ordinary no-PII row: neither column nor signed stamp present", () => {
    expect(isPiiOwnerStampBound(null, payloadWithoutStamp)).toBe(true);
    expect(isPiiOwnerStampBound(undefined, payloadWithoutStamp)).toBe(true);
  });

  // STATE 3 — an owner nothing vouches for. The row claims a participant's data
  // and the signature says nothing about whose, so the sweep would act on a
  // value written after signing.
  it("catches a stored stamp with NO signed claim behind it", () => {
    expect(isPiiOwnerStampBound(ownerParticipantId, payloadWithoutStamp)).toBe(false);
  });

  // STATE 4 — the stamp cleared after signing, which is how a row is hidden from
  // the sweep WITHOUT substituting a plausible-looking owner: a NULL selector
  // matches no participant at all.
  it("catches a signed stamp whose column was cleared after signing", () => {
    expect(isPiiOwnerStampBound(null, payloadWithStamp(ownerParticipantId))).toBe(false);
    expect(isPiiOwnerStampBound(undefined, payloadWithStamp(ownerParticipantId))).toBe(false);
  });

  // FAIL CLOSED ON A SHAPE IT CANNOT COMPARE. The column is `TEXT`, but anything
  // with write access can leave a number or a blob in it, and SQLite's affinity
  // rules do not coerce it back. A verifier that cannot confirm the binding has
  // not confirmed it — reporting UNBOUND is the answer, and skipping the row is
  // the one wrong answer, because "unverifiable" would then read as "verified".
  it("fails closed on a non-string, non-NULL stored value rather than skipping it", () => {
    const uncomparableStoredValues: unknown[] = [
      42,
      0,
      true,
      false,
      {},
      [],
      new Uint8Array([1, 2, 3]),
      Symbol("participant"),
    ];
    for (const storedValue of uncomparableStoredValues) {
      expect(isPiiOwnerStampBound(storedValue, payloadWithStamp(ownerParticipantId))).toBe(false);
      expect(isPiiOwnerStampBound(storedValue, payloadWithoutStamp)).toBe(false);
    }
  });

  // The empty string is a STORED VALUE, not an absence — the distinction `== null`
  // is written to preserve, and the one a truthiness test would collapse. Refusal
  // 7 makes an empty `piiParticipantId` unwritable through the codec, so an empty
  // column is already an anomaly; it must not read as an ordinary no-PII row.
  it("distinguishes an empty stored stamp from an absent one", () => {
    expect(isPiiOwnerStampBound("", payloadWithoutStamp)).toBe(false);
    expect(isPiiOwnerStampBound("", payloadWithStamp(""))).toBe(true);
    expect(isPiiOwnerStampBound("", payloadWithStamp(ownerParticipantId))).toBe(false);
  });

  // EXACT COMPARISON, no normalization. A participant id is an opaque token, so
  // case-folding or trimming would make two different participants compare equal
  // — and the whole point of the selector is telling participants apart.
  it("compares exactly, folding no case and trimming no whitespace", () => {
    expect(
      isPiiOwnerStampBound(ownerParticipantId.toUpperCase(), payloadWithStamp(ownerParticipantId)),
    ).toBe(false);
    expect(
      isPiiOwnerStampBound(` ${ownerParticipantId}`, payloadWithStamp(ownerParticipantId)),
    ).toBe(false);
  });

  // A signed claim of the wrong TYPE folds to "no claim" — the shared residual
  // the implementation documents rather than diverging from, pinned here so a
  // future edit to either predicate has to change a test to change the behavior.
  it("treats a non-string signed stamp as no claim, matching the sibling predicate", () => {
    expect(isPiiOwnerStampBound(ownerParticipantId, payloadWithStamp(12345))).toBe(false);
    expect(isPiiOwnerStampBound(null, payloadWithStamp(12345))).toBe(true);
  });

  // Never-throwing is a CONTRACT, not defensive style, and it is the same one the
  // sibling carries: T4.1 calls this inside a range walk, where a single throw
  // aborts the walk and silences audit of the entire remaining tail. One
  // malformed row would otherwise buy an attacker a range-wide blind spot.
  it("returns a verdict for every hostile input pair rather than throwing", () => {
    const storedValues: unknown[] = [
      null,
      undefined,
      "",
      ownerParticipantId,
      0,
      42,
      true,
      {},
      [],
      new Uint8Array(0),
      Object.create(null) as object,
    ];
    const payloadValues: unknown[] = [
      null,
      undefined,
      0,
      "",
      "not-an-object",
      [],
      {},
      payloadWithoutStamp,
      payloadWithStamp(null),
      payloadWithStamp(undefined),
      payloadWithStamp(ownerParticipantId),
      Object.create(null) as object,
    ];
    for (const storedValue of storedValues) {
      for (const payloadValue of payloadValues) {
        expect(typeof isPiiOwnerStampBound(storedValue, payloadValue)).toBe("boolean");
      }
    }
  });
});
