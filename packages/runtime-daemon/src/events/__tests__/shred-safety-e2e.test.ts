// END-TO-END shred safety — the Phase-3 acceptance gate (Plan-006 T3.5).
//
// One lifecycle, run through the REAL modules in the order production runs them:
//
//   64 PII-carrying appends through `EventLogService`
//     → a compaction pass behind a real `MerkleAnchorService` anchor
//     → `event.shredded` through the same append path
//     → the registered shred callback performs Plan-022 Path 1's crypto-shred
//       (a `participant_keys` row DELETE — the key, never the ciphertext)
//     → the integrity verifier re-runs over the WHOLE chain
//
// and then asserts the property the whole design exists for: DESTROYING THE KEY
// DESTROYS THE PLAINTEXT AND NOTHING ELSE. Every signature still verifies, every
// chain link still holds, and a reader gets `<pii-shredded>` where the
// participant's content used to be.
//
// WHY THE FIXTURE LEAVES A LIVE TAIL, and why that is not incidental. Compaction
// NULLs `pii_payload` and `pii_participant_id` on every row it stubs — a
// compacted row has no ciphertext left to shred and no owner stamp to join on.
// So the shred-visibility arms have to run over rows that SURVIVED the pass, and
// the threshold is chosen to leave forty of them. Shredding only over the
// compacted prefix would pass for the wrong reason: there would be nothing there.
//
// WHAT IS SUITE-LOCAL, and what is production. The read projection below is
// suite-local by design — Phase 4's replay service does not exist yet, and
// importing a symbol from it is not an option. `splitPii` is likewise a fixture:
// Plan-022 owns the real classification. Everything else — the append path, the
// PII codec, the compactor, the anchor service, the signer — is the shipped code.
//
// Spec coverage: `Spec-006 §Canonical Serialization Rules` (the canonical bytes
// exclude `pii_payload` and bind it through a digest), `Spec-006 §Event
// Compaction Policy` (the pass that precedes the shred), `Spec-006 §Event
// Maintenance (event_maintenance)` (`event.shredded`). Refs: Plan-006 T3.5,
// `Plan-006 §Read Path`, `Spec-022 §Shred Fan-Out` Path 1, I-006-2-04,
// I-006-2-12.

import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
  NodeIdSchema,
  SessionIdSchema,
  type EventEnvelope,
  type NodeId,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { canonicalizeEvent, type CanonicalBytes } from "../canonicalizer.js";
import {
  AUDIT_STUB_RETENTION_CLASS,
  Compactor,
  type CompactionEventLog,
  type CompactionPassResult,
} from "../compactor.js";
import { EventLogService, type UnsequencedEventEnvelope } from "../event-log-service.js";
import { MerkleAnchorService } from "../merkle-anchor-service.js";
import {
  PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  PII_PARTICIPANT_ID_PAYLOAD_KEY,
  type PiiEncryptionRequest,
  type PiiEncryptor,
} from "../pii-indirection.js";
import { __resetSessionAppendLocksForTest } from "../session-append-lock.js";
import {
  GENESIS_PREV_HASH,
  verifyRow,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  type RowVerification,
} from "../signer.js";
import type { DaemonSigningKeySource } from "../signing-key-source.js";

const SESSION: SessionId = SessionIdSchema.parse("33333333-4444-4555-8666-777777777777");
const NODE: NodeId = NodeIdSchema.parse("node-shred-e2e-01");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");
const PASS_INSTANT = "2026-08-04T12:00:00.000Z";

/** The participant whose key this run destroys. */
const SHREDDED_PARTICIPANT = "44444444-5555-4666-8777-888888888888";
/** The control: a second participant whose key survives. */
const RETAINED_PARTICIPANT = "44444444-5555-4666-8777-888888888899";

const SHREDDED_PLAINTEXT = "the-content-that-must-become-unreadable";
const RETAINED_PLAINTEXT = "the-content-that-must-stay-readable";

/**
 * The marker `Plan-006 §Read Path`'s third state puts where the participant's
 * fields were.
 */
const PII_SHREDDED_MARKER = "<pii-shredded>";

const DAEMON_PRIVATE_KEY = new Uint8Array(32).fill(23) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY = ed25519.getPublicKey(DAEMON_PRIVATE_KEY) as Ed25519PublicKey;

