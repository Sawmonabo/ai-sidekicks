// The machine-authored content partition: the codec seals a body bound to its session and event,
// the session content key store keeps one wrapped key per session and never loses a live one, and
// the append path joins them.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_PAYLOAD_PLAINTEXT_MAX,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  EventEnvelopeVersionSchema,
  SessionIdSchema,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { canonicalizeEvent } from "../canonicalizer.js";
import { EventLogService, type UnsequencedEventEnvelope } from "../event-log-service.js";
import {
  BODY_BEARING_EVENT_TYPES,
  openContentPayload,
  writeEventWithPii,
  type ContentOnlyEventInput,
  type PiiCarryingEventInput,
  type PiiEncryptor,
  type PiiEventWriteResult,
  type RawEventInput,
} from "../pii-indirection.js";
import { __resetSessionAppendLocksForTest } from "../session-append-lock.js";
import {
  SESSION_CONTENT_KEY_BYTES,
  SESSION_CONTENT_WRAP_NONCE_BYTES,
  SessionContentKeyStore,
  type SessionContentKeyUnavailableReason,
} from "../session-content-key-store.js";
import {
  DeterministicPiiEncryptor,
  ScriptedMasterKeySource,
  bytesToHex,
  nextEventId,
} from "./event-test-fixtures.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10");
const OTHER_SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");
const USER = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";

/** A deterministic 32-byte content key, so an arm can name the bytes it expects. */
const CONTENT_KEY = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(7);
const MASTER_KEY = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(3);
const ROTATED_MASTER_KEY = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(4);

let database: DatabaseType;

beforeEach(() => {
  // The production migration runner, never hand-rolled DDL: the CHECK constraints and the
  // `session_content_keys` primary key are part of what these arms assert against.
  database = openDatabase(":memory:");
  __resetSessionAppendLocksForTest();
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
  database.close();
});

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

function makeContentOnlyInput(overrides?: {
  readonly body?: string;
  readonly contentKey?: Uint8Array;
  readonly payload?: Record<string, unknown>;
}): ContentOnlyEventInput {
  return {
    id: nextEventId(),
    sessionId: SESSION,
    sequence: 1,
    occurredAt: "2026-08-30T12:00:00.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: "agent-1",
    payload: overrides?.payload ?? {
      sessionId: SESSION,
      runId: "run-1",
      contentType: "text/markdown",
    },
    version: ENVELOPE_VERSION,
    content: {
      body: overrides?.body ?? "the assistant said this",
      contentKey: overrides?.contentKey ?? CONTENT_KEY,
    },
  };
}

function makePiiCarryingInput(overrides?: {
  readonly withContent?: boolean;
}): PiiCarryingEventInput {
  return {
    id: nextEventId(),
    sessionId: SESSION,
    sequence: 1,
    occurredAt: "2026-08-30T12:00:00.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: "agent-1",
    payload: { sessionId: SESSION, runId: "run-1" },
    version: ENVELOPE_VERSION,
    piiUserId: USER,
    piiPayload: { quoted: "something a person typed" },
    ...(overrides?.withContent === true
      ? { content: { body: "the assistant said this", contentKey: CONTENT_KEY } }
      : {}),
  };
}

function seal(input: RawEventInput, encryptor: PiiEncryptor): Promise<PiiEventWriteResult> {
  return writeEventWithPii(input, encryptor);
}

// ----------------------------------------------------------------------------
// Key substitution: a wrapped key replayed under another session or version must not open
// ----------------------------------------------------------------------------

interface KeyStoreFailureCase {
  readonly name: string;
  readonly reason: SessionContentKeyUnavailableReason;
  /** Arranges the failure and returns the read to run. */
  readonly arrange: (
    store: SessionContentKeyStore,
    masterKeySource: ScriptedMasterKeySource,
  ) => Promise<unknown>;
}

