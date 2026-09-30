// Contract coverage for `EventLogService` — the sole durable append
// path.
//
// FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR, each of which fails silently if
// nobody asserts it:
//
//   1. PII INDIRECTION at the persistence boundary: the owner reaches its
//      durable column and the ciphertext reaches `pii_payload`, never the
//      plaintext `payload` column.
//   2. THE TYPED REFUSAL, asserted through `mapJsonRpcError` rather than through
//      `instanceof`. `daemon.event_canonical_bytes_exceeded` exists to reach a
//      CLIENT, and the thing a client reads is `data.type` beside `data.fields`.
//      An arm that stops at the throw would stay green through a detail that
//      never got parsed and therefore renders `undefined`.
//   3. SERIALIZATION. Concurrent appends on one session must not derive the same
//      sequence, reentrant appends must not deadlock, and a throwing
//      `transactionalPrelude` must consume no sequence.
//   4. THE HEAD READ BOUNDARY. A declared SQLite column type is AFFINITY and not
//      enforcement, so the head's `sequence` is read back as `unknown` and
//      narrowed. The next row's `sequence` is derived from that one read, which
//      is what makes a wrong-typed head a value that gets stored rather than
//      refused.
//

import { blake3 } from "@noble/hashes/blake3.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  DAEMON_EVENT_CANONICAL_BYTES_EXCEEDED_CODE,
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
import { EventLogService, type UnsequencedEventEnvelope } from "../event-log-service.js";
import {
  CodecOwnedContentKeyError,
  type PiiEncryptionRequest,
  type PiiEncryptor,
} from "../pii-indirection.js";
import { __resetSessionAppendLocksForTest, withSessionAppendLock } from "../session-append-lock.js";
import type { SessionContentKeySource } from "../session-content-key-store.js";
import { writeAcrossStrictTyping } from "../../session/__fixtures__/at-rest-tamper.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10");
const OTHER_SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");

// A UUID rather than a readable slug: `pii_user_id` is plain TEXT and the append
// types the id as a bare `string`, but the contracts' `UserIdSchema` is a UUID.
const USER = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";

let database: DatabaseType;

