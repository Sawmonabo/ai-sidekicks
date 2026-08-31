// Contract coverage for verify-on-read over the machine-authored content
// partition — the digest binding and the hydrated read projection
// (Plan-006 T3.8).
//
// ---------------------------------------------------------------------------
// THE TWO QUESTIONS THIS FILE KEEPS APART
// ---------------------------------------------------------------------------
//
// A body that does not come back can mean two completely different things, and
// collapsing them is the failure this whole task exists to prevent:
//
//   * TAMPERING — the stored ciphertext no longer digests to what the row's
//     signature committed to. The signature stays green (it never covered the
//     ciphertext), so without the digest binding this surfaces only as an
//     unreadable body and gets absorbed into the ordinary transcript-loss
//     vocabulary. A loss report that can also mean "someone edited the column"
//     reports neither.
//   * LOSS — the key is unreachable, the wrapped key row is gone, the row was
//     compacted, or the body was never there. Each gets its own named reason and
//     none of them gets a fabricated empty body.
//
// Every arm below is one perturbation from a working hydrate, so a check that
// stopped checking fails here rather than passing on a coincidence. The reason
// union carries a completeness assertion: a seventh reason added without an arm
// fails this file.
//
// Spec coverage: `Spec-006 §Canonical Serialization Rules`,
// `Spec-006 §Compacted Event Format`. Refs: Plan-006 T3.8, I-006-3-07,
// I-006-3-08.

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
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
import { isContentCiphertextDigestBound, writeEventWithPii } from "../pii-indirection.js";
import {
  SESSION_CONTENT_KEY_BYTES,
  SessionContentKeyStore,
  SessionContentKeyUnavailableError,
  type DaemonMasterKeySource,
  type ResolvedSessionContentKey,
  type SessionContentKeyReader,
} from "../session-content-key-store.js";
import { GENESIS_PREV_HASH, type Ed25519PrivateKey } from "../signer.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");
const MASTER_KEY = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(3);
// Signing is incidental here — this file asserts over the content column and the
// digest binding, not over the signature — but the key still travels as the real
// branded type rather than through a cast that would admit any width.
const DAEMON_PRIVATE_KEY = new Uint8Array(32).fill(11) as Ed25519PrivateKey;

/**
 * The six reasons the projection may report, spelled out here so the coverage
 * assertion below compares against a list rather than against itself.
 */
const DECLARED_UNAVAILABLE_REASONS: readonly HydratedContentUnavailableReason[] = [
  "absent",
  "compacted",
  "master_key_unavailable",
  "wrapped_key_missing",
  "digest_unbound",
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
      payload: { runId: "run-1", ...extraPayload },
      version: ENVELOPE_VERSION,
      content: { body, contentKey: resolved.key },
    },
    GENESIS_PREV_HASH,
    { encrypt: () => Promise.reject(new Error("no PII on this row")) },
    DAEMON_PRIVATE_KEY,
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
    row: { envelope: written.envelope, contentPayload: ciphertext, retentionClass: null },
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
// The digest binding
// ----------------------------------------------------------------------------

