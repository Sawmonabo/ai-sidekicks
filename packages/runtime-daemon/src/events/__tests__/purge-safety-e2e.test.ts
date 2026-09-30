// END-TO-END safety of the whole-session purge over PII-carrying rows.
//
// One lifecycle, run through the real modules in the order production runs them:
//
//   PII-carrying appends to two sessions through `EventLogService`
//     → a purge of one session
//
// and then asserts that the purged session is stubbed with its PII columns
// cleared, the kept session is whole and still decrypts, and the daemon-scope
// sentinel holds the purge's one receipt.
//
// The read projection and `splitPii` are suite-local fixtures. Everything
// else (the append path, the PII codec, the purge, the content key store) is
// the shipped code.

import { blake3 } from "@noble/hashes/blake3.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
  NodeIdSchema,
  SessionIdSchema,
  type NodeId,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { EventLogService, type UnsequencedEventEnvelope } from "../event-log-service.js";
import { type PiiEncryptionRequest, type PiiEncryptor } from "../pii-indirection.js";
import { __resetSessionAppendLocksForTest } from "../session-append-lock.js";
import { SessionContentKeyStore } from "../session-content-key-store.js";
import {
  AUDIT_STUB_RETENTION_CLASS,
  SessionPurge,
  type SessionPurgeEventLog,
  type SessionPurgeResult,
} from "../session-purge.js";

/** The session the person deletes. */
const SESSION: SessionId = SessionIdSchema.parse("33333333-4444-4555-8666-777777777777");
/** A session the person keeps, beside it in the same file. */
const KEPT_SESSION: SessionId = SessionIdSchema.parse("33333333-4444-4555-8666-777777777778");
const NODE: NodeId = NodeIdSchema.parse("node-purge-e2e-01");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");
const PURGE_INSTANT = "2026-08-04T12:00:00.000Z";

/** The user who authors the purged session. */
const FIRST_USER = "44444444-5555-4666-8777-888888888888";
/** A second author, who writes into both sessions. */
const SECOND_USER = "44444444-5555-4666-8777-888888888899";

const FIRST_USER_PLAINTEXT = "the-first-user-content";
const SECOND_USER_PLAINTEXT = "the-second-user-content";

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
// The stored row, as read back
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
  readonly pii_user_id: string | null;
  readonly retention_class: string | null;
}