const KEY_STORE_FAILURE_MATRIX: readonly KeyStoreFailureCase[] = [
  {
    name: "a wrapped blob moved to another session's row",
    reason: "wrapped_key_unopenable",
    arrange: async (store) => {
      await store.resolveForWrite(SESSION);
      await store.resolveForWrite(OTHER_SESSION);
      const donor = database
        .prepare(`SELECT encrypted_key_blob FROM session_content_keys WHERE session_id = ?`)
        .get(SESSION) as { readonly encrypted_key_blob: Uint8Array };
      database
        .prepare(`UPDATE session_content_keys SET encrypted_key_blob = ? WHERE session_id = ?`)
        .run(donor.encrypted_key_blob, OTHER_SESSION);
      return store.read(OTHER_SESSION);
    },
  },
  {
    name: "a wrapped blob replayed under another key version",
    reason: "wrapped_key_unopenable",
    arrange: async (store) => {
      await store.resolveForWrite(SESSION);
      // Only the version moves; the blob is untouched. This is the rollback a re-wrap's version
      // bump forecloses.
      database
        .prepare(`UPDATE session_content_keys SET key_version = 2 WHERE session_id = ?`)
        .run(SESSION);
      return store.read(SESSION);
    },
  },
];

/** A content row with the named members replaced. */
function contentRowWith(overrides: Record<string, unknown>): RawEventInput {
  return { ...makeContentOnlyInput(), ...overrides } as unknown as RawEventInput;
}

/**
 * The `type` / `category` / `payload` trio a body-bearing row of `eventType` needs to satisfy that
 * type's own registered `SessionEventSchema` variant. The payloads differ by type: the tool
 * variants require `toolName`, the assistant ones declare none, and the reviewer's denial carries
 * approval fields, all under `.strict()`.
 */
function bodyBearingRowFor(eventType: string): Record<string, unknown> {
  if (eventType === "approval.reviewer_denied") {
    return {
      type: eventType,
      category: "approval_flow",
      payload: {
        sessionId: SESSION,
        runId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        agentId: "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b",
        denialId: "5f2b4d5e-ffff-4fff-8fff-ffffffffffff",
        eventId: "item-9",
        reason: "[Data Exfiltration]",
        overridable: true,
      },
    };
  }
  return eventType.startsWith("assistant.")
    ? {
        type: eventType,
        category: "assistant_output",
        payload: { sessionId: SESSION, runId: "run-1", contentType: "text/markdown" },
      }
    : {
        type: eventType,
        category: "tool_activity",
        payload: { sessionId: SESSION, runId: "run-1", toolName: "read_file" },
      };
}

/**
 * One macrotask turn. A microtask flush would not give an unguarded delete the chance to commit,
 * since the lock's queue and the delete both settle on the microtask queue.
 */
async function macrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function buildKeyStore(): {
  readonly store: SessionContentKeyStore;
  readonly masterKeySource: ScriptedMasterKeySource;
} {
  const masterKeySource = new ScriptedMasterKeySource(MASTER_KEY);
  return {
    store: new SessionContentKeyStore({ database, masterKeySource }),
    masterKeySource,
  };
}

describe("session content key substitution", () => {
  for (const failure of KEY_STORE_FAILURE_MATRIX) {
    it(`reports ${failure.name} as ${failure.reason}`, async () => {
      const { store, masterKeySource } = buildKeyStore();
      await expect(failure.arrange(store, masterKeySource)).rejects.toMatchObject({
        name: "SessionContentKeyUnavailableError",
        reason: failure.reason,
      });
    });
  }
});

// ----------------------------------------------------------------------------
// Routing: each partition combination lands the columns and members it owes, and no others
// ----------------------------------------------------------------------------

/** Which columns and which codec-added payload members one partition combination owes. */
interface CodecRoutingExpectation {
  readonly piiColumnPresent: boolean;
  readonly contentColumnPresent: boolean;
  readonly encryptorCalled: boolean;
  readonly codecPayloadKeys: readonly string[];
}

