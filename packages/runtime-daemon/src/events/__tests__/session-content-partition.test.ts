// Contract coverage for the machine-authored content partition: the sealing codec's content
// half, the session content key store behind it, and the end-to-end append that joins them.
//
// Three matrices drive the arms as data, and each carries a completeness assertion so a new
// reason, routing case or refusal arm cannot ship uncovered:
// - `CODEC_ROUTING_MATRIX`: user PII alone, machine content alone, and both on one row, crossed
//   with the columns and payload members each must produce. A content-only row (an assistant or
//   tool row: prose, usually no PII) still goes through the codec.
// - `KEY_STORE_FAILURE_MATRIX`: every way resolving a session content key fails, mapped to the
//   reason reported. A blob moved to another session's row and a blob replayed under a
//   superseded key version must both refuse; otherwise a key is silently substituted and shows
//   up only as an unreadable body.
// - `CODEC_REFUSAL_MATRIX`: every arm of the codec's fixed refusal order. The first guard to
//   fire is the only one a caller sees, so each row names its ordinal and guard block.
//   Ordinals 1 to 6 fire before encryption and spend no nonce; ordinal 7 (the composed-variant
//   parse) fires after the seal, so each row states the encrypt count it must observe.
//
// Each refusal arm is paired with the admitted input one perturbation away. The truncation arms
// test one body under the bound, one exactly on it, and one over it.

import { randomBytes } from "node:crypto";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
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
  type PiiEncryptionRequest,
  type PiiEncryptor,
  type PiiEventWriteResult,
  type RawEventInput,
} from "../pii-indirection.js";
import { __resetSessionAppendLocksForTest } from "../session-append-lock.js";
import {
  SESSION_CONTENT_KEY_BYTES,
  SESSION_CONTENT_WRAP_NONCE_BYTES,
  SessionContentKeyStore,
  SessionContentKeyUnavailableError,
  buildSessionContentWrapAad,
  type DaemonMasterKeySource,
  type SessionContentKeyDisposer,
  type SessionContentKeySweepResult,
  type SessionContentKeyUnavailableReason,
} from "../session-content-key-store.js";
import { writeAcrossStrictTyping } from "../../session/__fixtures__/at-rest-tamper.js";

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

/**
 * The injected master-key seam, with every failure the store must classify
 * reachable from the fixture rather than from a mock's internals.
 */
class ScriptedMasterKeySource implements DaemonMasterKeySource {
  key: Uint8Array = MASTER_KEY;
  failure: Error | undefined;
  readCallCount = 0;
  /**
   * Runs inside one read, after the key is captured and before the promise resolves. It models a
   * source that obtained the master key before a rotation and resolves with it after, which lets a
   * first mint wrap under a destroyed master.
   */
  beforeRead: (() => void) | undefined;

  read(): Promise<Uint8Array> {
    this.readCallCount += 1;
    const capturedKey = this.key;
    this.beforeRead?.();
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(capturedKey);
  }
}

/** The injected PII encryptor stub — deterministic so an arm can name its bytes. */
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

let eventCounter = 0;

function nextEventId(): string {
  eventCounter += 1;
  return `evt-${String(eventCounter).padStart(4, "0")}`;
}

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
  readonly payload?: Record<string, unknown>;
}): PiiCarryingEventInput {
  return {
    id: nextEventId(),
    sessionId: SESSION,
    sequence: 1,
    occurredAt: "2026-08-30T12:00:00.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: "agent-1",
    payload: overrides?.payload ?? { sessionId: SESSION, runId: "run-1" },
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
// THE MATRICES
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
    name: "no row for the session",
    reason: "wrapped_key_missing",
    arrange: (store) => store.read(SESSION),
  },
  {
    name: "the master key source rejects",
    reason: "master_key_unavailable",
    arrange: async (store, masterKeySource) => {
      await store.resolveForWrite(SESSION);
      masterKeySource.failure = new Error("keystore is locked");
      return store.read(SESSION);
    },
  },
  {
    name: "the master key is the wrong width",
    reason: "master_key_unavailable",
    arrange: async (store, masterKeySource) => {
      await store.resolveForWrite(SESSION);
      masterKeySource.key = new Uint8Array(16).fill(3);
      return store.read(SESSION);
    },
  },
  {
    name: "the master key changed under a stored row",
    reason: "wrapped_key_unopenable",
    arrange: async (store, masterKeySource) => {
      await store.resolveForWrite(SESSION);
      masterKeySource.key = ROTATED_MASTER_KEY;
      return store.read(SESSION);
    },
  },
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
  {
    name: "the wrapped blob is corrupted",
    reason: "wrapped_key_unopenable",
    arrange: async (store) => {
      await store.resolveForWrite(SESSION);
      const row = database
        .prepare(`SELECT encrypted_key_blob FROM session_content_keys WHERE session_id = ?`)
        .get(SESSION) as { readonly encrypted_key_blob: Uint8Array };
      const tampered = Uint8Array.from(row.encrypted_key_blob);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
      database
        .prepare(`UPDATE session_content_keys SET encrypted_key_blob = ? WHERE session_id = ?`)
        .run(tampered, SESSION);
      return store.read(SESSION);
    },
  },
  {
    name: "the wrapped blob is under the nonce-plus-tag floor",
    reason: "wrapped_key_unopenable",
    arrange: async (store) => {
      await store.resolveForWrite(SESSION);
      database
        .prepare(`UPDATE session_content_keys SET encrypted_key_blob = ? WHERE session_id = ?`)
        .run(new Uint8Array(SESSION_CONTENT_WRAP_NONCE_BYTES), SESSION);
      return store.read(SESSION);
    },
  },
  {
    name: "the stored blob is not bytes",
    reason: "wrapped_key_unopenable",
    arrange: async (store) => {
      await store.resolveForWrite(SESSION);
      writeAcrossStrictTyping(database, "session_content_keys", () => {
        database
          .prepare(`UPDATE session_content_keys SET encrypted_key_blob = ? WHERE session_id = ?`)
          .run("not a blob", SESSION);
      });
      return store.read(SESSION);
    },
  },
  {
    name: "the stored key version is not a positive integer",
    reason: "wrapped_key_unopenable",
    arrange: async (store) => {
      await store.resolveForWrite(SESSION);
      database
        .prepare(`UPDATE session_content_keys SET key_version = ? WHERE session_id = ?`)
        .run(0, SESSION);
      return store.read(SESSION);
    },
  },
];