function storedRows(sessionId: SessionId = SESSION): ReadonlyArray<StoredRow> {
  return database
    .prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence ASC")
    .all(sessionId) as ReadonlyArray<StoredRow>;
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

/** The `session.created` row every session opens with; purgeable like any other. */
const SESSION_OPENER_EVENT_COUNT = 1;
const PURGED_PII_EVENT_COUNT = 60;
const KEPT_PII_EVENT_COUNT = 4;
/** Every row of the purged session: the opener and its PII rows. */
const PURGED_SESSION_ROW_COUNT = SESSION_OPENER_EVENT_COUNT + PURGED_PII_EVENT_COUNT;
const KEPT_SESSION_ROW_COUNT = SESSION_OPENER_EVENT_COUNT + KEPT_PII_EVENT_COUNT;

async function appendSessionOpener(sessionId: SessionId): Promise<void> {
  // A payload its own registered `session.created` variant accepts: the append
  // path parses what it is about to store.
  await eventLog.append({
    id: `evt-created-${sessionId.slice(-4)}`,
    sessionId,
    occurredAt: "2026-08-01T00:00:00.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: null,
    payload: {
      sessionId,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444",
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    },
    version: ENVELOPE_VERSION,
  });
}

async function appendPiiEvent(
  sessionId: SessionId,
  index: number,
  userId: string,
  text: string,
): Promise<void> {
  // A real `assistant.message` payload: that type has a registered variant, and
  // the sealing codec parses the composed row against it before storing.
  const { clear, pii } = splitPii({ sessionId, runId: `run-${String(index)}`, text });
  const envelope: UnsequencedEventEnvelope = {
    id: `evt-${sessionId.slice(-4)}-${String(index).padStart(4, "0")}`,
    sessionId,
    occurredAt: "2026-08-01T00:00:00.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: null,
    payload: clear,
    version: ENVELOPE_VERSION,
  };
  await eventLog.append(envelope, { pii: { userId, piiPayload: pii } });
}

/** A purge over the real append path and the real key store. */
function buildPurge(): SessionPurge {
  return new SessionPurge({
    db: database,
    nodeId: NODE,
    // `satisfies` rather than a cast: this is the one file that wires the
    // shipped append service into the seam, so a drift between them is caught
    // here at compile time.
    eventLog: eventLog satisfies SessionPurgeEventLog,
    contentKeyDisposer: new SessionContentKeyStore({
      database,
      masterKeySource: { read: async (): Promise<Uint8Array> => new Uint8Array(32).fill(11) },
    }),
    now: () => new Date(PURGE_INSTANT),
  });
}

/** Appends to both sessions, then purges one: the whole lifecycle, once. */
async function runLifecycle(): Promise<SessionPurgeResult> {
  await appendSessionOpener(SESSION);
  for (let index = 0; index < PURGED_PII_EVENT_COUNT; index += 1) {
    await appendPiiEvent(SESSION, index, FIRST_USER, `${FIRST_USER_PLAINTEXT}-${String(index)}`);
  }
  await appendSessionOpener(KEPT_SESSION);
  for (let index = 0; index < KEPT_PII_EVENT_COUNT; index += 1) {
    await appendPiiEvent(
      KEPT_SESSION,
      index,
      SECOND_USER,
      `${SECOND_USER_PLAINTEXT}-${String(index)}`,
    );
  }
  return buildPurge().purge([SESSION]);
}

describe("Session purge safety E2E: PII lifecycle through a whole-session purge", () => {
  it("purges the session and leaves the kept session whole", async () => {
    const purge = await runLifecycle();

    // The purge must have run: a refusal would make every assertion below vacuous.
    expect(purge.refusedReason).toBeUndefined();
    expect(purge.outcomes).toEqual([
      {
        sessionId: SESSION,
        rowsStubbed: PURGED_SESSION_ROW_COUNT,
        fromSequence: 0,
        toSequence: PURGED_SESSION_ROW_COUNT - 1,
      },
    ]);

    const purged = storedRows(SESSION);
    expect(purged).toHaveLength(PURGED_SESSION_ROW_COUNT);
    expect(purged.every((row) => row.retention_class === AUDIT_STUB_RETENTION_CLASS)).toBe(true);
    // The opener carries no PII partition, so the stubbed set is not homogeneous.
    expect(purged[0]?.type).toBe("session.created");

    const kept = storedRows(KEPT_SESSION);
    expect(kept).toHaveLength(KEPT_SESSION_ROW_COUNT);
    expect(kept.every((row) => row.retention_class === null)).toBe(true);
    expect(kept.filter((row) => row.pii_user_id === SECOND_USER)).toHaveLength(
      KEPT_PII_EVENT_COUNT,
    );
  });

  it("clears the PII columns of every stub", async () => {
    await runLifecycle();

    const purged = storedRows(SESSION);
    expect(purged).toHaveLength(PURGED_SESSION_ROW_COUNT);
    for (const row of purged) {
      expect(row.pii_payload).toBeNull();
      expect(row.pii_user_id).toBeNull();
    }
  });

  it("returns the receipt verbatim and a kept PII row decrypted", async () => {
    await runLifecycle();
    const receipt = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID)[0];
    if (receipt === undefined) {
      throw new Error("the purge appended no receipt");
    }
    expect(receipt.pii_payload).toBeNull();
    expect(projectForRead(receipt)).toEqual(JSON.parse(receipt.payload));
    expect(JSON.parse(receipt.payload)).toMatchObject({
      removedSessions: [{ sessionId: SESSION, fromSeq: 0, toSeq: PURGED_SESSION_ROW_COUNT - 1 }],
    });

    const keptRow = storedRows(KEPT_SESSION).find((row) => row.pii_user_id === SECOND_USER);
    if (keptRow === undefined) {
      throw new Error("no PII row survived in the kept session");
    }
    expect(keptRow.pii_payload).not.toBeNull();
    expect(JSON.parse(keptRow.payload)).not.toHaveProperty("text");
    expect(projectForRead(keptRow)).toEqual({
      ...(JSON.parse(keptRow.payload) as Record<string, unknown>),
      text: `${SECOND_USER_PLAINTEXT}-0`,
    });
  });

  it("never stubs the maintenance rows, and a repeated purge changes nothing", async () => {
    await runLifecycle();
    const sentinelBefore = storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    const purgedBefore = storedRows(SESSION);

    // The sentinel partition holds only `event_maintenance` rows, so a purge
    // aimed straight at it finds nothing it may stub.
    const sentinelPurge = await buildPurge().purge([DAEMON_SCOPE_SENTINEL_SESSION_ID]);
    expect(sentinelPurge.outcomes).toEqual([
      { sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID, rowsStubbed: 0 },
    ]);
    const repeated = await buildPurge().purge([SESSION]);
    expect(repeated.outcomes).toEqual([{ sessionId: SESSION, rowsStubbed: 0 }]);

    // Byte-identical, and no second receipt.
    expect(storedRows(DAEMON_SCOPE_SENTINEL_SESSION_ID)).toEqual(sentinelBefore);
    expect(storedRows(SESSION)).toEqual(purgedBefore);
  });
});
