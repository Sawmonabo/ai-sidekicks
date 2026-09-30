// Contract coverage for the read projection over the machine-authored content
// partition: a stored row paired with the body its content column holds.
//
// A body that does not come back can mean different things — the key is
// unreachable, the wrapped key row is gone, the session was purged, the sealed
// bytes will not open, or the body was never there — and each gets its own
// named reason. None of them gets a fabricated empty body.
//
// Every arm below is one perturbation from a working hydrate, so a check that
// stopped checking fails here rather than passing on a coincidence. The reason
// list carries a completeness assertion: a reason the reader starts producing
// without an arm fails this file.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  EventEnvelopeVersionSchema,
  SessionIdSchema,
  type EventEnvelope,
  type HydratedContentUnavailableReason,
  type HydratedSessionEvent,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { SessionContentReader, type StoredEventContentRow } from "../content-read.js";
import { writeEventWithPii } from "../pii-indirection.js";
import {
  SESSION_CONTENT_KEY_BYTES,
  SessionContentKeyStore,
  SessionContentKeyUnavailableError,
  type DaemonMasterKeySource,
  type ResolvedSessionContentKey,
  type SessionContentKeyReader,
} from "../session-content-key-store.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");
const MASTER_KEY = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(3);

/**
 * The five reasons the reader reports, spelled out here so the coverage
 * assertion below compares against a list rather than against itself.
 */
const DECLARED_UNAVAILABLE_REASONS: readonly HydratedContentUnavailableReason[] = [
  "absent",
  "purged",
  "master_key_unavailable",
  "wrapped_key_missing",
  "decrypt_failed",
];

let database: DatabaseType;

beforeEach(() => {
  database = openDatabase(":memory:");
});

afterEach(() => {
  database.close();
});

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

class ScriptedMasterKeySource implements DaemonMasterKeySource {
  key: Uint8Array = MASTER_KEY;
  failure: Error | undefined;

  read(): Promise<Uint8Array> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.key);
  }
}

/** A reader that answers for no session — the wrapped-key-row-missing shape. */
class EmptyKeyReader implements SessionContentKeyReader {
  read(sessionId: SessionId): Promise<ResolvedSessionContentKey> {
    return Promise.reject(
      new SessionContentKeyUnavailableError("wrapped_key_missing", sessionId, "no row"),
    );
  }
}

let eventCounter = 0;

function nextEventId(): string {
  eventCounter += 1;
  return `evt-${String(eventCounter).padStart(4, "0")}`;
}

function makeEnvelope(payload: Record<string, unknown>, eventId?: string): EventEnvelope {
  return {
    id: eventId ?? nextEventId(),
    sessionId: SESSION,
    sequence: 1,
    occurredAt: "2026-08-30T12:00:00.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: "agent-1",
    payload,
    version: ENVELOPE_VERSION,
  };
}

/** Seals `body` under this session's real key and returns the row it produces. */
async function sealedRow(
  store: SessionContentKeyStore,
  body: string,
  extraPayload?: Record<string, unknown>,
): Promise<{ readonly row: StoredEventContentRow; readonly ciphertext: Uint8Array }> {
  const resolved = await store.resolveForWrite(SESSION);
  const written = await writeEventWithPii(
    {
      id: nextEventId(),
      sessionId: SESSION,
      sequence: 1,
      occurredAt: "2026-08-30T12:00:00.000Z",
      category: "assistant_output",
      type: "assistant.message",
      actor: "agent-1",
      // `sessionId` and `runId` are not decoration: `assistant.message` has a
      // registered `SessionEventSchema` variant, and the codec parses the
      // COMPOSED row against it before storing. A fixture missing either would
      // be minting exactly the unparseable row that guard exists to refuse.
      payload: { sessionId: SESSION, runId: "run-1", ...extraPayload },
      version: ENVELOPE_VERSION,
      content: { body, contentKey: resolved.key },
    },
    { encrypt: () => Promise.reject(new Error("no PII on this row")) },
  );
  // A checked narrowing rather than a non-null assertion: every input this
  // helper builds carries a content partition, so an absent column here would
  // be the codec silently dropping the body — which is the failure the arms
  // below exist to catch, and it must not be asserted away in the fixture.
  const ciphertext: Uint8Array | undefined = written.contentPayload;
  if (ciphertext === undefined) {
    throw new Error(
      "the codec returned no content partition for an input that carries one — every row this helper builds seals a body",
    );
  }
  return {
    row: {
      envelope: written.envelope,
      contentPayload: ciphertext,
      retentionClass: null,
    },
    ciphertext,
  };
}

function buildReader(): {
  readonly reader: SessionContentReader;
  readonly store: SessionContentKeyStore;
  readonly masterKeySource: ScriptedMasterKeySource;
} {
  const masterKeySource = new ScriptedMasterKeySource();
  const store = new SessionContentKeyStore({ database, masterKeySource });
  return { reader: new SessionContentReader({ keyReader: store }), store, masterKeySource };
}