interface CodecRoutingCase {
  readonly name: string;
  readonly build: () => RawEventInput;
  readonly expected: CodecRoutingExpectation;
}

const CODEC_ROUTING_MATRIX: readonly CodecRoutingCase[] = [
  {
    name: "user partition alone",
    build: () => makePiiCarryingInput(),
    expected: {
      piiColumnPresent: true,
      contentColumnPresent: false,
      encryptorCalled: true,
      codecPayloadKeys: [],
    },
  },
  {
    name: "machine content partition alone",
    build: () => makeContentOnlyInput(),
    expected: {
      piiColumnPresent: false,
      contentColumnPresent: true,
      encryptorCalled: false,
      codecPayloadKeys: [CONTENT_LENGTH_PAYLOAD_KEY],
    },
  },
  {
    name: "both partitions on one row",
    build: () => makePiiCarryingInput({ withContent: true }),
    expected: {
      piiColumnPresent: true,
      contentColumnPresent: true,
      encryptorCalled: true,
      codecPayloadKeys: [CONTENT_LENGTH_PAYLOAD_KEY],
    },
  },
];

describe("content partition routing", () => {
  for (const routingCase of CODEC_ROUTING_MATRIX) {
    it(`routes ${routingCase.name} into the columns and members it owes`, async () => {
      const encryptor = new DeterministicPiiEncryptor();
      const result = await seal(routingCase.build(), encryptor);

      expect(result.piiPayload !== undefined).toBe(routingCase.expected.piiColumnPresent);
      expect(result.contentPayload !== undefined).toBe(routingCase.expected.contentColumnPresent);
      expect(encryptor.encryptCallCount > 0).toBe(routingCase.expected.encryptorCalled);

      const payload = result.envelope.payload as Record<string, unknown>;
      for (const key of routingCase.expected.codecPayloadKeys) {
        expect(Object.hasOwn(payload, key)).toBe(true);
      }
      // The content length member never leaks onto a row that carries no body.
      if (!routingCase.expected.codecPayloadKeys.includes(CONTENT_LENGTH_PAYLOAD_KEY)) {
        expect(Object.hasOwn(payload, CONTENT_LENGTH_PAYLOAD_KEY)).toBe(false);
      }
      // No body here exceeds the bound, so `contentTruncated` is absent.
      expect(Object.hasOwn(payload, CONTENT_TRUNCATED_PAYLOAD_KEY)).toBe(false);
    });
  }
});

// ----------------------------------------------------------------------------
// The sealing codec's content half
// ----------------------------------------------------------------------------

describe("machine content sealing", () => {
  it("binds the sealed bytes to this session and this event and no other", async () => {
    const input = makeContentOnlyInput();
    const result = await seal(input, new DeterministicPiiEncryptor());
    const sealed = result.contentPayload!;

    // Positive control first, so each refusal below is one perturbation from a working open.
    expect(openContentPayload(sealed, CONTENT_KEY, SESSION, input.id)).toBe(
      "the assistant said this",
    );
    expect(() => openContentPayload(sealed, CONTENT_KEY, OTHER_SESSION, input.id)).toThrow();
    expect(() => openContentPayload(sealed, CONTENT_KEY, SESSION, "evt-other")).toThrow();
    const wrongKey = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(8);
    expect(() => openContentPayload(sealed, wrongKey, SESSION, input.id)).toThrow();
  });

  it("keeps the stored ciphertext out of the canonical bytes", async () => {
    const input = makeContentOnlyInput();
    const result = await seal(input, new DeterministicPiiEncryptor());

    // The ciphertext must not appear in the canonical form.
    const canonical = canonicalizeEvent(result.envelope);
    const canonicalText = new TextDecoder().decode(canonical);
    expect(canonicalText).not.toContain(bytesToHex(result.contentPayload!.subarray(0, 8)));
  });

  it("keeps the ciphertext out of the measured canonical byte length", async () => {
    const short = await seal(makeContentOnlyInput({ body: "x" }), new DeterministicPiiEncryptor());
    const long = await seal(
      makeContentOnlyInput({ body: "y".repeat(50_000) }),
      new DeterministicPiiEncryptor(),
    );

    // A 50 KB body grows the ciphertext by 50 KB but the canonical bytes only by the digits of
    // `contentLength`, so a large tool result cannot push a row past the canonical ceiling.
    expect(long.contentPayload!.length - short.contentPayload!.length).toBeGreaterThan(49_000);
    expect(long.canonicalByteLength - short.canonicalByteLength).toBeLessThan(10);
  });
});