beforeEach(() => {
  // The production migration runner, never hand-rolled DDL: the terminal-key
  // triggers and the `UNIQUE(session_id, sequence)` key are all part of what these arms assert
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
 * Stub: an XOR over a BLAKE3 keystream seeded by
 * `userId || eventId`.
 *
 * Not an AEAD and not trying to be. It is DETERMINISTIC, which is what lets an
 * arm name expected bytes instead of re-deriving them, and it binds the two
 * identifiers in the one observable way a stub can — a ciphertext minted for one
 * (user, event) pair differs bytewise from every other pair's.
 * `writeEventWithPii` stores whatever bytes it is handed and asserts nothing
 * about their width, as an interface that fixes no AEAD requires.
 */
class DeterministicPiiEncryptor implements PiiEncryptor {
  encryptCallCount = 0;

  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array> {
    this.encryptCallCount += 1;
    const keystream = blake3(new TextEncoder().encode(`${request.userId} ${request.eventId}`), {
      dkLen: Math.max(1, request.plaintext.length),
    });
    const sealed = new Uint8Array(request.plaintext.length);
    for (let index = 0; index < request.plaintext.length; index += 1) {
      sealed[index] = (request.plaintext[index] ?? 0) ^ (keystream[index] ?? 0);
    }
    return Promise.resolve(sealed);
  }
}

interface ServiceFixture {
  readonly service: EventLogService;
  readonly encryptor: DeterministicPiiEncryptor;
}

/**
 * A content-key seam that always answers, so the SEALING branch of `#composeRow`
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
  const encryptor = new DeterministicPiiEncryptor();
  const service = new EventLogService({
    db: database,
    ...(options?.withoutEncryptor === true ? {} : { piiEncryptor: encryptor }),
    ...(options?.withContentKeySource === true
      ? { contentKeySource: ALWAYS_RESOLVING_CONTENT_KEY_SOURCE }
      : {}),
  });
  return { service, encryptor };
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

/** The stored row, hydrated into its envelope, its canonical bytes and the PII columns. */
interface HydratedRow {
  readonly envelope: EventEnvelope;
  readonly canonical: CanonicalBytes;
  readonly piiPayload: Uint8Array | null;
  readonly piiUserId: string | null;
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
  readonly pii_user_id: string | null;
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
 * That direction is the whole point: a reader recomputes from what was
 * PERSISTED, so an arm that canonicalized its own input would stay green through
 * a service that measured one form of the row and stored another.
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
    piiPayload: row.pii_payload,
    piiUserId: row.pii_user_id,
  };
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
// Sequence allocation
// ----------------------------------------------------------------------------

describe("EventLogService — sequence allocation", () => {
  it("allocates a gapless sequence from 0", async () => {
    const { service } = buildService();

    for (let index = 0; index < 6; index += 1) {
      await service.append(makeEnvelope({ payload: { index } }));
    }

    const rows = readRawRows(SESSION);
    expect(rows.map((row) => row.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("allocates per session — each session opens at its own sequence 0", async () => {
    const { service } = buildService();

    await service.append(makeEnvelope());
    await service.append(makeEnvelope({ sessionId: OTHER_SESSION }));
    await service.append(makeEnvelope());
    await service.append(makeEnvelope({ sessionId: OTHER_SESSION }));

    expect(readRawRows(SESSION).map((row) => row.sequence)).toEqual([0, 1]);
    expect(readRawRows(OTHER_SESSION).map((row) => row.sequence)).toEqual([0, 1]);
  });
});

// ----------------------------------------------------------------------------
// The head read boundary — `sequence` read as `unknown`, then narrowed
// ----------------------------------------------------------------------------
//
// The HEALTHY direction is already pinned by the sequence arms above, which
// allocate every row from the narrowed head. What is left is the refusal
// direction.

describe("EventLogService — head read boundary", () => {
  it("refuses a head whose sequence is not an INTEGER rather than allocating from it", async () => {
    // An edit to the file can leave TEXT in `sequence`, and SQLite orders TEXT
    // above every INTEGER, which is what makes the corrupted row the head that
    // `ORDER BY sequence DESC` selects.
    //
    // TWO rows seeded and the LOWER one corrupted, deliberately: with a single
    // row the corrupt value is the head whatever the query orders by, so the arm
    // would stay green through a head read that lost its `ORDER BY` entirely.
    const { service } = buildService();
    await service.append(makeEnvelope());
    await service.append(makeEnvelope());

    writeAcrossStrictTyping(database, "session_events", () => {
      database
        .prepare("UPDATE session_events SET sequence = 'x' WHERE session_id = ? AND sequence = 0")
        .run(SESSION);
    });

    await expect(service.append(makeEnvelope())).rejects.toThrow(
      /session_events\.sequence for session .+ is not an INTEGER: got a value of type string/,
    );
    // Unnarrowed, `Number('x') + 1` is `NaN` — bound as this row's `sequence`,
    // written into its canonical bytes, and stored.
    expect(readRawRows(SESSION)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// PII indirection at the persistence boundary
// ----------------------------------------------------------------------------

describe("EventLogService — PII indirection", () => {
  it("persists the owner in its durable column and the ciphertext in pii_payload", async () => {
    const { service, encryptor } = buildService();

    const receipt = await service.append(
      // A real `assistant.message` payload rather than `{}`: that type has a
      // registered `SessionEventSchema` variant, and the codec parses the
      // COMPOSED row against it before storing. An empty payload would be
      // refused for the two members the variant requires.
      makeEnvelope({
        category: "assistant_output",
        type: "assistant.message",
        payload: { sessionId: SESSION, runId: "run-1" },
      }),
      { pii: { userId: USER, piiPayload: { text: "secret prose" } } },
    );

    expect(encryptor.encryptCallCount).toBe(1);
    const [row] = readRawRows(SESSION);
    expect(row).toBeDefined();
    if (row === undefined) return;
    const hydrated = hydrate(row);

    expect(hydrated.piiUserId).toBe(USER);
    expect(hydrated.piiPayload).toBeInstanceOf(Uint8Array);

    // The plaintext never reaches the un-shreddable `payload` column.
    expect(row.payload).not.toContain("secret prose");
    expect(receipt.sequence).toBe(0);
  });

  it("leaves both PII columns NULL on a row that carries no partition", async () => {
    const { service, encryptor } = buildService();

    await service.append(makeEnvelope());

    const [row] = readRawRows(SESSION);
    expect(row?.pii_payload).toBeNull();
    expect(row?.pii_user_id).toBeNull();
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a PII partition when no encryptor is wired, rather than persisting it in the clear", async () => {
    const { service } = buildService({ withoutEncryptor: true });

    await expect(
      service.append(makeEnvelope({ category: "assistant_output" }), {
        pii: { userId: USER, piiPayload: { text: "secret prose" } },
      }),
    ).rejects.toThrow(/PiiEncryptor/);

    expect(readRawRows(SESSION)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// `daemon.event_canonical_bytes_exceeded` — the append ceiling
// ----------------------------------------------------------------------------

describe("EventLogService — daemon.event_canonical_bytes_exceeded", () => {
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
    // the ceiling — the bound is inclusive, and an off-by-one here is precisely
    // the defect the exact fixture exists to catch.
    expect(hydrate(row).canonical.length).toBe(EVENT_CANONICAL_BYTES_MAX);
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

  it("consumes no sequence on a refused oversized append", async () => {
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
// PARSE WHAT WILL BE STORED, on the branch that seals nothing — the plain-append
// half of the shared `assertRegisteredVariantParses` seam
// ----------------------------------------------------------------------------

describe("EventLogService — the plain branch parses what it stores", () => {
  /** A `session.created` payload its own registered variant accepts. */
  const validSessionCreatedPayload = {
    sessionId: SESSION,
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
  };

  it("refuses a REGISTERED type whose payload its own variant rejects", async () => {
    const { service } = buildService();

    await expect(
      service.append(
        makeEnvelope({ type: "session.created", payload: { note: "not the registered shape" } }),
      ),
    ).rejects.toThrow(
      /EventLogService\.append refuses to store an event of type "session\.created"/,
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

  it("refuses BEFORE writing — no row, no burnt sequence", async () => {
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

  it("still stores an UNREGISTERED census type carrying an ad-hoc payload", async () => {
    // THE TOLERANT-CARRIER CONTROL ON THIS PATH. `session.updated` is a census
    // member with no registered payload variant, and a reader must
    // "persist an envelope whose `type` it cannot interpret as a version
    // stub — never drop or reject it". A guard that refused here would reject
    // exactly the envelopes the stub path exists to preserve.
    const { service } = buildService();

    const receipt = await service.append(
      makeEnvelope({ type: "session.updated", payload: { anything: "at all", n: 7 } }),
    );

    expect(receipt.sequence).toBe(0);
    expect(readRawRows(SESSION)).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// The codec-owned CONTENT members on the plain path
// ----------------------------------------------------------------------------
//
// The plain-vs-codec branch is chosen from `options.content`, NOT from the
// payload. A caller that omits `options.content` and seeds `contentLength`
// therefore takes the plain branch, where nothing is sealed and the payload the
// caller supplied is the payload that gets stored — minting a row whose account
// of its own body describes prose the column does not hold. The reader echoes
// those members rather than recomputing them, so the refusal is at the write.

describe("EventLogService — codec-owned content keys are refused before the branch", () => {
  const validSessionCreatedPayload = {
    sessionId: SESSION,
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
  };

  const forgeableMembers: ReadonlyArray<readonly [string, unknown]> = [
    [CONTENT_LENGTH_PAYLOAD_KEY, 4096],
    [CONTENT_TRUNCATED_PAYLOAD_KEY, true],
  ];

  it.each(forgeableMembers)("refuses a payload pre-seeding %s", async (key, value) => {
    // BOTH: `contentLength` and `contentTruncated` are the row's own account of
    // how much prose there was and whether the bound fired, and a stored lie
    // about either is read back as truth by `SessionContentReader`, which
    // echoes them from the stored payload rather than recomputing them.
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
    // codec, whose own codec-owned-key check would still refuse it, but AS
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
            [CONTENT_LENGTH_PAYLOAD_KEY]: 4096,
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
    expect(refused.seededKey).toBe(CONTENT_LENGTH_PAYLOAD_KEY);
    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("refuses before writing — no row, no burnt sequence", async () => {
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
            [CONTENT_TRUNCATED_PAYLOAD_KEY]: true,
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

  it("refuses a TOLERANT CARRIER pre-seeding a codec-owned member, and says so", async () => {
    // `session.updated` is a census member with no registered strict variant,
    // so the accept-and-stub tolerance applies to its TYPE — and this guard
    // does not touch types. The reader echoes the member whatever the type, so
    // a forged length here misleads exactly as one on a registered type does.
    // Refusing a reserved MEMBER is not rejecting an uninterpretable envelope.
    const { service } = buildService();

    await expect(
      service.append(
        makeEnvelope({
          type: "session.updated",
          payload: { note: "ad hoc", [CONTENT_LENGTH_PAYLOAD_KEY]: 4096 },
        }),
      ),
    ).rejects.toThrow(/already carries contentLength/);

    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("still admits a tolerant carrier that seeds none of them (positive control)", async () => {
    // Without this the arm above could be refusing the TYPE rather than the
    // member — which is exactly the tolerance the guard must keep.
    const { service } = buildService();

    const receipt = await service.append(
      makeEnvelope({ type: "session.updated", payload: { anything: "at all", n: 7 } }),
    );

    expect(receipt.sequence).toBe(0);
    expect(readRawRows(SESSION)).toHaveLength(1);
  });

  it("leaves `contentType` alone — it is the producer's member", async () => {
    // The pair is exactly the two the codec DETERMINES. `contentType` is
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
});

// ----------------------------------------------------------------------------
// Serialization — the per-session append lock
// ----------------------------------------------------------------------------

describe("EventLogService — the append lock", () => {
  it("serializes concurrent appends on one session into one gapless sequence", async () => {
    const { service } = buildService();

    // Without the lock these interleave in the async compose step and two of
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
    // `append()`. the terminal emitter wraps its guard-swap-append in this
    // helper, so "the second one waits" has to hold for an arbitrary
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
    // The lock state is a module singleton, so a hold leaked on rejection
    // wedges the session for the life of the PROCESS. Nothing recovers without
    // a restart.
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
    // An owner that catches an inner rejection and carries on is still the owner
    // — if the inner rejection had released, the outer frame would be holding a
    // lock it no longer owns, its next nested call would queue behind itself,
    // and the release would fire twice.
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
    // re-derived by the next one from the durable head row.
    expect(database.prepare("SELECT COUNT(*) AS c FROM prelude_probe").get()).toEqual({ c: 0 });
    expect(readRawRows(SESSION)).toHaveLength(1);
    await expect(service.append(makeEnvelope())).resolves.toMatchObject({ sequence: 1 });
  });
});

// ----------------------------------------------------------------------------
// The run_lifecycle terminal-key backstop, seen from `append()`
// ----------------------------------------------------------------------------

function terminalEnvelope(payload: Record<string, unknown>): UnsequencedEventEnvelope {
  return makeEnvelope({ category: "run_lifecycle", type: "run.completed", payload });
}

describe("EventLogService — terminal-key backstop", () => {
  it("admits the first terminal event for a run and refuses the second", async () => {
    const { service } = buildService();

    await service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }));

    await expect(
      service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 })),
    ).rejects.toThrow(/UNIQUE/i);

    // Fail-LOUD, and the refusal costs no sequence: the INSERT aborts inside the
    // transaction, so the head row never moved.
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
    // welcomes. This is the shape a purge bug actually takes — a projection
    // that rebuilds `payload` from a key list and forgets to carry the run key
    // forward re-opens the duplicate-terminal bypass for the row's whole
    // retention life, silently. the projection is what keeps it closed; this arm
    // is what fails if it stops.
    const { service } = buildService();
    const receipt = await service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }));

    for (const droppedPayload of [{ runVersion: 1 }, { runId: "run-1" }, { summary: "purged" }]) {
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
