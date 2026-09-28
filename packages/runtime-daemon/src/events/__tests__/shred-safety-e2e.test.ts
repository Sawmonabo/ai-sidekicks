// END-TO-END compaction safety over PII-carrying rows.
//
// One lifecycle, run through the REAL modules in the order production runs them:
//
//   64 PII-carrying appends through `EventLogService`
//     → a compaction pass behind a real `MerkleAnchorService` anchor
//     → the integrity verifier re-runs over the WHOLE chain
//
// and then asserts that stubbing the compacted prefix leaves every signature and
// every chain link intact, on the session and on the daemon-scope sentinel.
//
// The threshold leaves a live tail of forty PII rows: compaction NULLs
// `pii_payload` and `pii_user_id` on every row it stubs, so only rows that
// survived the pass still carry a PII partition for the verifier to cover.
//
// The read projection and `splitPii` are suite-local fixtures. Everything
// else — the append path, the PII codec, the compactor, the anchor service, the
// signer — is the shipped code.
//

import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
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
import { type PiiEncryptionRequest, type PiiEncryptor } from "../pii-indirection.js";
import { __resetSessionAppendLocksForTest } from "../session-append-lock.js";
import { SessionContentKeyStore } from "../session-content-key-store.js";
import {
  GENESIS_PREV_HASH,
  verifyRow,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  type RowVerification,
} from "../signer.js";
import type { DaemonSigningKeySource } from "../signing-key-source.js";

const SESSION: SessionId = SessionIdSchema.parse("33333333-4444-4555-8666-777777777777");
const NODE: NodeId = NodeIdSchema.parse("node-compaction-e2e-01");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");
const PASS_INSTANT = "2026-08-04T12:00:00.000Z";

/** The user who authors most of the session. */
const FIRST_USER = "44444444-5555-4666-8777-888888888888";
/** A second author, so the live tail holds two users' partitions. */
const SECOND_USER = "44444444-5555-4666-8777-888888888899";

const FIRST_USER_PLAINTEXT = "the-first-user-content";
const SECOND_USER_PLAINTEXT = "the-second-user-content";

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
// Fixtures — encryptor and the `splitPii`
// ----------------------------------------------------------------------------

/**
 * The test-only codec: a symmetric XOR over a BLAKE3 keystream derived from the
 * user's stored content key (`user_keys.encrypted_key_blob`), the user id and
 * the event id.
 */
class UserKeyedPiiCodec implements PiiEncryptor {
  constructor(private readonly database: DatabaseType) {}

  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array> {
    const contentKey = this.readContentKey(request.userId);
    if (contentKey === undefined) {
      throw new Error(`no content key for user ${request.userId}`);
    }
    return Promise.resolve(
      xorWithKeystream(request.plaintext, contentKey, request.userId, request.eventId),
    );
  }

  /** The read-side counterpart. */
  decrypt(ciphertext: Uint8Array, userId: string, eventId: string): Record<string, unknown> {
    const contentKey = this.readContentKey(userId);
    if (contentKey === undefined) {
      throw new Error(`no content key for user ${userId}`);
    }
    const plaintext = xorWithKeystream(ciphertext, contentKey, userId, eventId);
    return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
  }

  private readContentKey(userId: string): Uint8Array | undefined {
    const row = this.database
      .prepare("SELECT encrypted_key_blob FROM user_keys WHERE user_id = ?")
      .get(userId) as { encrypted_key_blob: Uint8Array } | undefined;
    return row?.encrypted_key_blob;
  }
}

function xorWithKeystream(
  input: Uint8Array,
  contentKey: Uint8Array,
  userId: string,
  eventId: string,
): Uint8Array {
  const seed = new Uint8Array(contentKey.length + userId.length + eventId.length);
  seed.set(contentKey, 0);
  seed.set(new TextEncoder().encode(`${userId}${eventId}`), contentKey.length);
  const keystream = blake3(seed, { dkLen: Math.max(1, input.length) });
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = (input[index] ?? 0) ^ (keystream[index] ?? 0);
  }
  return output;
}