describe("the plaintext bound", () => {
  /** Multi-byte on purpose: the cut has to land on a codepoint boundary. */
  const EM_DASH = "—";
  const EM_DASH_BYTES = 3;

  it("leaves a body exactly at the bound whole and unmarked", async () => {
    const body = "a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX);
    const result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX);
    expect(Object.hasOwn(payload, CONTENT_TRUNCATED_PAYLOAD_KEY)).toBe(false);
  });

  it("cuts at a codepoint boundary when the bound lands mid-sequence", async () => {
    // One filler byte short of the bound, then a three-byte codepoint straddling it. A byte-exact
    // cut would emit a truncated UTF-8 sequence.
    const filler = "a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX - 1);
    const body = `${filler}${EM_DASH}${EM_DASH}`;
    const result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(payload[CONTENT_TRUNCATED_PAYLOAD_KEY]).toBe(true);
    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(
      CONTENT_PAYLOAD_PLAINTEXT_MAX - 1 + EM_DASH_BYTES * 2,
    );
    // The open uses a fatal decoder, so a mid-codepoint cut would throw.
    const opened = openContentPayload(
      result.contentPayload!,
      CONTENT_KEY,
      SESSION,
      result.envelope.id,
    );
    expect(opened).toBe(filler);
    expect(new TextEncoder().encode(opened).length).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX - 1);
  });

  it("cuts an astral codepoint whole when the bound lands inside it", async () => {
    // Three filler bytes short of the bound, then a four-byte code point. It is dropped whole, and
    // the fatal decoder proves no half survived.
    const seedling = "\u{1F331}";
    const filler = "a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX - 3);
    const body = `${filler}${seedling}`;
    const result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX + 1);
    expect(payload[CONTENT_TRUNCATED_PAYLOAD_KEY]).toBe(true);
    expect(
      openContentPayload(result.contentPayload!, CONTENT_KEY, SESSION, result.envelope.id),
    ).toBe(filler);
  });
});