/** One arm of the codec's fixed refusal order. */
interface CodecRefusalCase {
  readonly name: string;
  /** The ordinal the module's own documented order gives this guard. */
  readonly ordinal: number;
  /** Which guard block answers — several ordinals hold more than one. */
  readonly arm: string;
  readonly build: () => RawEventInput;
  readonly message: RegExp;
  /**
   * Encrypt calls the injected encryptor must have made when this arm fires: zero for arms
   * answerable from the input alone, one for refusal 7 on a user row. A zero on a content-only row
   * proves nothing about ordering, because the encryptor is never called for one.
   */
  readonly expectedEncryptCalls?: number;
}

/** An otherwise-valid content row, defective only in the named way. */
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

const CODEC_REFUSAL_MATRIX: readonly CodecRefusalCase[] = [
  {
    name: "a never-shredded category carrying prose",
    ordinal: 1,
    arm: "refused category",
    build: () => contentRowWith({ category: "event_maintenance", type: "event.compacted" }),
    message: /event_maintenance/,
  },
  {
    name: "an input carrying neither partition",
    ordinal: 1,
    arm: "neither partition",
    build: () =>
      ({
        id: nextEventId(),
        sessionId: SESSION,
        sequence: 1,
        occurredAt: "2026-08-30T12:00:00.000Z",
        category: "assistant_output",
        type: "assistant.message",
        actor: null,
        payload: { sessionId: SESSION, runId: "run-1" },
        version: ENVELOPE_VERSION,
      }) as unknown as RawEventInput,
    message: /neither a PII partition nor a content partition/,
  },
  {
    name: "a user id with no user payload",
    ordinal: 1,
    arm: "half-present PII partition",
    build: () => contentRowWith({ piiUserId: USER }),
    message: /piiUserId with no piiPayload/,
  },
  {
    // The body-bearing set comes from the contracts union. A type whose strict payload schema
    // declares none of the content members would store a row its own schema rejects on read.
    name: "a content partition on a type that declares no content members",
    ordinal: 1,
    arm: "content on an unregistered type",
    build: () => contentRowWith({ type: "session.created", category: "session_lifecycle" }),
    message: /content partition on event type "session\.created"/,
  },
  {
    name: "a payload that pre-seeds the content length",
    ordinal: 2,
    arm: "reserved content members",
    build: () =>
      makeContentOnlyInput({
        payload: { sessionId: SESSION, runId: "run-1", [CONTENT_LENGTH_PAYLOAD_KEY]: 4 },
      }),
    message: new RegExp(CONTENT_LENGTH_PAYLOAD_KEY),
  },
  {
    name: "a payload that pre-seeds the truncation marker",
    ordinal: 2,
    arm: "reserved content members",
    build: () =>
      makeContentOnlyInput({
        payload: { sessionId: SESSION, runId: "run-1", [CONTENT_TRUNCATED_PAYLOAD_KEY]: true },
      }),
    message: new RegExp(CONTENT_TRUNCATED_PAYLOAD_KEY),
  },
  {
    name: "a sequence outside the safe-integer range",
    ordinal: 3,
    arm: "sequence",
    build: () => contentRowWith({ sequence: 1.5 }),
    message: /not a safe integer/,
  },
  {
    name: "a timestamp the canonical form cannot represent",
    ordinal: 4,
    arm: "occurredAt",
    build: () => contentRowWith({ occurredAt: "2026-08-30 12:00:00Z" }),
    message: /must be an RFC 3339 date-time/,
  },
  {
    name: "an empty user id beside a user payload",
    ordinal: 5,
    arm: "user id shape",
    build: () => ({ ...makePiiCarryingInput(), piiUserId: "" }) as unknown as RawEventInput,
    message: /non-empty piiUserId/,
  },
  {
    name: "a body that is not a string",
    ordinal: 6,
    arm: "content body",
    build: () => contentRowWith({ content: { body: { not: "prose" }, contentKey: CONTENT_KEY } }),
    message: /content\.body to be a string/,
  },
  {
    name: "a content key of the wrong width",
    ordinal: 6,
    arm: "content key",
    build: () => contentRowWith({ content: { body: "prose", contentKey: new Uint8Array(16) } }),
    message: /content\.contentKey/,
  },
  {
    // `TextEncoder` swaps an unpaired surrogate for U+FFFD instead of refusing, and the read side's
    // fatal decoder accepts the stored (valid) UTF-8, so only this write-side guard catches it.
    name: "a body carrying an unpaired surrogate",
    ordinal: 6,
    arm: "content body well-formedness",
    build: () =>
      contentRowWith({
        content: { body: "prose with a lone \ud800 half", contentKey: CONTENT_KEY },
      }),
    message: /well-formed UTF-16/,
  },
  {
    // Refusal 1's fourth arm reads `type` only, so a body-bearing type under the wrong category
    // reaches the seal. The variant's `category` is a literal, so its own schema would reject the
    // row on read.
    name: "a body-bearing type under a category its variant does not declare",
    ordinal: 7,
    arm: "composed-variant parse",
    build: () => contentRowWith({ category: "tool_activity" }),
    message: /category \(invalid_value\)/,
  },
  {
    name: "a payload missing a member its registered variant requires",
    ordinal: 7,
    arm: "composed-variant parse",
    build: () => makeContentOnlyInput({ payload: { runId: "run-1" } }),
    message: /payload\.sessionId \(invalid_type\)/,
  },
  {
    // The tool variants require `toolName`; the assistant ones do not.
    // own schema rejects.
    name: "a tool row with no tool name",
    ordinal: 7,
    arm: "composed-variant parse",
    build: () =>
      contentRowWith({
        type: "tool.result",
        category: "tool_activity",
        payload: { sessionId: SESSION, runId: "run-1" },
      }),
    message: /payload\.toolName \(invalid_type\)/,
  },
  {
    // The `unrecognized_keys` code is the one whose message names the offending member.
    name: "a payload carrying a member no variant declares",
    ordinal: 7,
    arm: "composed-variant parse",
    build: () =>
      makeContentOnlyInput({
        payload: { sessionId: SESSION, runId: "run-1", improvisedMember: "not in any variant" },
      }),
    message: /payload \(unrecognized_keys: improvisedMember\)/,
  },
  {
    // Pins refusal 7's placement: a user partition on a registered type has already been encrypted
    // when the parse refuses, so `expectedEncryptCalls` is 1. A 0 would mean the guard judged a
    // reconstruction rather than the stored form.
    name: "a user row whose payload its registered variant rejects",
    ordinal: 7,
    arm: "composed-variant parse",
    build: () => makePiiCarryingInput({ payload: { runId: "run-1" } }),
    message: /payload\.sessionId \(invalid_type\)/,
    expectedEncryptCalls: 1,
  },
];

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
  const masterKeySource = new ScriptedMasterKeySource();
  return {
    store: new SessionContentKeyStore({ database, masterKeySource }),
    masterKeySource,
  };
}