// Answers for EVERY session, the daemon-scope sentinel included: the compaction
// pass emits `event.compacted` on the sentinel partition through this same
// append path, and a key source that did not know the sentinel would turn a
// wiring gap into a silent mid-pass refusal.
const keySource: DaemonSigningKeySource = {
  create: () => Promise.resolve({ publicKey: DAEMON_PUBLIC_KEY }),
  read: () => Promise.resolve(DAEMON_PRIVATE_KEY),
};

// ----------------------------------------------------------------------------
// Fixtures — the CP-006-1 encryptor and Plan-022's `splitPii`
// ----------------------------------------------------------------------------

/**
 * The test-only codec: a symmetric XOR over a BLAKE3 keystream derived from the
 * participant's stored content key, the participant id and the event id.
 *
 * DERIVING FROM THE STORED KEY IS THE WHOLE POINT of this fixture, and it is
 * what makes the shred arm mean anything: `decrypt` reads
 * `participant_keys.encrypted_key_blob` and cannot proceed without it, so a
 * DELETEd row makes the plaintext genuinely unrecoverable rather than merely
 * unread. A stub that ignored the stored key would produce a test in which the
 * shred changed nothing and every assertion still passed.
 */
class ParticipantKeyedPiiCodec implements PiiEncryptor {
  constructor(private readonly database: DatabaseType) {}

  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array> {
    const contentKey = this.readContentKey(request.participantId);
    if (contentKey === undefined) {
      throw new Error(`no content key for participant ${request.participantId}`);
    }
    return Promise.resolve(
      xorWithKeystream(request.plaintext, contentKey, request.participantId, request.eventId),
    );
  }

  /** The read-side counterpart; `undefined` once the key row is gone. */
  decrypt(
    ciphertext: Uint8Array,
    participantId: string,
    eventId: string,
  ): Record<string, unknown> | undefined {
    const contentKey = this.readContentKey(participantId);
    if (contentKey === undefined) return undefined;
    const plaintext = xorWithKeystream(ciphertext, contentKey, participantId, eventId);
    return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
  }

  private readContentKey(participantId: string): Uint8Array | undefined {
    const row = this.database
      .prepare("SELECT encrypted_key_blob FROM participant_keys WHERE participant_id = ?")
      .get(participantId) as { encrypted_key_blob: Uint8Array } | undefined;
    return row?.encrypted_key_blob;
  }
}

function xorWithKeystream(
  input: Uint8Array,
  contentKey: Uint8Array,
  participantId: string,
  eventId: string,
): Uint8Array {
  const seed = new Uint8Array(contentKey.length + participantId.length + eventId.length);
  seed.set(contentKey, 0);
  seed.set(new TextEncoder().encode(`${participantId}${eventId}`), contentKey.length);
  const keystream = blake3(seed, { dkLen: Math.max(1, input.length) });
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = (input[index] ?? 0) ^ (keystream[index] ?? 0);
  }
  return output;
}

/**
 * Plan-022's `splitPii`, as a fixture.
 *
 * The real classification is semantic and Plan-022-owned; what this file needs
 * is only the SHAPE of its output — a partition of one logical event into the
 * half that is hashed and signed in the clear and the half that is encrypted.
 */
function splitPii(event: Record<string, unknown>): {
  readonly clear: Record<string, unknown>;
  readonly pii: Record<string, unknown>;
} {
  const clear: Record<string, unknown> = {};
  const pii: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "text" || key === "filePath") {
      pii[key] = value;
    } else {
      clear[key] = value;
    }
  }
  return { clear, pii };
}

let database: DatabaseType;
let codec: ParticipantKeyedPiiCodec;
let eventLog: EventLogService;

beforeEach(() => {
  database = openDatabase(":memory:");
  codec = new ParticipantKeyedPiiCodec(database);
  eventLog = new EventLogService({
    db: database,
    signingKeySource: keySource,
    piiEncryptor: codec,
  });
  __resetSessionAppendLocksForTest();
  for (const participantId of [SHREDDED_PARTICIPANT, RETAINED_PARTICIPANT]) {
    database
      .prepare(
        `INSERT INTO participant_keys (participant_id, encrypted_key_blob, key_version, created_at)
         VALUES (?, ?, 1, ?)`,
      )
      .run(
        participantId,
        Buffer.alloc(32, participantId.charCodeAt(0)),
        "2026-08-01T00:00:00.000Z",
      );
  }
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
  database.close();
});