describe("codec refusals over the content partition", () => {
  it("refuses a payload missing a member its registered variant requires", async () => {
    // The composed row is parsed against its own registered variant after the seal: a row that
    // fails the strict layer would be unreadable as anything but a stub.
    await expect(
      seal(makeContentOnlyInput({ payload: { runId: "run-1" } }), new DeterministicPiiEncryptor()),
    ).rejects.toThrow(/payload\.sessionId \(invalid_type\)/);
  });

  it("seals a body on every event type the contracts union registers as body-bearing", async () => {
    // Drives whatever `BODY_BEARING_EVENT_TYPES` derives from the `SessionEvent` union; re-listing
    // the types here would be a second source of truth.
    const bodyBearingTypes = Object.keys(BODY_BEARING_EVENT_TYPES);
    // Non-vacuity: a derivation collapsed to `never` would drive nothing.
    expect(bodyBearingTypes.length).toBeGreaterThan(0);

    for (const bodyBearingType of bodyBearingTypes) {
      const result = await seal(
        contentRowWith(bodyBearingRowFor(bodyBearingType)),
        new DeterministicPiiEncryptor(),
      );
      expect(result.contentPayload).toBeInstanceOf(Uint8Array);
    }
  });

  it("admits a well-formed surrogate pair and refuses every unpaired shape", async () => {
    // `TextEncoder` swaps an unpaired surrogate for U+FFFD instead of refusing, so only this guard
    // keeps the stored body equal to the producer's text. A pair is ordinary text and round-trips.
    const paired = "an emoji \u{1F331} in ordinary prose";
    const result = await seal(
      makeContentOnlyInput({ body: paired }),
      new DeterministicPiiEncryptor(),
    );
    expect(
      openContentPayload(result.contentPayload!, CONTENT_KEY, SESSION, result.envelope.id),
    ).toBe(paired);

    // Every unpaired shape: a lone lead, a lone trail, a lead before text, a trail before any lead,
    // and a lead in the final position.
    const illFormedBodies: readonly string[] = [
      "\ud800",
      "\udc00",
      "lead \ud83c then text",
      "text then trail \udfff more",
      "a body ending on a lead \ud83c",
    ];
    for (const illFormedBody of illFormedBodies) {
      await expect(
        seal(makeContentOnlyInput({ body: illFormedBody }), new DeterministicPiiEncryptor()),
      ).rejects.toThrow(/well-formed UTF-16/);
    }
  });
});

// ----------------------------------------------------------------------------
// The session content key store
// ----------------------------------------------------------------------------

describe("session content key custody", () => {
  it("mints a distinct key per session", async () => {
    const { store } = buildKeyStore();
    const first = await store.resolveForWrite(SESSION);
    const second = await store.resolveForWrite(OTHER_SESSION);
    expect(second.key).not.toEqual(first.key);
  });

  it("never persists the key in the clear", async () => {
    const { store } = buildKeyStore();
    const resolved = await store.resolveForWrite(SESSION);
    const stored = database
      .prepare(`SELECT encrypted_key_blob FROM session_content_keys WHERE session_id = ?`)
      .get(SESSION) as { readonly encrypted_key_blob: Uint8Array };

    expect(bytesToHex(stored.encrypted_key_blob)).not.toContain(bytesToHex(resolved.key));
    expect(stored.encrypted_key_blob.length).toBeGreaterThan(
      SESSION_CONTENT_WRAP_NONCE_BYTES + SESSION_CONTENT_KEY_BYTES,
    );
  });

  it("re-wraps every row onto a new master without touching the inner key", async () => {
    const { store, masterKeySource } = buildKeyStore();
    const before = await store.resolveForWrite(SESSION);
    const otherBefore = await store.resolveForWrite(OTHER_SESSION);

    // A body sealed under the inner key before the rotation shows the rotation moved the envelope,
    // not the material.
    const sealedBody = await seal(
      makeContentOnlyInput({ contentKey: before.key }),
      new DeterministicPiiEncryptor(),
    );

    expect(store.rewrapAll(MASTER_KEY, ROTATED_MASTER_KEY)).toBe(2);

    masterKeySource.key = ROTATED_MASTER_KEY;
    const after = await store.read(SESSION);
    expect(after.key).toEqual(before.key);
    expect(after.keyVersion).toBe(2);
    expect((await store.read(OTHER_SESSION)).key).toEqual(otherBefore.key);
    expect(
      openContentPayload(sealedBody.contentPayload!, after.key, SESSION, sealedBody.envelope.id),
    ).toBe("the assistant said this");

    // The superseded master no longer opens the row, so a rollback to a destroyed key is
    // foreclosed.
    masterKeySource.key = MASTER_KEY;
    await expect(store.read(SESSION)).rejects.toMatchObject({
      reason: "wrapped_key_unopenable",
    });
    expect(
      database
        .prepare(`SELECT rotated_at FROM session_content_keys WHERE session_id = ?`)
        .get(SESSION),
    ).not.toEqual({ rotated_at: null });
  });

  // --------------------------------------------------------------------------
  // The mint / rotate-on-shred race
  // --------------------------------------------------------------------------
  //
  // A first mint reads master `M`, yields at its own `await`, and wakes after rotate-on-shred has
  // installed `M'` and destroyed `M`. Rotation's `BEGIN EXCLUSIVE` cannot help because no row
  // exists yet. Without a guard the blob lands wrapped under a destroyed key, and every later
  // read of that session's bodies fails while integrity checks stay green.
  // `ScriptedMasterKeySource.beforeRead` arranges that interleaving.

  it("never persists a key wrapped under a master that rotation destroyed", async () => {
    const { store, masterKeySource } = buildKeyStore();
    // A row rotation will really re-wrap, so this is not an epoch bump over an empty table.
    const otherBefore = await store.resolveForWrite(OTHER_SESSION);
    expect(masterKeySource.readCallCount).toBe(1);

    masterKeySource.beforeRead = () => {
      // One-shot, so the retry sees a settled world instead of hitting the retry ceiling.
      masterKeySource.beforeRead = undefined;
      store.rewrapAll(MASTER_KEY, ROTATED_MASTER_KEY);
      masterKeySource.key = ROTATED_MASTER_KEY;
    };

    const minted = await store.resolveForWrite(SESSION);

    // Two reads for this mint: the one that lost the race, and the retry.
    expect(masterKeySource.readCallCount).toBe(3);

    // `resolveForWrite` returns a usable key either way, so the failure shows only on a later read.
    const reread = await store.read(SESSION);
    expect(reread.key).toEqual(minted.key);
    // The row rotation did move is still readable too, so one operation did not
    // cost the other.
    expect((await store.read(OTHER_SESSION)).key).toEqual(otherBefore.key);
    // And the minted row is at the fresh master's version rather than carrying a
    // stale envelope forward.
    expect(
      database
        .prepare(`SELECT key_version FROM session_content_keys WHERE session_id = ?`)
        .get(SESSION),
    ).toEqual({ key_version: 1 });
  });
});