// ----------------------------------------------------------------------------
// The enumeration itself
// ----------------------------------------------------------------------------

describe("content partition routing and key-failure enumeration", () => {
  it("covers every partition combination the codec can be handed", () => {
    // Three combinations; a fourth would be a new partition, and an input with neither is refused.
    expect(CODEC_ROUTING_MATRIX.map((routingCase) => routingCase.name)).toEqual([
      "user partition alone",
      "machine content partition alone",
      "both partitions on one row",
    ]);
    for (const routingCase of CODEC_ROUTING_MATRIX) {
      const input = routingCase.build();
      expect(input.piiPayload !== undefined || input.content !== undefined).toBe(true);
    }
  });

  it("covers every reason a session content key can be unavailable", () => {
    // Every declared reason must be produced by at least one arranged failure below.
    const declaredReasons: readonly SessionContentKeyUnavailableReason[] = [
      "master_key_unavailable",
      "wrapped_key_missing",
      "wrapped_key_unopenable",
    ];
    const coveredReasons = new Set(KEY_STORE_FAILURE_MATRIX.map((failure) => failure.reason));
    expect([...coveredReasons].sort()).toEqual([...declaredReasons].sort());
  });

  it("covers every arm of the refusal order the codec publishes", () => {
    // Every ordinal of the codec's guard sequence has an arm, and no arm claims one outside it.
    // Each arm runs against the real codec below, so a renumbered or removed guard fails there.
    const coveredOrdinals = [...new Set(CODEC_REFUSAL_MATRIX.map((arm) => arm.ordinal))].sort(
      (left, right) => left - right,
    );
    expect(coveredOrdinals).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Several ordinals answer through more than one guard block, each with its own message, so a
    // merged guard would report the wrong thing for one of the shapes.
    const armsByOrdinal = new Map<number, Set<string>>();
    for (const refusal of CODEC_REFUSAL_MATRIX) {
      const arms = armsByOrdinal.get(refusal.ordinal) ?? new Set<string>();
      arms.add(refusal.arm);
      armsByOrdinal.set(refusal.ordinal, arms);
    }
    expect([...armsByOrdinal].map(([ordinal, arms]) => [ordinal, arms.size])).toEqual([
      [1, 4],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 3],
      // One guard block covers every shape the strict layer rejects, because it delegates to the
      // registered variant.
      [7, 1],
    ]);
  });

  for (const refusal of CODEC_REFUSAL_MATRIX) {
    it(`refuses ${refusal.name}`, async () => {
      const encryptor = new DeterministicPiiEncryptor();
      await expect(writeEventWithPii(refusal.build(), encryptor)).rejects.toThrow(refusal.message);
      // Refusals 1 to 6 are answerable from the input alone, so they cost no AEAD nonce. Refusal 7
      // fires after the encrypt; see `expectedEncryptCalls`.
      expect(encryptor.encryptCallCount).toBe(refusal.expectedEncryptCalls ?? 0);
    });
  }

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
// The sealing codec's content half
// ----------------------------------------------------------------------------

describe("machine content sealing", () => {
  it("seals a body that opens back to exactly what went in", async () => {
    const input = makeContentOnlyInput({ body: "line one\nline two — with punctuation" });
    const result = await seal(input, new DeterministicPiiEncryptor());

    expect(result.contentPayload).toBeInstanceOf(Uint8Array);
    const opened = openContentPayload(result.contentPayload!, CONTENT_KEY, SESSION, input.id);
    expect(opened).toBe("line one\nline two — with punctuation");
  });

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

  it("runs the order once over a row carrying both partitions", async () => {
    const input = makePiiCarryingInput({ withContent: true });
    const encryptor = new DeterministicPiiEncryptor();
    const result = await seal(input, encryptor);

    expect(encryptor.encryptCallCount).toBe(1);
    expect(result.piiPayload).toBeInstanceOf(Uint8Array);
    expect(result.contentPayload).toBeInstanceOf(Uint8Array);
    expect(result.piiUserId).toBe(USER);
  });
});

describe("the plaintext bound", () => {
  /** Multi-byte on purpose: the cut has to land on a codepoint boundary. */
  const EM_DASH = "—";
  const EM_DASH_BYTES = 3;

  it("leaves a body under the bound whole and unmarked", async () => {
    const body = "a".repeat(1_000);
    const result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(1_000);
    expect(Object.hasOwn(payload, CONTENT_TRUNCATED_PAYLOAD_KEY)).toBe(false);
    expect(
      openContentPayload(result.contentPayload!, CONTENT_KEY, SESSION, result.envelope.id),
    ).toBe(body);
  });

  it("leaves a body exactly at the bound whole and unmarked", async () => {
    const body = "a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX);
    const result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX);
    expect(Object.hasOwn(payload, CONTENT_TRUNCATED_PAYLOAD_KEY)).toBe(false);
  });

  it("truncates an over-bound body and reports the pre-truncation length", async () => {
    const body = "a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX + 500);
    const result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(payload[CONTENT_TRUNCATED_PAYLOAD_KEY]).toBe(true);
    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX + 500);
    const opened = openContentPayload(
      result.contentPayload!,
      CONTENT_KEY,
      SESSION,
      result.envelope.id,
    );
    expect(new TextEncoder().encode(opened).length).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX);
    // No sentinel or ellipsis is appended; the payload member is the marker.
    expect(opened).toBe("a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX));
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

  it("cuts a body whose codepoint ends exactly on the bound without loss", async () => {
    // Negative control for the arm above: the codepoint ends on the bound, so nothing is walked
    // back.
    const filler = "a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX - EM_DASH_BYTES);
    const body = `${filler}${EM_DASH}${EM_DASH}`;
    const result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    const opened = openContentPayload(
      result.contentPayload!,
      CONTENT_KEY,
      SESSION,
      result.envelope.id,
    );

    expect(opened).toBe(`${filler}${EM_DASH}`);
    expect(new TextEncoder().encode(opened).length).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX);
  });

  it("never asks the encoder to materialize more than the bound", async () => {
    // `applyPlaintextBound` measures the pre-truncation length by walking code points, so the
    // encoder only ever sees the bounded prefix. An encode-then-cut version would materialize the
    // whole body first, which is unbounded allocation on the input the bound exists to contain.
    const body = "a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX * 8);
    const originalEncode = TextEncoder.prototype.encode;
    let widestEncodedBytes = 0;
    // Installed only around the sealing call so other encodes do not pollute the measurement.
    TextEncoder.prototype.encode = function recordingEncode(
      this: TextEncoder,
      input?: string,
    ): Uint8Array<ArrayBuffer> {
      const encoded = originalEncode.call(this, input);
      widestEncodedBytes = Math.max(widestEncodedBytes, encoded.length);
      return encoded;
    };
    let result: PiiEventWriteResult;
    try {
      result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    } finally {
      TextEncoder.prototype.encode = originalEncode;
    }

    expect(widestEncodedBytes).toBeLessThanOrEqual(CONTENT_PAYLOAD_PLAINTEXT_MAX);
    // The bound still applied to the whole body, so the assertion above is about how the length was
    // computed.
    const payload = result.envelope.payload as Record<string, unknown>;
    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX * 8);
    expect(payload[CONTENT_TRUNCATED_PAYLOAD_KEY]).toBe(true);
  });

  it("counts astral code points at four bytes without encoding the body", async () => {
    // A surrogate pair is one code point of four UTF-8 bytes; a per-unit sum would report six and
    // truncate a body that fits.
    const seedling = "\u{1F331}";
    const body = seedling.repeat(1_000);
    const result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(4_000);
    expect(Object.hasOwn(payload, CONTENT_TRUNCATED_PAYLOAD_KEY)).toBe(false);
    expect(
      openContentPayload(result.contentPayload!, CONTENT_KEY, SESSION, result.envelope.id),
    ).toBe(body);
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
  // The refusal arms are driven by `CODEC_REFUSAL_MATRIX`. These cover the admitted input one
  // perturbation away from a refused one, and the order two defects resolve in.

  it("admits a payload one perturbation away from every reserved member", async () => {
    // Negative control for refusal 2: without the reserved member the same payload seals.
    await expect(
      seal(
        makeContentOnlyInput({ payload: { sessionId: SESSION, runId: "run-1" } }),
        new DeterministicPiiEncryptor(),
      ),
    ).resolves.toBeDefined();
  });

  it("admits the producer-owned content type beside the codec-owned members", async () => {
    // `contentType` is the producer's member and is deliberately not reserved, since only the
    // producer knows the media type.
    const result = await seal(
      makeContentOnlyInput({
        payload: { sessionId: SESSION, runId: "run-1", contentType: "text/markdown" },
      }),
      new DeterministicPiiEncryptor(),
    );
    expect((result.envelope.payload as Record<string, unknown>)["contentType"]).toBe(
      "text/markdown",
    );
  });

  it("keeps the user half rather than routing a half-present row as content", async () => {
    // Negative control for refusal 1's third arm: supplying both halves seals the user partition
    // rather than dropping it.
    const result = await seal(makePiiCarryingInput(), new DeterministicPiiEncryptor());
    expect(result.piiUserId).toBe(USER);
    expect(result.piiPayload).toBeInstanceOf(Uint8Array);
  });

  it("refuses the content partition last, so no earlier refusal's message moves", async () => {
    // An input defective in an earlier way and the content way reports the earlier one (sequence is
    // refusal 3, content shape is refusal 6).
    const doublyDefective = {
      ...makeContentOnlyInput(),
      sequence: 1.5,
      content: { body: 42, contentKey: CONTENT_KEY },
    } as unknown as RawEventInput;
    await expect(seal(doublyDefective, new DeterministicPiiEncryptor())).rejects.toThrow(
      /not a safe integer/,
    );
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

  it("refuses a content partition on an unregistered type before spending the user nonce", async () => {
    // The matrix drives this arm on a content-only row, where the encryptor is never called.
    // Pairing it with a PII partition makes `encryptCallCount` a real assertion.
    const encryptor = new DeterministicPiiEncryptor();
    const misroutedRow = {
      ...makePiiCarryingInput({ withContent: true }),
      type: "session.created",
      category: "session_lifecycle",
    } as unknown as RawEventInput;

    await expect(seal(misroutedRow, encryptor)).rejects.toThrow(/content partition on event type/);
    expect(encryptor.encryptCallCount).toBe(0);

    // On a registered type both partitions seal and the nonce is spent, so the count above is about
    // the guard, not the fixture.
    const admitted = await seal(makePiiCarryingInput({ withContent: true }), encryptor);
    expect(admitted.contentPayload).toBeInstanceOf(Uint8Array);
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses an ill-formed body before spending the user nonce", async () => {
    const encryptor = new DeterministicPiiEncryptor();
    const illFormedRow = {
      ...makePiiCarryingInput({ withContent: true }),
      content: { body: "a lone \ud800 half", contentKey: CONTENT_KEY },
    } as unknown as RawEventInput;

    await expect(seal(illFormedRow, encryptor)).rejects.toThrow(/well-formed UTF-16/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("admits a well-formed surrogate pair and refuses every unpaired shape", async () => {
    // The positive control first, so the refusals below are one perturbation
    // Positive control first: a pair is ordinary text and round-trips byte for byte.
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

  it("stores a row whose type the strict layer registers no variant for", async () => {
    // Negative control for refusal 7's dispatch. The event contract requires a reader to persist an
    // envelope whose `type` it cannot interpret, so a guard that parsed every row would refuse the
    // carrier it must tolerate. `user.message` has no registered payload variant, so this payload
    // seals even though it declares a member no variant knows.
    const result = await seal(
      {
        ...makePiiCarryingInput(),
        type: "user.message",
        category: "interactive_request",
        payload: { improvisedMember: "a higher-MINOR producer's member" },
      } as unknown as RawEventInput,
      new DeterministicPiiEncryptor(),
    );

    expect(result.piiPayload).toBeInstanceOf(Uint8Array);
    // The perturbation back: the identical payload on a type WITH a variant is
    // On a type with a variant the same payload is refused, so the seal above is about the
    // dispatch.
    await expect(
      seal(
        makePiiCarryingInput({ payload: { improvisedMember: "a higher-MINOR producer's member" } }),
        new DeterministicPiiEncryptor(),
      ),
    ).rejects.toThrow(/registered SessionEventSchema variant rejects/);
  });

  it("reports the composed-variant refusal after every input-answerable one, so no message moves", async () => {
    // Refusal 7 is last: an input defective in an earlier way and the schema way reports the
    // earlier one (the content key width is refusal 6).
    const doublyDefective = contentRowWith({
      payload: { runId: "run-1" },
      content: { body: "prose", contentKey: new Uint8Array(16) },
    });

    await expect(seal(doublyDefective, new DeterministicPiiEncryptor())).rejects.toThrow(
      /content\.contentKey/,
    );
  });

  it("reports the well-formedness refusal after the key-width one, so no message moves", async () => {
    // The well-formedness arm is last within refusal 6, so a bad key width is reported first.
    const doublyDefective = contentRowWith({
      content: { body: "a lone \ud800 half", contentKey: new Uint8Array(16) },
    });
    await expect(seal(doublyDefective, new DeterministicPiiEncryptor())).rejects.toThrow(
      /content\.contentKey/,
    );
  });
});

// ----------------------------------------------------------------------------
// The session content key store
// ----------------------------------------------------------------------------

describe("session content key custody", () => {
  it("mints one key per session and returns the same material on every read", async () => {
    const { store } = buildKeyStore();

    const first = await store.resolveForWrite(SESSION);
    const second = await store.resolveForWrite(SESSION);
    const read = await store.read(SESSION);

    expect(first.keyVersion).toBe(1);
    expect(first.key).toHaveLength(SESSION_CONTENT_KEY_BYTES);
    expect(second.key).toEqual(first.key);
    expect(read.key).toEqual(first.key);
    expect(database.prepare(`SELECT COUNT(*) AS total FROM session_content_keys`).get()).toEqual({
      total: 1,
    });
  });

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

  it("reads no key when the session never sealed a body", async () => {
    const { store, masterKeySource } = buildKeyStore();
    await expect(store.read(SESSION)).rejects.toMatchObject({ reason: "wrapped_key_missing" });
    // And the failed read minted nothing — the whole reason the read half is
    // split from the write half.
    expect(database.prepare(`SELECT COUNT(*) AS total FROM session_content_keys`).get()).toEqual({
      total: 0,
    });
    expect(masterKeySource.readCallCount).toBe(0);
  });

  it("refuses a master key of the wrong width rather than wrapping under it", async () => {
    const { store, masterKeySource } = buildKeyStore();
    masterKeySource.key = new Uint8Array(31).fill(3);
    await expect(store.resolveForWrite(SESSION)).rejects.toMatchObject({
      reason: "master_key_unavailable",
    });
    expect(database.prepare(`SELECT COUNT(*) AS total FROM session_content_keys`).get()).toEqual({
      total: 0,
    });
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

  it("runs inside a caller's exclusive transaction and rolls back with it", () => {
    const { store } = buildKeyStore();
    // Synchronous seed: the signature under test must be callable where no `await` may appear.
    const seedTransaction = database.transaction((sessionId: string): void => {
      database
        .prepare(
          `INSERT INTO session_content_keys (session_id, encrypted_key_blob, key_version, created_at)
           VALUES (?, ?, 1, ?)`,
        )
        .run(
          sessionId,
          Buffer.from(
            wrapForTest(
              MASTER_KEY,
              sessionId,
              1,
              new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(9),
            ),
          ),
          "2026-08-30T12:00:00.000Z",
        );
    });
    seedTransaction.exclusive(SESSION);

    // The rotation runs inside the caller's own BEGIN EXCLUSIVE, as rotate-on-shred runs it beside
    // the user-key re-wrap.
    const rotateAndFail = database.transaction((): void => {
      store.rewrapAll(MASTER_KEY, ROTATED_MASTER_KEY);
      throw new Error("the caller's later step failed");
    });
    expect(() => {
      rotateAndFail.exclusive();
    }).toThrow("the caller's later step failed");

    // Rolled back with the caller: the row stays at version 1 under the previous master, so the two
    // tables cannot end up on different masters.
    expect(
      database
        .prepare(`SELECT key_version FROM session_content_keys WHERE session_id = ?`)
        .get(SESSION),
    ).toEqual({ key_version: 1 });
  });

  it("refuses a rotation whose master keys are the wrong width", async () => {
    const { store } = buildKeyStore();
    await store.resolveForWrite(SESSION);
    expect(() => store.rewrapAll(new Uint8Array(16), ROTATED_MASTER_KEY)).toThrow(
      SessionContentKeyUnavailableError,
    );
    expect(() => store.rewrapAll(MASTER_KEY, new Uint8Array(16))).toThrow(
      SessionContentKeyUnavailableError,
    );
  });

  it("aborts a rotation on the first row it cannot open", async () => {
    const { store } = buildKeyStore();
    await store.resolveForWrite(SESSION);
    await store.resolveForWrite(OTHER_SESSION);
    database
      .prepare(`UPDATE session_content_keys SET encrypted_key_blob = ? WHERE session_id = ?`)
      .run(new Uint8Array(64), SESSION);

    expect(() => store.rewrapAll(MASTER_KEY, ROTATED_MASTER_KEY)).toThrow(
      SessionContentKeyUnavailableError,
    );
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

  it("fences a concurrent mint even when the rotation itself fails", async () => {
    // The fence is bumped at `rewrapAll`'s entry, ahead of its width guard. Over-signaling costs a
    // racing mint one spurious retry; under-signaling costs a session its bodies.
    const { store, masterKeySource } = buildKeyStore();
    masterKeySource.beforeRead = () => {
      masterKeySource.beforeRead = undefined;
      expect(() => store.rewrapAll(new Uint8Array(16), ROTATED_MASTER_KEY)).toThrow(
        SessionContentKeyUnavailableError,
      );
    };

    await store.resolveForWrite(SESSION);
    expect(masterKeySource.readCallCount).toBe(2);
  });

  it("refuses rather than wrapping under a master that keeps being superseded", async () => {
    // The retry is bounded so a source that rotates on every read cannot spin an append forever.
    // The refusal reuses `master_key_unavailable` rather than adding a reason the read path cannot
    // produce.
    const { store, masterKeySource } = buildKeyStore();
    masterKeySource.beforeRead = () => {
      store.rewrapAll(masterKeySource.key, ROTATED_MASTER_KEY);
    };

    await expect(store.resolveForWrite(SESSION)).rejects.toMatchObject({
      name: "SessionContentKeyUnavailableError",
      reason: "master_key_unavailable",
    });
    expect(masterKeySource.readCallCount).toBe(3);
    // Nothing was committed on any attempt: the fence throws inside the write
    // transaction, so every candidate rolled back with it.
    expect(database.prepare(`SELECT COUNT(*) AS total FROM session_content_keys`).get()).toEqual({
      total: 0,
    });
  });

  it("costs an uncontended mint no extra master-key read", async () => {
    // The negative control for all three arms above: with no rotation in flight
    // the fence never fires, so a first mint reads the master exactly once and
    // the retry loop is invisible.
    const { store, masterKeySource } = buildKeyStore();
    await store.resolveForWrite(SESSION);
    expect(masterKeySource.readCallCount).toBe(1);
  });
});

/**
 * The wrap format re-derived here rather than imported, so a seeded row is an independent witness
 * to the format the store reads. Importing the store's own sealing would only show it agrees with
 * itself.
 */
function wrapForTest(
  masterKey: Uint8Array,
  sessionId: string,
  keyVersion: number,
  contentKey: Uint8Array,
): Uint8Array {
  const nonce = new Uint8Array(randomBytes(SESSION_CONTENT_WRAP_NONCE_BYTES));
  const sealed = xchacha20poly1305(
    masterKey,
    nonce,
    buildSessionContentWrapAad(sessionId, keyVersion),
  ).encrypt(contentKey);
  const blob = new Uint8Array(nonce.length + sealed.length);
  blob.set(nonce, 0);
  blob.set(sealed, nonce.length);
  return blob;
}

// ----------------------------------------------------------------------------
// The append path, end to end
// ----------------------------------------------------------------------------

describe("appending a row that carries machine-authored prose", () => {
  function buildAppendFixture(options?: { readonly withoutKeySource?: boolean }): {
    readonly service: EventLogService;
    readonly store: SessionContentKeyStore;
    readonly masterKeySource: ScriptedMasterKeySource;
  } {
    const masterKeySource = new ScriptedMasterKeySource();
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

  it("mints the session key on the first content-bearing append and not before", async () => {
    const { service } = buildAppendFixture();

    await service.append(makeAssistantEnvelope());
    expect(database.prepare(`SELECT COUNT(*) AS total FROM session_content_keys`).get()).toEqual({
      total: 0,
    });

    await service.append(makeAssistantEnvelope(), { content: { body: "first prose" } });
    expect(database.prepare(`SELECT COUNT(*) AS total FROM session_content_keys`).get()).toEqual({
      total: 1,
    });
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

  it("leaves the column NULL on an append that carries no body", async () => {
    const { service } = buildAppendFixture();
    const envelope = makeAssistantEnvelope();
    await service.append(envelope);

    const row = readStoredRow(envelope.id);
    expect(row.content_payload).toBeNull();
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(Object.hasOwn(payload, CONTENT_LENGTH_PAYLOAD_KEY)).toBe(false);
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

    function makeAssistantEnvelopeFor(sessionId: SessionId): UnsequencedEventEnvelope {
      return {
        ...makeAssistantEnvelope(),
        sessionId,
        payload: { sessionId, runId: "run-1", contentType: "text/markdown" },
      };
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

    it("is a silent no-op for a session that never held a key", async () => {
      const { store } = buildAppendFixture();

      // Idempotence lets every clearing path call this unconditionally after a pass.
      expect(await store.deleteIfUnreferenced(SESSION)).toBe(false);
      expect(await store.deleteIfUnreferenced(SESSION)).toBe(false);
      expect(keyRowCount(SESSION)).toBe(0);
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

    it("shrinks rewrapAll's working set to the sessions that still hold bodies", async () => {
      const { service, store } = buildAppendFixture();
      const doomed = makeAssistantEnvelope();
      const survivor = makeAssistantEnvelopeFor(OTHER_SESSION);
      await service.append(doomed, { content: { body: "will be purged" } });
      await service.append(survivor, { content: { body: "will survive" } });
      expect(store.rewrapAll(MASTER_KEY, ROTATED_MASTER_KEY)).toBe(2);

      clearBody(doomed.id);
      expect(await store.deleteIfUnreferenced(SESSION)).toBe(true);

      // One row re-wrapped, not two: the dead session is no longer visited.
      expect(store.rewrapAll(ROTATED_MASTER_KEY, MASTER_KEY)).toBe(1);
      expect(keyRowCount(OTHER_SESSION)).toBe(1);
    });

    // ------------------------------------------------------------------------
    // The table-wide reconciliation: `sweepUnreferenced`
    // ------------------------------------------------------------------------
    //
    // `deleteIfUnreferenced` gets one attempt: if it throws or the process exits after a pass
    // clears bodies, no later pass calls it again. The sweep re-derives the question (which keys
    // have no live content row), so that failure delays the delete instead of leaking the key. It
    // also collects keys minted by an append that aborted before sealing anything.
    it("retires every unreferenced key in the table and spares the referenced ones", async () => {
      const { service, store } = buildAppendFixture();
      const doomed = makeAssistantEnvelope();
      const survivor = makeAssistantEnvelopeFor(OTHER_SESSION);
      await service.append(doomed, { content: { body: "will be cleared" } });
      await service.append(survivor, { content: { body: "will survive" } });

      clearBody(doomed.id);

      // One, not two: a session that still seals a body is never a candidate.
      expect(await store.sweepUnreferenced()).toEqual({ reclaimed: 1, skipped: 0 });
      expect(keyRowCount(SESSION)).toBe(0);
      expect(keyRowCount(OTHER_SESSION)).toBe(1);
      // The survivor still opens.
      const resolved = await store.read(OTHER_SESSION);
      const row = readStoredRow(survivor.id);
      expect(
        openContentPayload(row.content_payload!, resolved.key, OTHER_SESSION, survivor.id),
      ).toBe("will survive");
    });

    it("collects the arrear a failed prompt disposal left behind", async () => {
      // The body is cleared and the prompt disposal never lands. Nothing in the database records
      // the debt, so the sweep is the only thing that can find this key.
      const { service, store } = buildAppendFixture();
      const only = makeAssistantEnvelope();
      await service.append(only, { content: { body: "the only body" } });
      clearBody(only.id);
      // The prompt call is deliberately not made, as after a throw or crash at this point.
      expect(keyRowCount(SESSION)).toBe(1);

      expect(await store.sweepUnreferenced()).toEqual({ reclaimed: 1, skipped: 0 });
      expect(keyRowCount(SESSION)).toBe(0);
    });

    it("reports nothing to reclaim while every key still seals a body", async () => {
      // Negative control: a sweep that deleted anything here would destroy live keys and leave
      // their bodies unreadable.
      const { service, store } = buildAppendFixture();
      const live = makeAssistantEnvelope();
      await service.append(live, { content: { body: "still referenced" } });

      expect(await store.sweepUnreferenced()).toEqual({ reclaimed: 0, skipped: 0 });
      expect(keyRowCount(SESSION)).toBe(1);
      const resolved = await store.read(SESSION);
      const row = readStoredRow(live.id);
      expect(openContentPayload(row.content_payload!, resolved.key, SESSION, live.id)).toBe(
        "still referenced",
      );
    });

    it("passes over a candidate whose disposal throws, counts it, and keeps sweeping", async () => {
      // One bad session must not stop the pass, but the pass-over is counted, not swallowed: a bare
      // reclaim count would report a wholly broken sweep and an idle one with the same zero.
      class RefusingDisposalStore extends SessionContentKeyStore {
        refuseFor: string | undefined;

        override async deleteIfUnreferenced(sessionId: SessionId): Promise<boolean> {
          if (sessionId === this.refuseFor) throw new Error("this session's delete is wedged");
          return super.deleteIfUnreferenced(sessionId);
        }
      }

      const store = new RefusingDisposalStore({
        database,
        masterKeySource: new ScriptedMasterKeySource(),
      });
      const service = new EventLogService({
        db: database,
        piiEncryptor: new DeterministicPiiEncryptor(),
        contentKeySource: store,
      });
      const wedged = makeAssistantEnvelope();
      const healthy = makeAssistantEnvelopeFor(OTHER_SESSION);
      await service.append(wedged, { content: { body: "wedged session body" } });
      await service.append(healthy, { content: { body: "healthy session body" } });
      clearBody(wedged.id);
      clearBody(healthy.id);
      store.refuseFor = SESSION;

      expect(await store.sweepUnreferenced()).toEqual({ reclaimed: 1, skipped: 1 });
      // Reaching the second candidate proves the sweep did not rethrow the first.
      expect(keyRowCount(SESSION)).toBe(1);
      expect(keyRowCount(OTHER_SESSION)).toBe(0);
    });

    it("is a silent no-op against a table that holds no keys at all", async () => {
      const { store } = buildAppendFixture();
      expect(await store.sweepUnreferenced()).toEqual({ reclaimed: 0, skipped: 0 });
      expect(await store.sweepUnreferenced()).toEqual({ reclaimed: 0, skipped: 0 });
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

      const masterKeySource = new GatedMasterKeySource();
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
  describe("reconciling the key an aborted append minted", () => {
    /**
     * A disposer that delegates to the real store rather than faking it, so the assertions cannot
     * pass against a service that never reclaimed anything. It adds a call record and an injectable
     * failure.
     */
    class RecordingContentKeyDisposer implements SessionContentKeyDisposer {
      readonly disposedSessionIds: string[] = [];
      failure: Error | undefined;
      readonly #delegate: SessionContentKeyStore;

      constructor(delegate: SessionContentKeyStore) {
        this.#delegate = delegate;
      }

      async deleteIfUnreferenced(sessionId: SessionId): Promise<boolean> {
        this.disposedSessionIds.push(sessionId);
        if (this.failure !== undefined) throw this.failure;
        return this.#delegate.deleteIfUnreferenced(sessionId);
      }

      async sweepUnreferenced(): Promise<SessionContentKeySweepResult> {
        return this.#delegate.sweepUnreferenced();
      }
    }

    function buildReconcilingFixture(options?: { readonly withoutDisposer?: boolean }): {
      readonly service: EventLogService;
      readonly store: SessionContentKeyStore;
      readonly disposer: RecordingContentKeyDisposer;
    } {
      const store = new SessionContentKeyStore({
        database,
        masterKeySource: new ScriptedMasterKeySource(),
      });
      const disposer = new RecordingContentKeyDisposer(store);
      const service = new EventLogService({
        db: database,
        piiEncryptor: new DeterministicPiiEncryptor(),
        contentKeySource: store,
        ...(options?.withoutDisposer === true ? {} : { contentKeyDisposer: disposer }),
      });
      return { service, store, disposer };
    }

    function keyRowCount(sessionId: string): number {
      const row = database
        .prepare(`SELECT COUNT(*) AS n FROM session_content_keys WHERE session_id = ?`)
        .get(sessionId) as { readonly n: number };
      return row.n;
    }

    /**
     * A content-bearing append refused after the mint and before the INSERT by the codec's refusal
     * 7: the strict variant rejects the unregistered payload member, so the mint has committed and
     * no row is written.
     */
    function appendRefusedAfterTheMint(service: EventLogService): Promise<unknown> {
      const envelope = makeAssistantEnvelope();
      return service.append(
        {
          ...envelope,
          payload: { ...envelope.payload, unregisteredMember: "refused by the strict variant" },
        },
        { content: { body: "prose whose row never lands" } },
      );
    }

    it("retires the key a post-mint refusal left behind", async () => {
      const { service } = buildReconcilingFixture();

      await expect(appendRefusedAfterTheMint(service)).rejects.toThrow(
        /registered SessionEventSchema variant rejects/,
      );

      // No row and no key. Otherwise the session would hold a wrapped key with no body for a purge
      // to clear, and `rewrapAll` would walk it on every erasure.
      expect(keyRowCount(SESSION)).toBe(0);
      expect(database.prepare(`SELECT COUNT(*) AS total FROM session_events`).get()).toEqual({
        total: 0,
      });
    });

    it("leaves the orphan behind when no disposer is wired", async () => {
      // Non-vacuity control: the mint commits ahead of the refusal, so "no key row" above is not
      // vacuous. An unwired disposer delays the reclaim rather than losing it: the compactor's
      // pass-level sweep takes the row on a later tick.
      const { service } = buildReconcilingFixture({ withoutDisposer: true });

      await expect(appendRefusedAfterTheMint(service)).rejects.toThrow(
        /registered SessionEventSchema variant rejects/,
      );

      expect(keyRowCount(SESSION)).toBe(1);
    });

    it("keeps the key when an earlier append already sealed a body", async () => {
      // The reconciliation asks the disposer's durable predicate instead of remembering that it
      // minted, so a later refusal on a live session cannot destroy bodies it already holds.
      const { service, store } = buildReconcilingFixture();
      const sealed = makeAssistantEnvelope();
      await service.append(sealed, { content: { body: "an earlier body" } });

      await expect(appendRefusedAfterTheMint(service)).rejects.toThrow(
        /registered SessionEventSchema variant rejects/,
      );

      expect(keyRowCount(SESSION)).toBe(1);
      const resolved = await store.read(SESSION);
      const row = readStoredRow(sealed.id);
      expect(openContentPayload(row.content_payload!, resolved.key, SESSION, sealed.id)).toBe(
        "an earlier body",
      );
    });

    it("retires the key when a throwing prelude rolls the row back", async () => {
      // Second layer: the codec succeeded and the INSERT was reached, then the prelude aborted the
      // transaction. No codec refusal fires on this path.
      const { service } = buildReconcilingFixture();

      await expect(
        service.append(makeAssistantEnvelope(), {
          content: { body: "prose the prelude discards" },
          transactionalPrelude: () => {
            throw new Error("the prelude refused this write");
          },
        }),
      ).rejects.toThrow("the prelude refused this write");

      expect(keyRowCount(SESSION)).toBe(0);
      expect(database.prepare(`SELECT COUNT(*) AS total FROM session_events`).get()).toEqual({
        total: 0,
      });
    });

    it("never reaches for the disposer when the aborted append carried no body", async () => {
      // Negative control for the guard: an append with no content partition never minted, and
      // calling the disposer anyway could delete a key another append is about to seal under.
      // Asserted on the call record because the delegating disposer would decline anyway.
      const { service, disposer } = buildReconcilingFixture();
      await service.append(makeAssistantEnvelope(), { content: { body: "a live body" } });
      disposer.disposedSessionIds.length = 0;

      await expect(
        service.append(
          {
            ...makeAssistantEnvelope(),
            category: "session_lifecycle",
            type: "session.updated",
            payload: { sessionId: SESSION },
          },
          {
            transactionalPrelude: () => {
              throw new Error("an unrelated prelude failure");
            },
          },
        ),
      ).rejects.toThrow("an unrelated prelude failure");

      expect(disposer.disposedSessionIds).toEqual([]);
      expect(keyRowCount(SESSION)).toBe(1);
    });

    it("reports the append's own failure when the disposal itself fails", async () => {
      // The caller sees the append's own error, not a housekeeping fault. The leak this admits is
      // bounded because the pass-level sweep re-derives it.
      const { service, disposer } = buildReconcilingFixture();
      disposer.failure = new Error("the disposer itself is broken");

      await expect(appendRefusedAfterTheMint(service)).rejects.toThrow(
        /registered SessionEventSchema variant rejects/,
      );

      expect(disposer.disposedSessionIds).toEqual([SESSION]);
      expect(keyRowCount(SESSION)).toBe(1);
    });
  });
});