// ----------------------------------------------------------------------------
// The stored row, hydrated for verification and for reading
// ----------------------------------------------------------------------------

interface StoredRow {
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
  readonly retention_class: string | null;
  readonly stub_signature: Uint8Array | null;
}

function storedRows(sessionId: SessionId = SESSION): ReadonlyArray<StoredRow> {
  return database
    .prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence ASC")
    .all(sessionId) as ReadonlyArray<StoredRow>;
}

/** Rebuild the signed envelope FROM STORAGE — never from what the test appended. */
function canonicalBytesOf(row: StoredRow): CanonicalBytes {
  const envelope: EventEnvelope = {
    id: row.id,
    sessionId: SessionIdSchema.parse(row.session_id),
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    category: row.category as EventEnvelope["category"],
    type: row.type,
    actor: row.actor,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    version: EventEnvelopeVersionSchema.parse(row.version),
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
    ...(row.causation_id !== null ? { causationId: row.causation_id } : {}),
  };
  return canonicalizeEvent(envelope);
}

/**
 * The integrity verifier re-run: `verifyRow` per uncompacted row, plus the
 * LINKAGE walk `verifyRow` explicitly leaves to its caller.
 */
function verifyWholeChain(sessionId: SessionId = SESSION): {
  readonly perRow: ReadonlyArray<RowVerification>;
  readonly linkageDefect: string | undefined;
} {
  const rows = storedRows(sessionId);
  const perRow: RowVerification[] = [];
  let expectedSequence = 0;
  let expectedPrevHash: Uint8Array = GENESIS_PREV_HASH;
  let linkageDefect: string | undefined;

  for (const row of rows) {
    if (linkageDefect === undefined && row.sequence !== expectedSequence) {
      linkageDefect = `sequence gap at ${String(row.sequence)}`;
    }
    if (linkageDefect === undefined && !bytesEqual(row.prev_hash, expectedPrevHash)) {
      linkageDefect = `broken link at sequence ${String(row.sequence)}`;
    }
    expectedSequence = row.sequence + 1;
    expectedPrevHash = row.row_hash;

    // A COMPACTED row is out of `verifyRow`'s scope by row class: compaction
    // discarded the bytes it would recompute from. Its commitment is the
    // per-row `stub_signature`, checked separately below.
    if (row.retention_class === null) {
      perRow.push(
        verifyRow(
          canonicalBytesOf(row),
          {
            prevHash: row.prev_hash,
            rowHash: row.row_hash,
            daemonSignature: row.daemon_signature,
          },
          DAEMON_PUBLIC_KEY,
        ),
      );
    }
  }
  return { perRow, linkageDefect };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * The SUITE-LOCAL read projection — `Plan-006 §Read Path`'s three states.
 *
 * ONE MODELLING DECISION worth stating outright: in the third state the reader
 * marks the participant's contribution AS A UNIT rather than field by field,
 * because the field NAMES are themselves inside the ciphertext it can no longer
 * open. Marking per field would require the reader to know a schema the shred
 * just made unknowable, so the marker sits at one reserved key and the arms
 * below additionally assert the negative property that matters — no byte of the
 * plaintext survives anywhere in the projection.
 */
function projectForRead(row: StoredRow): Record<string, unknown> {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  // State 1 — no PII on this row. Returned verbatim.
  if (row.pii_payload === null || row.pii_participant_id === null) return payload;

  const decrypted = codec.decrypt(row.pii_payload, row.pii_participant_id, row.id);
  // State 3 — ciphertext present, key gone. The digest stays: it is what a
  // verifier uses to prove the ciphertext this row committed to was never
  // swapped, and it is not itself participant content.
  if (decrypted === undefined) return { ...payload, pii: PII_SHREDDED_MARKER };
  // State 2 — key available. The partition is merged back under its own keys.
  return { ...payload, ...decrypted };
}

// ----------------------------------------------------------------------------
// The lifecycle
// ----------------------------------------------------------------------------

/**
 * The `session.created` row every session opens with — the first event in the
 * lifecycle sentence, and compactable like any other `session_lifecycle` row, so
 * it occupies the first slot of the compacted prefix.
 */
const SESSION_OPENER_EVENT_COUNT = 1;
const SHREDDED_PARTICIPANT_EVENT_COUNT = 60;
const RETAINED_PARTICIPANT_EVENT_COUNT = 4;
const TOTAL_PII_EVENT_COUNT = SHREDDED_PARTICIPANT_EVENT_COUNT + RETAINED_PARTICIPANT_EVENT_COUNT;
/** Everything the pass may consider: the opener plus every PII row. */
const COMPACTABLE_EVENT_COUNT = SESSION_OPENER_EVENT_COUNT + TOTAL_PII_EVENT_COUNT;
/** Chosen to leave forty of the shredded participant's rows live past the pass. */
const COMPACTION_COUNT_THRESHOLD = 44;
const EXPECTED_COMPACTED_ROWS = COMPACTABLE_EVENT_COUNT - COMPACTION_COUNT_THRESHOLD;
/** The stubbed prefix opens with the session-opener row, so one fewer PII row is stubbed. */
const COMPACTED_PII_ROW_COUNT = EXPECTED_COMPACTED_ROWS - SESSION_OPENER_EVENT_COUNT;
const LIVE_SHREDDED_ROW_COUNT = SHREDDED_PARTICIPANT_EVENT_COUNT - COMPACTED_PII_ROW_COUNT;
/**
 * The opener and every PII row — and NOTHING else. `event.shredded` is
 * daemon-scope bound and lands on the sentinel partition, not here.
 */
const TOTAL_SESSION_ROW_COUNT = COMPACTABLE_EVENT_COUNT;
const LIVE_ROW_COUNT = TOTAL_SESSION_ROW_COUNT - EXPECTED_COMPACTED_ROWS;

/**
 * The sentinel partition after one lifecycle: the pass's `event.compacted` at
 * sequence 0, then `event.shredded` at sequence 1.
 *
 * `Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring` binds EVERY
 * `event_maintenance` type to the daemon-scope sentinel, and grants exactly one
 * carve-out back to a real session: an `event.compacted` scoped to a single
 * session's compaction MAY carry that session's id. `event.shredded` has no such
 * grant — it is a fan-out record naming its affected sessions in the payload,
 * and a shred spanning several sessions has no one session to belong to.
 */
const SENTINEL_COMPACTED_RECORD_COUNT = 1;
const SHRED_SENTINEL_SEQUENCE = SENTINEL_COMPACTED_RECORD_COUNT;
const SENTINEL_ROW_COUNT = SENTINEL_COMPACTED_RECORD_COUNT + 1;

interface LifecycleResult {
  readonly compaction: CompactionPassResult;
  readonly shredCallbackInvocations: number;
  readonly shredSequence: number;
}

async function appendPiiEvent(index: number, participantId: string, text: string): Promise<void> {
  // The clear half is a REAL `assistant.message` payload rather than fixture
  // bookkeeping: that type has a registered `SessionEventSchema` variant, and
  // the sealing codec parses the composed row against it before signing. A
  // `{ index, channel }` payload would be refused — correctly, since the row it
  // signed could never be read back as an `assistant.message` again.
  const { clear, pii } = splitPii({ sessionId: SESSION, runId: `run-${String(index)}`, text });
  const envelope: UnsequencedEventEnvelope = {
    id: `evt-${String(index).padStart(4, "0")}`,
    sessionId: SESSION,
    occurredAt: "2026-08-01T00:00:00.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: null,
    payload: clear,
    version: ENVELOPE_VERSION,
  };
  await eventLog.append(envelope, { pii: { participantId, piiPayload: pii } });
}

/**
 * A compactor over the REAL append path and a REAL anchor service.
 *
 * The thresholds are parameters because the second-pass arm cannot use the
 * count trigger at all — see the comment on that arm for why a count pass
 * cannot reach the rows it needs to put at risk.
 */
function buildCompactor(thresholds: {
  readonly eventCountThreshold: number;
  readonly storageThresholdBytes?: number;
}): Compactor {
  return new Compactor({
    db: database,
    nodeId: NODE,
    signingKeySource: keySource,
    // The real append path, so `event.compacted` lands on the sentinel chain
    // exactly as it would in production. `satisfies` rather than a cast: this is
    // the one file that wires the shipped service into the seam, so it is also
    // the only place a drift between them can be caught at compile time.
    eventLog: eventLog satisfies CompactionEventLog,
    anchorSource: new MerkleAnchorService({
      db: database,
      nodeId: NODE,
      signingKeySource: keySource,
      now: () => new Date(PASS_INSTANT),
    }),
    now: () => new Date(PASS_INSTANT),
    ...thresholds,
  });
}

/** Appends, compacts, then shreds — the whole lifecycle, once. */
async function runLifecycle(): Promise<LifecycleResult> {
  // The session opens, exactly as `Plan-006 §Test And Verification Plan`'s
  // end-to-end lifecycle sentence has it. It is also the row that proves the
  // compacted prefix is not PII-only: a stub projection that mishandled a
  // payload with no PII partition would fail here rather than in Phase 4.
  await eventLog.append({
    id: "evt-session-created",
    sessionId: SESSION,
    occurredAt: "2026-08-01T00:00:00.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: null,
    // A payload its own registered `session.created` variant accepts. The
    // append path parses what it is about to sign, so a fixture composing an
    // ad-hoc shape here is refused before signing — which is that guard
    // working, not an obstacle to it.
    payload: { sessionId: SESSION, config: {}, metadata: { title: "shred-safety end-to-end" } },
    version: ENVELOPE_VERSION,
  });

  for (let index = 0; index < SHREDDED_PARTICIPANT_EVENT_COUNT; index += 1) {
    await appendPiiEvent(index, SHREDDED_PARTICIPANT, `${SHREDDED_PLAINTEXT}-${String(index)}`);
  }
  for (let index = 0; index < RETAINED_PARTICIPANT_EVENT_COUNT; index += 1) {
    await appendPiiEvent(
      SHREDDED_PARTICIPANT_EVENT_COUNT + index,
      RETAINED_PARTICIPANT,
      `${RETAINED_PLAINTEXT}-${String(index)}`,
    );
  }

  const compaction = await buildCompactor({
    eventCountThreshold: COMPACTION_COUNT_THRESHOLD,
  }).tick();

  // Plan-022 Path 1: the callback destroys the KEY. It runs post-commit, while
  // the append still holds the lock of the session the RECORD was written on —
  // the sentinel's, here. That is a narrower guarantee than it looks: the append
  // lock is per-session and there is no cross-session exclusion, so an append on
  // an affected session can legitimately interleave with the key deletion. What
  // the hold actually buys is serialization of the sentinel chain across the
  // callback, which is what keeps a second maintenance record from landing
  // mid-shred.
  let shredCallbackInvocations = 0;
  eventLog.registerShredCallback((shredded) => {
    shredCallbackInvocations += 1;
    database
      .prepare("DELETE FROM participant_keys WHERE participant_id = ?")
      .run(shredded.participantId);
    return Promise.resolve();
  });

  const receipt = await eventLog.append({
    id: "evt-shredded",
    // DAEMON-SCOPE BOUND, like every other `event_maintenance` type. Writing it
    // on `SESSION` would put a fan-out record on one of the several sessions it
    // reports about, and would additionally make this fixture disagree with the
    // production binding the compaction record above already follows.
    sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
    occurredAt: PASS_INSTANT,
    category: "event_maintenance",
    type: "event.shredded",
    actor: null,
    payload: {
      nodeId: NODE,
      operationId: "shred-operation-1",
      occurredAt: PASS_INSTANT,
      participantId: SHREDDED_PARTICIPANT,
      affectedSessionIds: [SESSION],
      piiPayloadsCleared: SHREDDED_PARTICIPANT_EVENT_COUNT,
      shredReason: "gdpr_article_17",
    },
    version: ENVELOPE_VERSION,
  });

  return { compaction, shredCallbackInvocations, shredSequence: receipt.sequence };
}

describe("Shred safety E2E — PII lifecycle through compaction and crypto-shred", () => {
  it("compacts a prefix behind a real anchor and leaves a live PII tail", async () => {
    const { compaction } = await runLifecycle();

    // The pass must have actually run: a refusal here would make every
    // downstream assertion vacuous rather than failing.
    expect(compaction.sessionsRefused).toBe(0);
    expect(compaction.outcomes[0]?.refusedReason).toBeUndefined();
    expect(compaction.rowsStubbed).toBe(EXPECTED_COMPACTED_ROWS);

    const rows = storedRows();
    // The opener and 64 PII rows. The maintenance records this lifecycle writes
    // — `event.compacted` and `event.shredded` alike — are on the sentinel.
    expect(rows).toHaveLength(TOTAL_SESSION_ROW_COUNT);
    const compacted = rows.filter((row) => row.retention_class === AUDIT_STUB_RETENTION_CLASS);
    const live = rows.filter((row) => row.retention_class === null);
    expect(compacted).toHaveLength(EXPECTED_COMPACTED_ROWS);
    // Forty of the shredded participant's rows and four of the retained one's.
    expect(live).toHaveLength(LIVE_ROW_COUNT);
    expect(live.filter((row) => row.pii_participant_id === SHREDDED_PARTICIPANT)).toHaveLength(
      LIVE_SHREDDED_ROW_COUNT,
    );
    // The prefix opens with the session-opener row, which carries no PII
    // partition at all — so the stubbed set is not homogeneous.
    expect(compacted[0]?.type).toBe("session.created");

    // The anchor was queued over the compacted span BEFORE any payload was
    // destroyed.
    const anchors = database
      .prepare(
        "SELECT start_sequence, end_sequence FROM pending_anchor_uploads WHERE session_id = ?",
      )
      .all(SESSION) as ReadonlyArray<{ start_sequence: number; end_sequence: number }>;
    expect(anchors).toEqual([{ start_sequence: 0, end_sequence: EXPECTED_COMPACTED_ROWS - 1 }]);
  });

  it("destroys the key, not the ciphertext, and invokes the callback exactly once", async () => {
    const { shredCallbackInvocations, shredSequence } = await runLifecycle();

    expect(shredCallbackInvocations).toBe(1);
    // WHICH CHAIN the record landed on, expressed as a sequence. The sentinel
    // partition already held the pass's `event.compacted` at 0, so a shred bound
    // to the sentinel gets 1 — whereas a shred that had (wrongly) landed on the
    // real session would have taken the next sequence there, far above this.
    expect(shredSequence).toBe(SHRED_SENTINEL_SEQUENCE);
    expect(
      database.prepare("SELECT participant_id FROM participant_keys ORDER BY participant_id").all(),
    ).toEqual([{ participant_id: RETAINED_PARTICIPANT }]);

    // The CIPHERTEXT is untouched — this is a crypto-shred, not a column wipe,
    // and the digest in the signed payload still names these exact bytes.
    const liveShreddedRows = storedRows().filter(
      (row) => row.retention_class === null && row.pii_participant_id === SHREDDED_PARTICIPANT,
    );
    expect(liveShreddedRows.length).toBeGreaterThan(0);
    for (const row of liveShreddedRows) {
      expect(row.pii_payload).toBeInstanceOf(Uint8Array);
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const digest = payload[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY];
      expect(typeof digest).toBe("string");
      // Lowercase hex, matching the encoding the codec commits to inside the
      // signed canonical bytes.
      expect(bytesToHex(blake3(row.pii_payload ?? new Uint8Array()))).toBe(digest);
      // The owner stamp survives too — after the shred it is the only remaining
      // evidence of WHOSE data those bytes were.
      expect(payload[PII_PARTICIPANT_ID_PAYLOAD_KEY]).toBe(SHREDDED_PARTICIPANT);
    }
  });

  it("re-verifies the WHOLE chain after the shred — every signature, every link", async () => {
    const { compaction } = await runLifecycle();

    // The pass must have RUN. Both halves below are satisfied by an empty row
    // set, so a swallowed emission failure would vacate the arm rather than
    // fail it.
    expect(compaction.sessionsRefused).toBe(0);

    const { perRow, linkageDefect } = verifyWholeChain();

    // THE LOAD-BEARING PROPERTY. Canonical bytes exclude `pii_payload` and bind
    // it only through a digest, so removing the decryption key changes nothing
    // any signature committed to.
    expect(perRow).toHaveLength(LIVE_ROW_COUNT);
    expect(perRow.filter((verdict) => !verdict.valid)).toEqual([]);
    expect(linkageDefect).toBeUndefined();

    // And the sentinel partition both maintenance records landed on verifies too
    // — this is the ONLY place in the tree that checks the node-scope chain's
    // SIGNATURES rather than merely its linkage, so the row count is pinned: one
    // `event.compacted` for the single session this pass compacted, plus the
    // `event.shredded` record.
    const sentinel = verifyWholeChain(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(sentinel.perRow).toHaveLength(SENTINEL_ROW_COUNT);
    expect(sentinel.perRow.filter((verdict) => !verdict.valid)).toEqual([]);
    expect(sentinel.linkageDefect).toBeUndefined();
  });

  it("keeps every compacted stub's stub_signature valid over its stored bytes", async () => {
    await runLifecycle();

    const compacted = storedRows().filter(
      (row) => row.retention_class === AUDIT_STUB_RETENTION_CLASS,
    );
    expect(compacted).toHaveLength(EXPECTED_COMPACTED_ROWS);
    for (const row of compacted) {
      // Compaction NULLed both PII columns — a stub has no ciphertext left to
      // shred, which is exactly why the shred-visibility arms run over the live
      // tail instead.
      expect(row.pii_payload).toBeNull();
      expect(row.pii_participant_id).toBeNull();
      expect(row.stub_signature).not.toBeNull();
      expect(
        ed25519.verify(
          new Uint8Array(row.stub_signature ?? new Uint8Array()),
          new TextEncoder().encode(row.payload),
          DAEMON_PUBLIC_KEY,
        ),
      ).toBe(true);
    }
  });

  it("returns <pii-shredded> on read for the shredded participant, and content for the other", async () => {
    await runLifecycle();
    const live = storedRows().filter((row) => row.retention_class === null);

    const shreddedProjections = live
      .filter((row) => row.pii_participant_id === SHREDDED_PARTICIPANT)
      .map((row) => projectForRead(row));
    const retainedProjections = live
      .filter((row) => row.pii_participant_id === RETAINED_PARTICIPANT)
      .map((row) => projectForRead(row));

    expect(shreddedProjections.length).toBeGreaterThan(0);
    for (const projection of shreddedProjections) {
      expect(projection["pii"]).toBe(PII_SHREDDED_MARKER);
      // The digest is still surfaced: it is a commitment to ciphertext, not
      // participant content.
      expect(typeof projection[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe("string");
      // NOT ONE BYTE of the plaintext survives anywhere in what a reader sees.
      expect(JSON.stringify(projection)).not.toContain(SHREDDED_PLAINTEXT);
      expect(projection["text"]).toBeUndefined();
    }

    // THE NEGATIVE CONTROL — without it, a projection that returned the marker
    // unconditionally would pass every assertion above.
    expect(retainedProjections).toHaveLength(RETAINED_PARTICIPANT_EVENT_COUNT);
    for (const projection of retainedProjections) {
      expect(projection["pii"]).toBeUndefined();
      expect(String(projection["text"])).toContain(RETAINED_PLAINTEXT);
    }
  });

  it("returns a PII-free row verbatim (read-path state 1)", async () => {
    await runLifecycle();
    const shredRecord = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID).find(
      (row) => row.type === "event.shredded",
    );

    expect(shredRecord).toBeDefined();
    if (shredRecord === undefined) return;
    expect(shredRecord.pii_payload).toBeNull();
    const projection = projectForRead(shredRecord);
    expect(projection["participantId"]).toBe(SHREDDED_PARTICIPANT);
    expect(projection["piiPayloadsCleared"]).toBe(SHREDDED_PARTICIPANT_EVENT_COUNT);
    expect(projection["pii"]).toBeUndefined();
  });

  it("proves the verifier CAN fail — tampering with a live row after the shred is caught", async () => {
    // NEGATIVE CONTROL for the re-verification arm. Every verdict above is
    // `valid: true`, and a verifier wired to the wrong bytes would report that
    // too. Two independent defects, two different detections.
    await runLifecycle();
    const live = storedRows().filter((row) => row.retention_class === null);
    // A MIDDLE row, deliberately: deleting the newest one leaves an intact
    // prefix, so it would prove nothing about the walk.
    const target = live[Math.floor(live.length / 2)];
    expect(target).toBeDefined();
    if (target === undefined) return;

    database
      .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ tampered: true }), target.id);
    expect(verifyWholeChain().perRow.filter((verdict) => !verdict.valid)).toHaveLength(1);

    // And the linkage half sees what no per-row check can: a hole. Every
    // surviving row still verifies intra-row, because deleting forges nothing.
    database.prepare("DELETE FROM session_events WHERE id = ?").run(target.id);
    expect(verifyWholeChain().linkageDefect).toBeDefined();
    expect(verifyWholeChain().perRow.filter((verdict) => !verdict.valid)).toEqual([]);
  });

  it("spares the never-compacted categories through a SECOND pass (I-006-3-01 layer 1)", async () => {
    await runLifecycle();
    const sentinelBefore = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    const shredRecordBefore = sentinelBefore.find((row) => row.type === "event.shredded");
    expect(shredRecordBefore).toBeDefined();
    expect(sentinelBefore).toHaveLength(SENTINEL_ROW_COUNT);

    // A STORAGE pass with a zero byte budget, NOT a second count pass. The count
    // trigger's candidate set is the oldest rows beyond the newest
    // `eventCountThreshold`, so a partition's newest row is spared at every
    // threshold — and `event.shredded` is the newest row this suite writes. Under
    // a count pass the maintenance rows would therefore survive whether or not
    // layer 1 existed, and the arm would be asserting the trigger's prefix bound
    // rather than the category exclusion. A zero storage budget has no prefix
    // bound: every live compactable row is a candidate, so the exclusion is the
    // only thing left standing between these rows and a stub.
    const second = await buildCompactor({
      eventCountThreshold: COMPACTION_COUNT_THRESHOLD,
      storageThresholdBytes: 0,
    }).tick();
    expect(second.rowsStubbed).toBeGreaterThan(0);

    // The `event_maintenance` rows on the sentinel partition — the shred record
    // and the first pass's own `event.compacted` — are excluded by the SQL
    // selector itself, layer 1 of the three-layer enforcement. That the storage
    // pass still stubbed rows (asserted above) is what proves the exclusion is
    // doing the work rather than the trigger having gone quiet.
    const shredRecordAfter = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID).find(
      (row) => row.type === "event.shredded",
    );
    expect(shredRecordAfter?.retention_class).toBeNull();
    expect(shredRecordAfter?.stub_signature).toBeNull();
    expect(shredRecordAfter?.payload).toBe(shredRecordBefore?.payload);

    // The second pass appends its OWN `event.compacted`, so the partition grows;
    // what must hold is that no row in it was ever stubbed and the first is
    // byte-identical to what the first pass wrote.
    const sentinelAfter = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(sentinelAfter.length).toBeGreaterThan(sentinelBefore.length);
    expect(sentinelAfter.every((row) => row.retention_class === null)).toBe(true);
    expect(sentinelAfter[0]?.payload).toBe(sentinelBefore[0]?.payload);

    // The chain still verifies on both partitions after the second pass.
    expect(verifyWholeChain().perRow.filter((verdict) => !verdict.valid)).toEqual([]);
    expect(verifyWholeChain().linkageDefect).toBeUndefined();
    const sentinelVerification = verifyWholeChain(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(sentinelVerification.perRow.filter((verdict) => !verdict.valid)).toEqual([]);
    expect(sentinelVerification.linkageDefect).toBeUndefined();
  });

  it("proves the shred is what makes the plaintext unreadable", async () => {
    // NEGATIVE CONTROL for the marker arm: with the key still present the SAME
    // projection returns the content, so the marker is a consequence of the
    // DELETE rather than of the projection always saying so.
    for (let index = 0; index < 3; index += 1) {
      await appendPiiEvent(index, SHREDDED_PARTICIPANT, `${SHREDDED_PLAINTEXT}-${String(index)}`);
    }

    const beforeShred = storedRows().map((row) => projectForRead(row));
    expect(beforeShred.every((projection) => projection["pii"] === undefined)).toBe(true);
    expect(String(beforeShred[0]?.["text"])).toContain(SHREDDED_PLAINTEXT);

    database
      .prepare("DELETE FROM participant_keys WHERE participant_id = ?")
      .run(SHREDDED_PARTICIPANT);

    const afterShred = storedRows().map((row) => projectForRead(row));
    expect(afterShred.every((projection) => projection["pii"] === PII_SHREDDED_MARKER)).toBe(true);
  });
});