function expectUnavailable(
  hydrated: HydratedSessionEvent,
  reason: HydratedContentUnavailableReason,
): void {
  expect(hydrated.content).toEqual({ status: "unavailable", reason });
}

// ----------------------------------------------------------------------------
// The hydrated projection
// ----------------------------------------------------------------------------

describe("hydrating machine-authored prose", () => {
  it("covers every reason the projection can report", async () => {
    // The completeness half. Each reason is produced by an arm below; this
    // assertion fails if the union grows without one.
    const { reader, store, masterKeySource } = buildReader();
    const produced = new Set<HydratedContentUnavailableReason>();

    const { row } = await sealedRow(store, "prose");

    // absent
    const absent = await reader.hydrate({
      envelope: makeEnvelope({ runId: "run-1" }),
      contentPayload: null,
      retentionClass: null,
    });
    if (absent.content.status === "unavailable") produced.add(absent.content.reason);

    // purged
    const purged = await reader.hydrate({
      envelope: makeEnvelope({ runId: "run-1" }),
      contentPayload: null,
      retentionClass: "audit_stub",
    });
    if (purged.content.status === "unavailable") produced.add(purged.content.reason);

    // decrypt_failed — the wrapped key row will not open under this master, and
    // the reader reports that as sealed-material-refused rather than guessing.
    masterKeySource.key = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(4);
    const wrongMaster = await reader.hydrate(row);
    if (wrongMaster.content.status === "unavailable") produced.add(wrongMaster.content.reason);

    // master_key_unavailable
    masterKeySource.failure = new Error("keystore is locked");
    const noMaster = await reader.hydrate(row);
    if (noMaster.content.status === "unavailable") produced.add(noMaster.content.reason);

    // wrapped_key_missing
    const missingKeyReader = new SessionContentReader({ keyReader: new EmptyKeyReader() });
    const noRow = await missingKeyReader.hydrate(row);
    if (noRow.content.status === "unavailable") produced.add(noRow.content.reason);

    expect([...produced].sort()).toEqual([...DECLARED_UNAVAILABLE_REASONS].sort());
  });

  it("returns the body and leaves the stored payload byte-identical", async () => {
    const { reader, store } = buildReader();
    const { row } = await sealedRow(store, "the model wrote this, verbatim");
    const payloadBefore = JSON.stringify(row.envelope.payload);

    const hydrated = await reader.hydrate(row);

    expect(hydrated.content).toEqual({
      status: "available",
      body: "the model wrote this, verbatim",
      contentLength: 30,
    });
    // The event travels through untouched — same object identity, same bytes —
    // so nothing downstream can mistake a projected body for a stored member.
    expect(hydrated.event).toBe(row.envelope);
    expect(JSON.stringify(hydrated.event.payload)).toBe(payloadBefore);
    expect(Object.hasOwn(hydrated.event.payload, "body")).toBe(false);
    // The body lives on the content arm and nowhere else — a caller can always
    // tell which members the daemon stored from which the read path supplied.
    expect(JSON.stringify(hydrated.event)).not.toContain("the model wrote this");
  });

  it("passes a clean row that never carried a body", async () => {
    const { reader } = buildReader();
    const hydrated = await reader.hydrate({
      envelope: makeEnvelope({ runId: "run-1", contentType: "text/markdown" }),
      contentPayload: null,
      retentionClass: null,
    });
    expectUnavailable(hydrated, "absent");
  });

  it("reports a column that is neither bytes nor NULL as undecryptable rather than skipping it", async () => {
    const { reader, store } = buildReader();
    const { row } = await sealedRow(store, "the original prose");

    for (const hostileColumn of ["a string", 42, {}, []] as readonly unknown[]) {
      expectUnavailable(
        await reader.hydrate({ ...row, contentPayload: hostileColumn }),
        "decrypt_failed",
      );
    }
  });

  it("names the purge rather than reporting a deleted body as one that never was", async () => {
    const { reader } = buildReader();
    // A purged row: the column is NULL, so without the retention class it
    // could not be told from a row that never had a body.
    expectUnavailable(
      await reader.hydrate({
        envelope: makeEnvelope({ contentLength: 4_000, contentTruncated: true }),
        contentPayload: null,
        retentionClass: "audit_stub",
      }),
      "purged",
    );
  });

  it("names the purge even if the column somehow survived it", async () => {
    const { reader, store } = buildReader();
    const { row } = await sealedRow(store, "the original prose");
    // A purged row that still holds bytes is a purge defect, and the purge is
    // the fact this daemon recorded — so it is reported rather than the body
    // the leftover bytes would open to.
    expectUnavailable(await reader.hydrate({ ...row, retentionClass: "audit_stub" }), "purged");
  });

  it("carries the truncation marker through from the stored payload", async () => {
    const { reader, store } = buildReader();
    const oversized = "a".repeat(262_144 + 10);
    const { row } = await sealedRow(store, oversized);

    const hydrated = await reader.hydrate(row);
    expect(hydrated.content).toEqual({
      status: "available",
      body: "a".repeat(262_144),
      contentLength: 262_154,
      contentTruncated: true,
    });
    // Echoed from the stored payload, never recomputed: a recomputed length
    // would equal the truncated length and erase the evidence.
    expect(row.envelope.payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(262_154);
    expect(row.envelope.payload[CONTENT_TRUNCATED_PAYLOAD_KEY]).toBe(true);
  });

  it("resolves one session's key once across a batch", async () => {
    const { store } = buildReader();
    let readCallCount = 0;
    const countingReader: SessionContentKeyReader = {
      read: async (sessionId: SessionId) => {
        readCallCount += 1;
        return store.read(sessionId);
      },
    };
    const reader = new SessionContentReader({ keyReader: countingReader });

    const rows: StoredEventContentRow[] = [];
    for (let index = 0; index < 5; index += 1) {
      rows.push((await sealedRow(store, `turn ${String(index)}`)).row);
    }

    const hydrated = await reader.hydrateAll(rows);
    expect(hydrated).toHaveLength(5);
    for (const [index, entry] of hydrated.entries()) {
      expect(entry.content).toMatchObject({ status: "available", body: `turn ${String(index)}` });
    }
    expect(readCallCount).toBe(1);
  });

  it("resolves one session's key once even when the read FAILS", async () => {
    // THE FAILED READ IS RETAINED FOR THE BATCH. Dropping it would make every
    // later row of the same session retry — N unwrap attempts for one broken
    // key, or N operator prompts when the master sits behind a hardware
    // ceremony, while `hydrateAll` documents "resolving each distinct session's
    // key at most once". The contract has to hold on the failure path or it is
    // not a contract.
    const { store, masterKeySource } = buildReader();
    let readCallCount = 0;
    const countingReader: SessionContentKeyReader = {
      read: async (sessionId: SessionId) => {
        readCallCount += 1;
        return store.read(sessionId);
      },
    };
    const reader = new SessionContentReader({ keyReader: countingReader });

    const rows: StoredEventContentRow[] = [];
    for (let index = 0; index < 5; index += 1) {
      rows.push((await sealedRow(store, `turn ${String(index)}`)).row);
    }

    masterKeySource.failure = new Error("keystore is locked");
    readCallCount = 0;
    const hydrated = await reader.hydrateAll(rows);

    expect(readCallCount).toBe(1);
    // And EVERY row settles on the same classified reason — not a mix that
    // depends on which row happened to be first.
    expect(hydrated).toHaveLength(5);
    for (const entry of hydrated) {
      expectUnavailable(entry, "master_key_unavailable");
    }
  });

  it("retries on a FRESH call, so retention is scoped to the batch and not the reader", async () => {
    // Retrying is not lost, it is re-scoped to the caller: `hydrateAll` builds a
    // fresh map per call and `hydrate` one per row. This is what keeps the
    // retention honest — a reader that cached across calls would need
    // invalidation the class deliberately refuses to own.
    const { store, masterKeySource } = buildReader();
    let readCallCount = 0;
    const countingReader: SessionContentKeyReader = {
      read: async (sessionId: SessionId) => {
        readCallCount += 1;
        return store.read(sessionId);
      },
    };
    const reader = new SessionContentReader({ keyReader: countingReader });
    const first = (await sealedRow(store, "turn one")).row;
    const second = (await sealedRow(store, "turn two")).row;

    masterKeySource.failure = new Error("keystore is locked");
    const failed = await reader.hydrateAll([first]);
    expectUnavailable(failed[0]!, "master_key_unavailable");

    masterKeySource.failure = undefined;
    readCallCount = 0;
    const recovered = await reader.hydrateAll([first, second]);
    expect(recovered.map((entry) => entry.content.status)).toEqual(["available", "available"]);
    expect(readCallCount).toBe(1);
  });

  it("keeps a per-row `hydrate` call independent of any earlier failure", async () => {
    // `hydrate` makes its own map per row, so the single-row entry point is
    // unaffected by the batch retention in either direction.
    const { store, masterKeySource } = buildReader();
    const { row } = await sealedRow(store, "the original prose");
    const reader = new SessionContentReader({ keyReader: store });

    masterKeySource.failure = new Error("keystore is locked");
    expectUnavailable(await reader.hydrate(row), "master_key_unavailable");

    masterKeySource.failure = undefined;
    expect((await reader.hydrate(row)).content).toMatchObject({
      status: "available",
      body: "the original prose",
    });
  });

  it("never fabricates an empty body on any unavailable path", async () => {
    const { reader, store, masterKeySource } = buildReader();
    const { row } = await sealedRow(store, "the original prose");
    masterKeySource.failure = new Error("keystore is locked");

    const hydrated = await reader.hydrate(row);
    expect(hydrated.content.status).toBe("unavailable");
    expect(Object.hasOwn(hydrated.content, "body")).toBe(false);
  });
});