/**
 * The `splitPii`, as a fixture.
 *
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
let codec: UserKeyedPiiCodec;
let eventLog: EventLogService;

beforeEach(() => {
  database = openDatabase(":memory:");
  codec = new UserKeyedPiiCodec(database);
  eventLog = new EventLogService({
    db: database,
    signingKeySource: keySource,
    piiEncryptor: codec,
  });
  __resetSessionAppendLocksForTest();
  for (const userId of [FIRST_USER, SECOND_USER]) {
    database
      .prepare(
        `INSERT INTO user_keys (user_id, encrypted_key_blob, key_version, created_at)
         VALUES (?, ?, 1, ?)`,
      )
      .run(userId, Buffer.alloc(32, userId.charCodeAt(0)), "2026-08-01T00:00:00.000Z");
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
  readonly pii_user_id: string | null;
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
 * The suite-local read projection: a row with no PII partition is returned
 * verbatim; otherwise the decrypted partition is merged back under its own keys.
 */
function projectForRead(row: StoredRow): Record<string, unknown> {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  if (row.pii_payload === null || row.pii_user_id === null) return payload;
  return { ...payload, ...codec.decrypt(row.pii_payload, row.pii_user_id, row.id) };
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
const FIRST_USER_EVENT_COUNT = 60;
const SECOND_USER_EVENT_COUNT = 4;
const TOTAL_PII_EVENT_COUNT = FIRST_USER_EVENT_COUNT + SECOND_USER_EVENT_COUNT;
/** Everything the pass may consider: the opener plus every PII row. */
const COMPACTABLE_EVENT_COUNT = SESSION_OPENER_EVENT_COUNT + TOTAL_PII_EVENT_COUNT;
/** Chosen to leave forty of the first user's rows live past the pass. */
const COMPACTION_COUNT_THRESHOLD = 44;
const EXPECTED_COMPACTED_ROWS = COMPACTABLE_EVENT_COUNT - COMPACTION_COUNT_THRESHOLD;
/** The stubbed prefix opens with the session-opener row, so one fewer PII row is stubbed. */
const COMPACTED_PII_ROW_COUNT = EXPECTED_COMPACTED_ROWS - SESSION_OPENER_EVENT_COUNT;
const LIVE_FIRST_USER_ROW_COUNT = FIRST_USER_EVENT_COUNT - COMPACTED_PII_ROW_COUNT;
/**
 * The opener and every PII row — and NOTHING else. `event.compacted` is
 * daemon-scope bound and lands on the sentinel partition, not here.
 */
const TOTAL_SESSION_ROW_COUNT = COMPACTABLE_EVENT_COUNT;
const LIVE_ROW_COUNT = TOTAL_SESSION_ROW_COUNT - EXPECTED_COMPACTED_ROWS;

/**
 * The sentinel partition after one lifecycle: the pass's `event.compacted`.
 *
 * Every `event_maintenance` type is bound to the daemon-scope sentinel, with
 * one carve-out back to a real session: an `event.compacted` scoped to a single
 * session's compaction MAY carry that session's id.
 */
const SENTINEL_ROW_COUNT = 1;

async function appendPiiEvent(index: number, userId: string, text: string): Promise<void> {
  // The clear half is a REAL `assistant.message` payload rather than fixture
  // bookkeeping: that type has a registered `SessionEventSchema` variant, and
  // the sealing codec parses the composed row against it before signing. An
  // `{ index }` payload would be refused — correctly, since the row it
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
  await eventLog.append(envelope, { pii: { userId, piiPayload: pii } });
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
    // The REAL store, over the REAL table — this file's `satisfies` convention
    // applied to the lifecycle seam. Nothing here seals a `content_payload`, so
    // every sweep is a legitimate no-op; what it proves is that the shipped store
    // survives being driven by the shipped pass end to end.
    contentKeyDisposer: new SessionContentKeyStore({
      database,
      masterKeySource: { read: async (): Promise<Uint8Array> => new Uint8Array(32).fill(11) },
    }),
    now: () => new Date(PASS_INSTANT),
    ...thresholds,
  });
}