describe("content ciphertext digest binding", () => {
  const CIPHERTEXT = new Uint8Array([1, 2, 3, 4, 5]);
  const DIGEST = bytesToHex(blake3(CIPHERTEXT));

  interface BindingCase {
    readonly name: string;
    readonly storedColumn: unknown;
    readonly signedPayload: unknown;
    readonly bound: boolean;
  }

  const BINDING_MATRIX: readonly BindingCase[] = [
    {
      name: "bytes matching the signed claim",
      storedColumn: CIPHERTEXT,
      signedPayload: { [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: DIGEST },
      bound: true,
    },
    {
      name: "no column and no claim",
      storedColumn: null,
      signedPayload: { runId: "run-1" },
      bound: true,
    },
    {
      name: "bytes with no signed claim",
      storedColumn: CIPHERTEXT,
      signedPayload: { runId: "run-1" },
      bound: false,
    },
    {
      name: "a signed claim with the column cleared",
      storedColumn: null,
      signedPayload: { [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: DIGEST },
      bound: false,
    },
    {
      name: "bytes replaced after signing",
      storedColumn: new Uint8Array([9, 9, 9, 9, 9]),
      signedPayload: { [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: DIGEST },
      bound: false,
    },
    {
      name: "a column that is neither bytes nor NULL",
      storedColumn: "not bytes",
      signedPayload: { [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: DIGEST },
      bound: false,
    },
    {
      name: "a column that is neither bytes nor NULL beside no claim",
      storedColumn: 42,
      signedPayload: { runId: "run-1" },
      bound: false,
    },
  ];

  for (const bindingCase of BINDING_MATRIX) {
    it(`reports ${bindingCase.name} as ${bindingCase.bound ? "bound" : "unbound"}`, () => {
      expect(
        isContentCiphertextDigestBound(bindingCase.storedColumn, bindingCase.signedPayload),
      ).toBe(bindingCase.bound);
    });
  }

  it("never throws, whatever it is handed", () => {
    // Load-bearing rather than defensive: a verifier consumes this inside a
    // range walk, where one throw silences audit of the entire remaining tail.
    const hostile: readonly unknown[] = [undefined, null, 0, "", [], {}, Symbol("x"), 1n];
    for (const storedColumn of hostile) {
      for (const signedPayload of hostile) {
        expect(() => isContentCiphertextDigestBound(storedColumn, signedPayload)).not.toThrow();
      }
    }
  });

  it("is independent of the participant digest on the same row", () => {
    // A row carrying both partitions must not have one binding answer for the
    // other — the two columns are digested under their own keys.
    const payload = {
      [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: DIGEST,
      pii_ciphertext_digest: bytesToHex(blake3(new Uint8Array([7, 7]))),
    };
    expect(isContentCiphertextDigestBound(CIPHERTEXT, payload)).toBe(true);
    expect(isContentCiphertextDigestBound(new Uint8Array([7, 7]), payload)).toBe(false);
  });
});

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

    // compacted
    const compacted = await reader.hydrate({
      envelope: makeEnvelope({ runId: "run-1" }),
      contentPayload: null,
      retentionClass: "audit_stub",
    });
    if (compacted.content.status === "unavailable") produced.add(compacted.content.reason);

    // digest_unbound
    const unbound = await reader.hydrate({
      ...row,
      contentPayload: new Uint8Array([1, 2, 3]),
    });
    if (unbound.content.status === "unavailable") produced.add(unbound.content.reason);

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

  it("returns the body and leaves the signed payload byte-identical", async () => {
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
    // so nothing downstream can mistake a projected body for a signed member.
    expect(hydrated.event).toBe(row.envelope);
    expect(JSON.stringify(hydrated.event.payload)).toBe(payloadBefore);
    expect(Object.hasOwn(hydrated.event.payload, "body")).toBe(false);
    // The body lives on the content arm and nowhere else — a caller can always
    // tell which members the daemon signed from which the read path supplied.
    expect(JSON.stringify(hydrated.event)).not.toContain("the model wrote this");
  });

  it("reports a replaced ciphertext as tampering, not as loss", async () => {
    const { reader, store } = buildReader();
    const { row } = await sealedRow(store, "the original prose");

    // Positive control first.
    expect((await reader.hydrate(row)).content.status).toBe("available");

    // One byte flipped in the stored column. The signature still verifies (it
    // never covered these bytes) and the key still opens nothing — but the row
    // must report tampering rather than an unreadable body.
    const replaced = Uint8Array.from(row.contentPayload as Uint8Array);
    replaced[replaced.length - 1] = (replaced[replaced.length - 1] ?? 0) ^ 0xff;
    expectUnavailable(await reader.hydrate({ ...row, contentPayload: replaced }), "digest_unbound");

    // And a ciphertext replaced with a WELL-FORMED seal of other prose is the
    // same verdict — the digest is what catches it, not the AEAD.
    const { ciphertext: foreign } = await sealedRow(store, "prose the model never wrote");
    expectUnavailable(await reader.hydrate({ ...row, contentPayload: foreign }), "digest_unbound");
  });

  it("reports a signed digest with the column cleared as tampering", async () => {
    const { reader, store } = buildReader();
    const { row } = await sealedRow(store, "the original prose");
    expectUnavailable(await reader.hydrate({ ...row, contentPayload: null }), "digest_unbound");
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

  it("passes a clean row carried from a peer with the column absent", async () => {
    // The relay shape: the column is node-local and excluded from the canonical
    // bytes, so a peer's history carries the signed payload with no ciphertext
    // under it. A row with neither the column nor a signed digest reads as an
    // ordinary body-less row rather than as tampering, which is what keeps the
    // digest arm honest for the rows that DO carry a claim.
    const { reader } = buildReader();
    const hydrated = await reader.hydrate({
      envelope: makeEnvelope({ runId: "run-1", receivedFromNodeId: "node-7" }),
      contentPayload: null,
      retentionClass: null,
    });
    expectUnavailable(hydrated, "absent");
  });

  it("reports a column that is neither bytes nor NULL as unbound rather than skipping it", async () => {
    const { reader, store } = buildReader();
    const { row } = await sealedRow(store, "the original prose");

    for (const hostileColumn of ["a string", 42, {}, []] as readonly unknown[]) {
      expectUnavailable(
        await reader.hydrate({ ...row, contentPayload: hostileColumn }),
        "digest_unbound",
      );
    }
  });

  it("names compaction rather than reporting a destroyed body as one that never was", async () => {
    const { reader } = buildReader();
    // A compacted row: the column is NULL and the stub payload carries no
    // digest, so steps 2 and 3 cannot tell it from a row that never had a body.
    expectUnavailable(
      await reader.hydrate({
        envelope: makeEnvelope({ contentLength: 4_000, contentTruncated: true }),
        contentPayload: null,
        retentionClass: "audit_stub",
      }),
      "compacted",
    );
  });

  it("names compaction even if the column somehow survived it", async () => {
    const { reader, store } = buildReader();
    const { row } = await sealedRow(store, "the original prose");
    // A compacted row that still holds bytes is a compaction defect, and
    // compaction is the fact this daemon recorded — so it is reported, rather
    // than the digest arm's tamper verdict, which would send an operator hunting
    // an attacker for a bug in the compactor.
    expectUnavailable(await reader.hydrate({ ...row, retentionClass: "audit_stub" }), "compacted");
  });

  it("carries the truncation marker through from the signed payload", async () => {
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
    // Echoed from the SIGNED payload, never recomputed: a recomputed length
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

  it("does not cache a failed key resolution across a batch", async () => {
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

    // A transient failure must not be cached for the life of the batch, so the
    // second row resolves again rather than inheriting the rejection.
    masterKeySource.failure = undefined;
    readCallCount = 0;
    const recovered = await reader.hydrateAll([first, second]);
    expect(recovered.map((entry) => entry.content.status)).toEqual(["available", "available"]);
    expect(readCallCount).toBe(1);
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