// ----------------------------------------------------------------------------
// The append path, end to end
// ----------------------------------------------------------------------------

describe("appending a row that carries machine-authored prose", () => {
  function buildAppendFixture(options?: { readonly withoutKeySource?: boolean }): {
    readonly service: EventLogService;
    readonly store: SessionContentKeyStore;
    readonly masterKeySource: ScriptedMasterKeySource;
  } {
    const masterKeySource = new ScriptedMasterKeySource(MASTER_KEY);
    const store = new SessionContentKeyStore({ database, masterKeySource });
    const service = new EventLogService({
      db: database,
      piiEncryptor: new DeterministicPiiEncryptor(),
      ...(options?.withoutKeySource === true ? {} : { contentKeySource: store }),
    });
    return { service, store, masterKeySource };
  }

  function makeAssistantEnvelope(): UnsequencedEventEnvelope {
    return {
      id: nextEventId(),
      sessionId: SESSION,
      occurredAt: "2026-08-30T12:00:00.000Z",
      category: "assistant_output",
      type: "assistant.message",
      actor: "agent-1",
      payload: { sessionId: SESSION, runId: "run-1", contentType: "text/markdown" },
      version: ENVELOPE_VERSION,
    };
  }

  interface StoredRow {
    readonly payload: string;
    readonly content_payload: Uint8Array | null;
    readonly pii_payload: Uint8Array | null;
  }

  function readStoredRow(eventId: string): StoredRow {
    return database
      .prepare(`SELECT payload, content_payload, pii_payload FROM session_events WHERE id = ?`)
      .get(eventId) as StoredRow;
  }

  it("seals the body into its own column and opens it back through the key store", async () => {
    const { service, store } = buildAppendFixture();
    const envelope = makeAssistantEnvelope();

    await service.append(envelope, { content: { body: "hello from the model" } });

    const row = readStoredRow(envelope.id);
    expect(row.content_payload).toBeInstanceOf(Uint8Array);
    expect(row.pii_payload).toBeNull();

    const resolved = await store.read(SESSION);
    expect(openContentPayload(row.content_payload!, resolved.key, SESSION, envelope.id)).toBe(
      "hello from the model",
    );

    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(20);
    expect(JSON.stringify(payload)).not.toContain("hello from the model");
  });

  it("carries both partitions on one row when the assistant quotes a person", async () => {
    const { service, store } = buildAppendFixture();
    const envelope = makeAssistantEnvelope();

    await service.append(envelope, {
      content: { body: "as you said earlier" },
      pii: { userId: USER, piiPayload: { quoted: "something a person typed" } },
    });

    const row = readStoredRow(envelope.id);
    expect(row.content_payload).toBeInstanceOf(Uint8Array);
    expect(row.pii_payload).toBeInstanceOf(Uint8Array);
    const resolved = await store.read(SESSION);
    expect(openContentPayload(row.content_payload!, resolved.key, SESSION, envelope.id)).toBe(
      "as you said earlier",
    );
  });

  it("fails loudly rather than dropping prose when no key source is wired", async () => {
    const { service } = buildAppendFixture({ withoutKeySource: true });
    await expect(
      service.append(makeAssistantEnvelope(), { content: { body: "would be lost" } }),
    ).rejects.toThrow(/contentKeySource/);
    expect(database.prepare(`SELECT COUNT(*) AS total FROM session_events`).get()).toEqual({
      total: 0,
    });
  });

  // --------------------------------------------------------------------------
  // The wrapped key's lifecycle: `SessionContentKeyStore.deleteIfUnreferenced`
  // --------------------------------------------------------------------------
  //
  // Without a deletion path a wrapped key outlives every body it sealed, and `rewrapAll`
  // re-wraps it on every rotate-on-shred. Bodies are cleared here with a direct
  // `content_payload = NULL` UPDATE, the mutation the predicate reads. That the purge calls this
  // after clearing is pinned in `session-purge.test.ts`.
  describe("retiring the wrapped session key", () => {
    function clearBody(eventId: string): void {
      database
        .prepare(`UPDATE session_events SET content_payload = NULL WHERE id = ?`)
        .run(eventId);
    }

    function keyRowCount(sessionId: string): number {
      const row = database
        .prepare(`SELECT COUNT(*) AS n FROM session_content_keys WHERE session_id = ?`)
        .get(sessionId) as { readonly n: number };
      return row.n;
    }

    it("keeps the key while any sealed body survives", async () => {
      const { service, store } = buildAppendFixture();
      const first = makeAssistantEnvelope();
      const second = makeAssistantEnvelope();
      await service.append(first, { content: { body: "first body" } });
      await service.append(second, { content: { body: "second body" } });

      clearBody(first.id);

      expect(await store.deleteIfUnreferenced(SESSION)).toBe(false);
      expect(keyRowCount(SESSION)).toBe(1);

      // The survivor still opens.
      const resolved = await store.read(SESSION);
      const row = readStoredRow(second.id);
      expect(openContentPayload(row.content_payload!, resolved.key, SESSION, second.id)).toBe(
        "second body",
      );
    });

    it("retires the key when the last sealed body is cleared", async () => {
      const { service, store } = buildAppendFixture();
      const only = makeAssistantEnvelope();
      await service.append(only, { content: { body: "the only body" } });
      expect(keyRowCount(SESSION)).toBe(1);

      clearBody(only.id);

      expect(await store.deleteIfUnreferenced(SESSION)).toBe(true);
      expect(keyRowCount(SESSION)).toBe(0);
      await expect(store.read(SESSION)).rejects.toMatchObject({ reason: "wrapped_key_missing" });
    });

    it("does not count a body-less row as a reason to keep the key", async () => {
      const { service, store } = buildAppendFixture();
      const withBody = makeAssistantEnvelope();
      await service.append(withBody, { content: { body: "a body" } });
      // A plain append on the same session has no `content_payload`, so it does not hold the key
      // alive.
      await service.append({
        ...makeAssistantEnvelope(),
        category: "session_lifecycle",
        type: "session.updated",
        payload: { sessionId: SESSION },
      });

      clearBody(withBody.id);

      expect(await store.deleteIfUnreferenced(SESSION)).toBe(true);
      expect(keyRowCount(SESSION)).toBe(0);
    });

    it("cannot delete the key out from under an in-flight append", async () => {
      // An append resolves the key and inserts the sealed row later. In between, the session has a
      // key row and no non-NULL `content_payload`, which is the state the predicate deletes on. A
      // sweep admitted then would destroy the key the append is sealing under, and the body could
      // never be opened even though the append reports success.
      //
      // The master-key read sits inside `#openRow`, after the wrapped row is selected and
      // before the INSERT, and is gated to hold that window open. The sweep starts from the
      // test's own context, outside the append's hold, so the lock's owner-scoped reentrancy
      // cannot grant it the hold.
      class GatedMasterKeySource extends ScriptedMasterKeySource {
        gate: Promise<void> | undefined;

        override async read(): Promise<Uint8Array> {
          const key = await super.read();
          if (this.gate !== undefined) {
            await this.gate;
          }
          return key;
        }
      }

      const masterKeySource = new GatedMasterKeySource(MASTER_KEY);
      const store = new SessionContentKeyStore({ database, masterKeySource });
      const service = new EventLogService({
        db: database,
        piiEncryptor: new DeterministicPiiEncryptor(),
        contentKeySource: store,
      });

      const first = makeAssistantEnvelope();
      await service.append(first, { content: { body: "first body" } });
      clearBody(first.id);
      expect(keyRowCount(SESSION)).toBe(1);

      let reachedKeyRead!: () => void;
      const insideAppendHold = new Promise<void>((resolve) => {
        reachedKeyRead = resolve;
      });
      let openTheGate!: () => void;
      masterKeySource.gate = new Promise<void>((resolve) => {
        openTheGate = resolve;
      });
      masterKeySource.beforeRead = () => {
        reachedKeyRead();
      };

      const second = makeAssistantEnvelope();
      const appendPromise = service.append(second, { content: { body: "second body" } });
      await insideAppendHold;

      let sweptEarly = false;
      const sweep = store.deleteIfUnreferenced(SESSION);
      void sweep.then(() => {
        sweptEarly = true;
      });
      // Several macrotask turns while the append is parked in its hold: ample for an unguarded
      // delete to commit.
      await macrotask();
      await macrotask();
      await macrotask();
      expect(sweptEarly).toBe(false);
      expect(keyRowCount(SESSION)).toBe(1);

      openTheGate();
      await appendPromise;

      // The sweep now sees the inserted row and declines, so the key and its body survive.
      expect(await sweep).toBe(false);
      expect(keyRowCount(SESSION)).toBe(1);
      const resolved = await store.read(SESSION);
      const row = readStoredRow(second.id);
      expect(openContentPayload(row.content_payload!, resolved.key, SESSION, second.id)).toBe(
        "second body",
      );
    });
  });

  // --------------------------------------------------------------------------
  // An append that mints a key and then aborts
  // --------------------------------------------------------------------------
  //
  // `resolveForWrite` commits its mint in its own transaction (a better-sqlite3 transaction
  // cannot span an await), so the key row is durable before the append knows whether it will
  // produce a row. Any refusal after that leaves a key for a session that sealed nothing, and if
  // it was the session's first content-bearing append, nothing will reference or re-mint it.
  //
  // Two layers are pinned separately because they abort at different places: the codec's
  // refusals fire before the INSERT is reached, while a throwing prelude or a constraint
  // violation rolls a reached INSERT back.
});