/** Appends, then compacts — the whole lifecycle, once. */
async function runLifecycle(): Promise<CompactionPassResult> {
  // The session opens, exactly as the end-to-end lifecycle sentence has it.
  // It is also the row that proves the compacted prefix is not PII-only: a
  // stub projection that mishandled a payload with no PII partition would
  // fail here rather than at read time.
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
    payload: { sessionId: SESSION, config: {}, metadata: { title: "compaction end-to-end" } },
    version: ENVELOPE_VERSION,
  });

  for (let index = 0; index < FIRST_USER_EVENT_COUNT; index += 1) {
    await appendPiiEvent(index, FIRST_USER, `${FIRST_USER_PLAINTEXT}-${String(index)}`);
  }
  for (let index = 0; index < SECOND_USER_EVENT_COUNT; index += 1) {
    await appendPiiEvent(
      FIRST_USER_EVENT_COUNT + index,
      SECOND_USER,
      `${SECOND_USER_PLAINTEXT}-${String(index)}`,
    );
  }

  return buildCompactor({
    eventCountThreshold: COMPACTION_COUNT_THRESHOLD,
  }).tick();
}

describe("Compaction safety E2E — PII lifecycle through compaction", () => {
  it("compacts a prefix behind a real anchor and leaves a live PII tail", async () => {
    const compaction = await runLifecycle();

    // The pass must have actually run: a refusal here would make every
    // downstream assertion vacuous rather than failing.
    expect(compaction.sessionsRefused).toBe(0);
    expect(compaction.outcomes[0]?.refusedReason).toBeUndefined();
    expect(compaction.rowsStubbed).toBe(EXPECTED_COMPACTED_ROWS);

    const rows = storedRows();
    // The opener and 64 PII rows. The pass's `event.compacted` is on the sentinel.
    expect(rows).toHaveLength(TOTAL_SESSION_ROW_COUNT);
    const compacted = rows.filter((row) => row.retention_class === AUDIT_STUB_RETENTION_CLASS);
    const live = rows.filter((row) => row.retention_class === null);
    expect(compacted).toHaveLength(EXPECTED_COMPACTED_ROWS);
    // Forty of the first user's rows and four of the second one's.
    expect(live).toHaveLength(LIVE_ROW_COUNT);
    expect(live.filter((row) => row.pii_user_id === FIRST_USER)).toHaveLength(
      LIVE_FIRST_USER_ROW_COUNT,
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

  it("re-verifies the WHOLE chain after compaction — every signature, every link", async () => {
    const compaction = await runLifecycle();

    // The pass must have RUN. Both halves below are satisfied by an empty row
    // set, so a swallowed emission failure would vacate the arm rather than
    // fail it.
    expect(compaction.sessionsRefused).toBe(0);

    const { perRow, linkageDefect } = verifyWholeChain();

    // THE LOAD-BEARING PROPERTY. Stubbing the prefix leaves every live row's
    // signature and every link valid; canonical bytes bind `pii_payload` only
    // through its digest.
    expect(perRow).toHaveLength(LIVE_ROW_COUNT);
    expect(perRow.filter((verdict) => !verdict.valid)).toEqual([]);
    expect(linkageDefect).toBeUndefined();

    // And the sentinel partition the maintenance record landed on verifies too
    // — this is the ONLY place in the tree that checks the node-scope chain's
    // SIGNATURES rather than merely its linkage, so the row count is pinned: one
    // `event.compacted` for the single session this pass compacted.
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
      // Compaction NULLed both PII columns.
      expect(row.pii_payload).toBeNull();
      expect(row.pii_user_id).toBeNull();
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

  it("returns a PII-free row verbatim and a live PII row decrypted", async () => {
    await runLifecycle();
    const compactedRecord = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID).find(
      (row) => row.type === "event.compacted",
    );

    expect(compactedRecord).toBeDefined();
    if (compactedRecord === undefined) return;
    expect(compactedRecord.pii_payload).toBeNull();
    const projection = projectForRead(compactedRecord);
    expect(projection).toEqual(JSON.parse(compactedRecord.payload));

    // A live tail row keeps its ciphertext; reading it merges the text back.
    const liveSecondUserRow = storedRows().find(
      (row) => row.retention_class === null && row.pii_user_id === SECOND_USER,
    );
    if (liveSecondUserRow === undefined) {
      throw new Error("no live row for the second user survived compaction");
    }
    expect(liveSecondUserRow.pii_payload).not.toBeNull();
    expect(JSON.parse(liveSecondUserRow.payload)).not.toHaveProperty("text");
    expect(projectForRead(liveSecondUserRow)).toEqual({
      ...(JSON.parse(liveSecondUserRow.payload) as Record<string, unknown>),
      text: `${SECOND_USER_PLAINTEXT}-0`,
    });
  });

  it("proves the verifier CAN fail on a live row tampered with after compaction", async () => {
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

  it("spares the never-compacted categories through a SECOND pass (layer 1)", async () => {
    await runLifecycle();
    const sentinelBefore = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    const compactedRecordBefore = sentinelBefore.find((row) => row.type === "event.compacted");
    expect(compactedRecordBefore).toBeDefined();
    expect(sentinelBefore).toHaveLength(SENTINEL_ROW_COUNT);

    // A STORAGE pass with a zero byte budget, NOT a second count pass. The count
    // trigger's candidate set is the oldest rows beyond the newest
    // `eventCountThreshold`, so a partition's newest row is spared at every
    // threshold — and the first pass's `event.compacted` is the sentinel's newest
    // row. Under a count pass the maintenance row would therefore survive whether or not
    // layer 1 existed, and the arm would be asserting the trigger's prefix bound
    // rather than the category exclusion. A zero storage budget has no prefix
    // bound: every live compactable row is a candidate, so the exclusion is the
    // only thing left standing between these rows and a stub.
    const second = await buildCompactor({
      eventCountThreshold: COMPACTION_COUNT_THRESHOLD,
      storageThresholdBytes: 0,
    }).tick();
    expect(second.rowsStubbed).toBeGreaterThan(0);

    // The `event_maintenance` row on the sentinel partition — the first pass's
    // own `event.compacted` — is excluded by the SQL selector itself, layer 1 of
    // the three-layer enforcement. That the storage pass still stubbed rows
    // (asserted above) is what proves the exclusion is doing the work rather
    // than the trigger having gone quiet.
    const compactedRecordAfter = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID).find(
      (row) => row.id === compactedRecordBefore?.id,
    );
    expect(compactedRecordAfter?.retention_class).toBeNull();
    expect(compactedRecordAfter?.stub_signature).toBeNull();
    expect(compactedRecordAfter?.payload).toBe(compactedRecordBefore?.payload);

    // The second pass appends its OWN `event.compacted`, so the partition grows;
    // what must hold is that no row in it was ever stubbed.
    const sentinelAfter = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(sentinelAfter.length).toBeGreaterThan(sentinelBefore.length);
    expect(sentinelAfter.every((row) => row.retention_class === null)).toBe(true);

    // The chain still verifies on both partitions after the second pass.
    expect(verifyWholeChain().perRow.filter((verdict) => !verdict.valid)).toEqual([]);
    expect(verifyWholeChain().linkageDefect).toBeUndefined();
    const sentinelVerification = verifyWholeChain(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(sentinelVerification.perRow.filter((verdict) => !verdict.valid)).toEqual([]);
    expect(sentinelVerification.linkageDefect).toBeUndefined();
  });
});
