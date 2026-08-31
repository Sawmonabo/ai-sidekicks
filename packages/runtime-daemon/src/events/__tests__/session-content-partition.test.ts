// Contract coverage for the machine-authored content partition — the sealing
// codec's content half, the session content key store behind it, and the
// end-to-end append that joins them (Plan-006 T3.6).
//
// ---------------------------------------------------------------------------
// THE ENUMERATION THIS FILE OPENS WITH, AND WHY IT IS A TEST
// ---------------------------------------------------------------------------
//
// Three matrices govern everything below, and all three are declared as DATA
// that the arms consume rather than as prose an arm might quietly stop
// matching:
//
//   * `CODEC_ROUTING_MATRIX` — the three partition combinations the codec must
//     route (participant PII alone, machine content alone, both on one row)
//     crossed with what each must produce in the two columns and in the signed
//     payload. The content-only row is the case the shipped code had no path
//     for at all: an assistant or tool row carries prose and usually no PII, so
//     before this partition existed it took the plain append path and the codec
//     never ran.
//   * `KEY_STORE_FAILURE_MATRIX` — every way resolving a session content key can
//     fail, each mapped to the reason the store must report. Two of its rows are
//     the security-relevant ones: a wrapped blob MOVED to another session's row
//     and a blob REPLAYED under a superseded key version must both refuse,
//     because the alternative is a silent key substitution that surfaces only as
//     an ordinary unreadable body while every integrity check stays green.
//   * `CODEC_REFUSAL_MATRIX` — every arm of the codec's fixed pre-encrypt
//     refusal order, each row naming the ordinal and the guard block that must
//     answer. The order is observable (the first guard to fire is the only one
//     a caller ever sees), so an arm that stopped firing or started firing
//     ahead of a sibling changes which message matches and fails.
//
// A matrix declared and never executed is a comment. All three are executed row
// by row, and all three carry a completeness assertion so adding a reason, a
// routing case, or a refusal arm without covering it fails here rather than
// shipping uncovered. The refusal matrix goes one step further and reads the
// codec's own published order back out of the source: a numbered list a reader
// trusts is exactly the kind of contract that drifts silently.
//
// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS
// ---------------------------------------------------------------------------
//
// Every arm that asserts a refusal is paired with the admitted input one
// perturbation away, so a guard that stopped refusing (or one that started
// refusing everything) fails rather than passing on a coincidence. The
// truncation arms hold the same discipline across the bound: one body under it,
// one exactly on it, one over it.
//
// Spec coverage: `Spec-006 §Canonical Serialization Rules` (the digest inside
// the signed payload, the ciphertext outside it), `Spec-022 §Daemon Master Key`
// (the wrap custody shape), `Spec-022 §Retention Policy` (the rotation the
// re-wrap entry point serves). Refs: Plan-006 T3.6, I-006-3-05, I-006-3-06,
// I-006-3-08.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { ed25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
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
import { IngestHaltRegistry } from "../ingest-halt-source.js";
import {
  PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  PII_PARTICIPANT_ID_PAYLOAD_KEY,
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
  type SessionContentKeyUnavailableReason,
} from "../session-content-key-store.js";
import {
  GENESIS_PREV_HASH,
  verifyRow,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
} from "../signer.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10");
const OTHER_SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");
const PARTICIPANT = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";

const DAEMON_PRIVATE_KEY = new Uint8Array(32).fill(11) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY = ed25519.getPublicKey(DAEMON_PRIVATE_KEY) as Ed25519PublicKey;

/** A deterministic 32-byte content key, so an arm can name the bytes it expects. */
const CONTENT_KEY = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(7);
const MASTER_KEY = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(3);
const ROTATED_MASTER_KEY = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(4);

let database: DatabaseType;

beforeEach(() => {
  // The production migration runner, never hand-rolled DDL: the CHECK
  // constraints and the `session_content_keys` primary key are part of what
  // these arms assert against.
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

  read(): Promise<Uint8Array> {
    this.readCallCount += 1;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.key);
  }
}

/** The injected PII encryptor stub — deterministic so an arm can name its bytes. */
class DeterministicPiiEncryptor implements PiiEncryptor {
  encryptCallCount = 0;

  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array> {
    this.encryptCallCount += 1;
    const keystream = blake3(
      new TextEncoder().encode(`${request.participantId} ${request.eventId}`),
      {
        dkLen: Math.max(1, request.plaintext.length),
      },
    );
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
    payload: overrides?.payload ?? { runId: "run-1", contentType: "text/markdown" },
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
    payload: overrides?.payload ?? { runId: "run-1" },
    version: ENVELOPE_VERSION,
    piiParticipantId: PARTICIPANT,
    piiPayload: { quoted: "something a person typed" },
    ...(overrides?.withContent === true
      ? { content: { body: "the assistant said this", contentKey: CONTENT_KEY } }
      : {}),
  };
}

function seal(input: RawEventInput, encryptor: PiiEncryptor): Promise<PiiEventWriteResult> {
  return writeEventWithPii(input, GENESIS_PREV_HASH, encryptor, DAEMON_PRIVATE_KEY);
}

// ----------------------------------------------------------------------------
// THE MATRICES
// ----------------------------------------------------------------------------

/** Which columns and which signed payload members one partition combination owes. */
interface CodecRoutingExpectation {
  readonly piiColumnPresent: boolean;
  readonly contentColumnPresent: boolean;
  readonly encryptorCalled: boolean;
  readonly signedPayloadKeys: readonly string[];
}

interface CodecRoutingCase {
  readonly name: string;
  readonly build: () => RawEventInput;
  readonly expected: CodecRoutingExpectation;
}

const CODEC_ROUTING_MATRIX: readonly CodecRoutingCase[] = [
  {
    name: "participant partition alone",
    build: () => makePiiCarryingInput(),
    expected: {
      piiColumnPresent: true,
      contentColumnPresent: false,
      encryptorCalled: true,
      signedPayloadKeys: [PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY, PII_PARTICIPANT_ID_PAYLOAD_KEY],
    },
  },
  {
    name: "machine content partition alone",
    build: () => makeContentOnlyInput(),
    expected: {
      piiColumnPresent: false,
      contentColumnPresent: true,
      encryptorCalled: false,
      signedPayloadKeys: [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY, CONTENT_LENGTH_PAYLOAD_KEY],
    },
  },
  {
    name: "both partitions on one row",
    build: () => makePiiCarryingInput({ withContent: true }),
    expected: {
      piiColumnPresent: true,
      contentColumnPresent: true,
      encryptorCalled: true,
      signedPayloadKeys: [
        PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
        PII_PARTICIPANT_ID_PAYLOAD_KEY,
        CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
        CONTENT_LENGTH_PAYLOAD_KEY,
      ],
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
      // The blob is untouched; only the version beside it moves, which is
      // exactly the rollback a re-wrap's version bump forecloses.
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
      database
        .prepare(`UPDATE session_content_keys SET encrypted_key_blob = ? WHERE session_id = ?`)
        .run("not a blob", SESSION);
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

/**
 * One arm of the codec's fixed pre-encrypt refusal order.
 *
 * The order is OBSERVABLE — the first guard to fire is the only one a caller
 * ever sees — so it is data here rather than prose: an arm that stopped firing,
 * or one that started firing ahead of a sibling, changes which row's `message`
 * matches and fails.
 */
interface CodecRefusalCase {
  readonly name: string;
  /** The ordinal the module's own documented order gives this guard. */
  readonly ordinal: number;
  /** Which guard block answers — several ordinals hold more than one. */
  readonly arm: string;
  readonly build: () => RawEventInput;
  readonly message: RegExp;
  readonly prevHash?: Uint8Array;
  readonly signingKey?: Ed25519PrivateKey;
}

/** An otherwise-valid content row, defective only in the named way. */
function contentRowWith(overrides: Record<string, unknown>): RawEventInput {
  return { ...makeContentOnlyInput(), ...overrides } as unknown as RawEventInput;
}

const CODEC_REFUSAL_MATRIX: readonly CodecRefusalCase[] = [
  {
    name: "a never-shredded category carrying prose",
    ordinal: 1,
    arm: "refused category",
    build: () => contentRowWith({ category: "audit_integrity", type: "audit.chain_verified" }),
    message: /audit_integrity/,
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
        payload: { runId: "run-1" },
        version: ENVELOPE_VERSION,
      }) as unknown as RawEventInput,
    message: /neither a PII partition nor a content partition/,
  },
  {
    name: "a participant id with no participant payload",
    ordinal: 1,
    arm: "half-present PII partition",
    build: () => contentRowWith({ piiParticipantId: PARTICIPANT }),
    message: /piiParticipantId with no piiPayload/,
  },
  {
    name: "a payload that pre-seeds the participant ciphertext digest",
    ordinal: 2,
    arm: "reserved PII digest",
    build: () =>
      ({
        ...makePiiCarryingInput({
          payload: { runId: "run-1", [PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "planted" },
        }),
      }) as RawEventInput,
    message: new RegExp(PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY),
  },
  {
    name: "a payload that pre-seeds the participant owner stamp",
    ordinal: 2,
    arm: "reserved PII stamp",
    build: () =>
      makePiiCarryingInput({
        payload: { runId: "run-1", [PII_PARTICIPANT_ID_PAYLOAD_KEY]: "planted" },
      }) as RawEventInput,
    message: new RegExp(PII_PARTICIPANT_ID_PAYLOAD_KEY),
  },
  {
    name: "a payload that pre-seeds the content ciphertext digest",
    ordinal: 2,
    arm: "reserved content members",
    build: () =>
      makeContentOnlyInput({
        payload: { runId: "run-1", [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "planted" },
      }),
    message: new RegExp(CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY),
  },
  {
    name: "a payload that pre-seeds the content length",
    ordinal: 2,
    arm: "reserved content members",
    build: () =>
      makeContentOnlyInput({ payload: { runId: "run-1", [CONTENT_LENGTH_PAYLOAD_KEY]: 4 } }),
    message: new RegExp(CONTENT_LENGTH_PAYLOAD_KEY),
  },
  {
    name: "a payload that pre-seeds the truncation marker",
    ordinal: 2,
    arm: "reserved content members",
    build: () =>
      makeContentOnlyInput({ payload: { runId: "run-1", [CONTENT_TRUNCATED_PAYLOAD_KEY]: true } }),
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
    name: "a chain link of the wrong width",
    ordinal: 5,
    arm: "prevHash",
    build: () => makeContentOnlyInput(),
    prevHash: new Uint8Array(16),
    message: /prev_hash/,
  },
  {
    name: "a signing key of the wrong width",
    ordinal: 6,
    arm: "daemon signing key",
    build: () => makeContentOnlyInput(),
    signingKey: new Uint8Array(16) as Ed25519PrivateKey,
    message: /daemon signing key/,
  },
  {
    name: "an empty participant id beside a participant payload",
    ordinal: 7,
    arm: "participant id shape",
    build: () => ({ ...makePiiCarryingInput(), piiParticipantId: "" }) as unknown as RawEventInput,
    message: /non-empty piiParticipantId/,
  },
  {
    name: "a body that is not a string",
    ordinal: 8,
    arm: "content body",
    build: () => contentRowWith({ content: { body: { not: "prose" }, contentKey: CONTENT_KEY } }),
    message: /content\.body to be a string/,
  },
  {
    name: "a content key of the wrong width",
    ordinal: 8,
    arm: "content key",
    build: () => contentRowWith({ content: { body: "prose", contentKey: new Uint8Array(16) } }),
    message: /content\.contentKey/,
  },
];

/**
 * The ordinals the codec's own docstring publishes, read from the source.
 *
 * The refusal order is a contract stated in two places — the numbered list in
 * the docstring and the guards themselves — and a reader trusts the list. This
 * reads the list back so a guard added, removed, or renumbered without the list
 * moving with it fails here.
 */
function documentedRefusalOrdinals(): readonly number[] {
  const source = readFileSync(new URL("../pii-indirection.ts", import.meta.url), "utf8");
  const listStart = source.indexOf("order of the body:");
  const listEnd = source.indexOf("ARE EARLY COPIES", listStart);
  expect(listStart).toBeGreaterThan(-1);
  expect(listEnd).toBeGreaterThan(listStart);
  return [...source.slice(listStart, listEnd).matchAll(/^\s*\*\s{3}(\d+)\./gm)].map((match) =>
    Number(match[1]),
  );
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
    // Three combinations, and the count is the claim: a fourth would mean a new
    // partition, and a third arm with neither is refused rather than routed.
    expect(CODEC_ROUTING_MATRIX.map((routingCase) => routingCase.name)).toEqual([
      "participant partition alone",
      "machine content partition alone",
      "both partitions on one row",
    ]);
    for (const routingCase of CODEC_ROUTING_MATRIX) {
      const input = routingCase.build();
      expect(input.piiPayload !== undefined || input.content !== undefined).toBe(true);
    }
  });

  it("covers every reason a session content key can be unavailable", () => {
    // The completeness half: the closed reason union has three members and every
    // one of them is produced by at least one arranged failure below. A fourth
    // reason added to the store without an arm here fails this assertion.
    const declaredReasons: readonly SessionContentKeyUnavailableReason[] = [
      "master_key_unavailable",
      "wrapped_key_missing",
      "wrapped_key_unopenable",
    ];
    const coveredReasons = new Set(KEY_STORE_FAILURE_MATRIX.map((failure) => failure.reason));
    expect([...coveredReasons].sort()).toEqual([...declaredReasons].sort());
  });

  it("covers every arm of the refusal order the codec publishes", () => {
    // The count is the claim, in both directions. The docstring's numbered list
    // is read back from the source, so a guard renumbered or added without the
    // list moving with it fails here — and an ordinal the list publishes with no
    // arm below it fails too.
    const documented = documentedRefusalOrdinals();
    expect(documented).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const coveredOrdinals = [...new Set(CODEC_REFUSAL_MATRIX.map((arm) => arm.ordinal))].sort(
      (left, right) => left - right,
    );
    expect(coveredOrdinals).toEqual([...documented]);

    // Several ordinals answer through more than one guard block, and the split
    // is load-bearing: each block carries its own message, so a merged guard
    // would report the wrong thing for one of the shapes it swallowed.
    const armsByOrdinal = new Map<number, Set<string>>();
    for (const refusal of CODEC_REFUSAL_MATRIX) {
      const arms = armsByOrdinal.get(refusal.ordinal) ?? new Set<string>();
      arms.add(refusal.arm);
      armsByOrdinal.set(refusal.ordinal, arms);
    }
    expect([...armsByOrdinal].map(([ordinal, arms]) => [ordinal, arms.size])).toEqual([
      [1, 3],
      [2, 3],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 1],
      [8, 2],
    ]);
  });

  for (const refusal of CODEC_REFUSAL_MATRIX) {
    it(`refuses ${refusal.name} before spending a nonce`, async () => {
      const encryptor = new DeterministicPiiEncryptor();
      await expect(
        writeEventWithPii(
          refusal.build(),
          refusal.prevHash ?? GENESIS_PREV_HASH,
          encryptor,
          refusal.signingKey ?? DAEMON_PRIVATE_KEY,
        ),
      ).rejects.toThrow(refusal.message);
      // Every arm here is documented as answerable from the input alone, which
      // is what makes the ordering claim worth stating: the refusal costs no
      // AEAD nonce on either partition.
      expect(encryptor.encryptCallCount).toBe(0);
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
      for (const key of routingCase.expected.signedPayloadKeys) {
        expect(Object.hasOwn(payload, key)).toBe(true);
      }
      // The negative half of the same claim: no member from the OTHER partition
      // leaks onto a row that does not carry it.
      const allCodecKeys: readonly string[] = [
        PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
        PII_PARTICIPANT_ID_PAYLOAD_KEY,
        CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
        CONTENT_LENGTH_PAYLOAD_KEY,
      ];
      for (const key of allCodecKeys) {
        if (!routingCase.expected.signedPayloadKeys.includes(key)) {
          expect(Object.hasOwn(payload, key)).toBe(false);
        }
      }
      // `contentTruncated` is absent on every row here — none of these bodies is
      // over the bound, and absence is the completeness signal.
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

    // The positive control first, so the two refusals below are one perturbation
    // away from a working open rather than away from nothing.
    expect(openContentPayload(sealed, CONTENT_KEY, SESSION, input.id)).toBe(
      "the assistant said this",
    );
    expect(() => openContentPayload(sealed, CONTENT_KEY, OTHER_SESSION, input.id)).toThrow();
    expect(() => openContentPayload(sealed, CONTENT_KEY, SESSION, "evt-other")).toThrow();
    const wrongKey = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(8);
    expect(() => openContentPayload(sealed, wrongKey, SESSION, input.id)).toThrow();
  });

  it("commits to the stored ciphertext without putting it in the signed bytes", async () => {
    const input = makeContentOnlyInput();
    const result = await seal(input, new DeterministicPiiEncryptor());
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(payload[CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe(
      bytesToHex(blake3(result.contentPayload!)),
    );
    // The ciphertext itself is nowhere in the canonical form. Serializing the
    // payload and searching for a prefix of the sealed bytes is the direct
    // question, and it is asked over the SIGNED members rather than over the
    // whole result object.
    const canonical = canonicalizeEvent(result.envelope);
    const canonicalText = new TextDecoder().decode(canonical);
    expect(canonicalText).not.toContain(bytesToHex(result.contentPayload!.subarray(0, 8)));

    // And the signature still verifies over exactly those bytes — the digest is
    // inside them, the ciphertext is not.
    expect(verifyRow(canonical, result.signedRow, DAEMON_PUBLIC_KEY)).toEqual({ valid: true });
  });

  it("keeps the ciphertext out of the measured canonical byte length", async () => {
    const short = await seal(makeContentOnlyInput({ body: "x" }), new DeterministicPiiEncryptor());
    const long = await seal(
      makeContentOnlyInput({ body: "y".repeat(50_000) }),
      new DeterministicPiiEncryptor(),
    );

    // A 50 KB body inflates the ciphertext by 50 KB and the canonical bytes by
    // nothing beyond the `contentLength` integer's own digits — which is the
    // whole reason a quarter-megabyte tool result cannot push a row past the
    // canonical ceiling.
    expect(long.contentPayload!.length - short.contentPayload!.length).toBeGreaterThan(49_000);
    expect(long.canonicalByteLength - short.canonicalByteLength).toBeLessThan(10);
  });

  it("runs the order once over a row carrying both partitions", async () => {
    const input = makePiiCarryingInput({ withContent: true });
    const encryptor = new DeterministicPiiEncryptor();
    const result = await seal(input, encryptor);
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(encryptor.encryptCallCount).toBe(1);
    expect(payload[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe(bytesToHex(blake3(result.piiPayload!)));
    expect(payload[CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe(
      bytesToHex(blake3(result.contentPayload!)),
    );
    expect(result.piiParticipantId).toBe(PARTICIPANT);
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
    // No sentinel, sigil, or ellipsis is appended — the marker is the payload
    // member, and a body that announced its own truncation in its text would be
    // a body the assistant never wrote.
    expect(opened).toBe("a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX));
  });

  it("cuts at a codepoint boundary when the bound lands mid-sequence", async () => {
    // One filler byte short of the bound, then a three-byte codepoint that
    // straddles it. A byte-exact cut would emit a truncated UTF-8 sequence.
    const filler = "a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX - 1);
    const body = `${filler}${EM_DASH}${EM_DASH}`;
    const result = await seal(makeContentOnlyInput({ body }), new DeterministicPiiEncryptor());
    const payload = result.envelope.payload as Record<string, unknown>;

    expect(payload[CONTENT_TRUNCATED_PAYLOAD_KEY]).toBe(true);
    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(
      CONTENT_PAYLOAD_PLAINTEXT_MAX - 1 + EM_DASH_BYTES * 2,
    );
    // The open uses a FATAL decoder, so a mid-codepoint cut would throw here
    // rather than yield a replacement character.
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
    // The negative control for the arm above: the same shape with the multi-byte
    // codepoint ENDING on the bound rather than straddling it, so nothing is
    // walked back.
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
});

describe("codec refusals over the content partition", () => {
  // The refusal arms themselves are enumerated and driven by
  // `CODEC_REFUSAL_MATRIX` above. What stays here is what a per-arm table cannot
  // say: the admitted input one perturbation away from a refused one, and the
  // ORDER two defects resolve in.

  it("admits a payload one perturbation away from every reserved member", async () => {
    // The negative control for refusal 2's content arm: the same payload shape
    // without the reserved member is sealed, so the arm above is refusing the
    // member rather than the shape.
    await expect(
      seal(makeContentOnlyInput({ payload: { runId: "run-1" } }), new DeterministicPiiEncryptor()),
    ).resolves.toBeDefined();
  });

  it("admits the producer-owned content type beside the codec-owned members", async () => {
    // `contentType` is the producer's member and is deliberately NOT reserved:
    // the producer knows the media type of what it emitted and the codec never
    // could. This is the boundary of the refusal above.
    const result = await seal(
      makeContentOnlyInput({ payload: { runId: "run-1", contentType: "text/markdown" } }),
      new DeterministicPiiEncryptor(),
    );
    expect((result.envelope.payload as Record<string, unknown>)["contentType"]).toBe(
      "text/markdown",
    );
  });

  it("keeps the participant half rather than routing a half-present row as content", async () => {
    // The negative control for refusal 1's third arm, and the reason that arm
    // exists: supplying BOTH halves seals the participant partition instead of
    // silently dropping it, which is what the refused shape would have done.
    const result = await seal(makePiiCarryingInput(), new DeterministicPiiEncryptor());
    expect(result.piiParticipantId).toBe(PARTICIPANT);
    expect(result.piiPayload).toBeInstanceOf(Uint8Array);
  });

  it("refuses the content partition last, so no earlier refusal's message moves", async () => {
    // An input defective in BOTH an earlier way and the content way must report
    // the earlier one. The sequence guard is refusal 3; the content shape guard
    // is refusal 8.
    const doublyDefective = {
      ...makeContentOnlyInput(),
      sequence: 1.5,
      content: { body: 42, contentKey: CONTENT_KEY },
    } as unknown as RawEventInput;
    await expect(seal(doublyDefective, new DeterministicPiiEncryptor())).rejects.toThrow(
      /not a safe integer/,
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

    // A body sealed under the inner key BEFORE the rotation, so the arm proves
    // the rotation moved the envelope and not the material.
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

    // The superseded master no longer opens the row, which is what forecloses a
    // rollback to a destroyed key.
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
    // A synchronous seed, because the whole point of the synchronous signature
    // is that it can be called where no `await` may appear.
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

    // The rotation runs inside the caller's own BEGIN EXCLUSIVE, exactly as
    // rotate-on-shred will run it beside the participant-key re-wrap.
    const rotateAndFail = database.transaction((): void => {
      store.rewrapAll(MASTER_KEY, ROTATED_MASTER_KEY);
      throw new Error("the caller's later step failed");
    });
    expect(() => {
      rotateAndFail.exclusive();
    }).toThrow("the caller's later step failed");

    // Rolled back with the caller: the row is still at version 1 under the
    // previous master, so the two tables cannot end up on different masters.
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
});

/**
 * The wrap format, re-derived in the test rather than imported.
 *
 * The store exports its AAD builder and its widths but not its `encrypt`, and
 * that is the right seam: an arm that imported the sealing function would assert
 * the store agrees with itself. This re-derivation is what makes the seeded row
 * above an INDEPENDENT witness to the format the store reads.
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
  } {
    const masterKeySource = new ScriptedMasterKeySource();
    const store = new SessionContentKeyStore({ database, masterKeySource });
    const service = new EventLogService({
      db: database,
      signingKeySource: {
        create: () => Promise.resolve({ publicKey: DAEMON_PUBLIC_KEY }),
        read: () => Promise.resolve(DAEMON_PRIVATE_KEY),
      },
      haltSource: new IngestHaltRegistry(),
      piiEncryptor: new DeterministicPiiEncryptor(),
      ...(options?.withoutKeySource === true ? {} : { contentKeySource: store }),
    });
    return { service, store };
  }

  function makeAssistantEnvelope(): UnsequencedEventEnvelope {
    return {
      id: nextEventId(),
      sessionId: SESSION,
      occurredAt: "2026-08-30T12:00:00.000Z",
      category: "assistant_output",
      type: "assistant.message",
      actor: "agent-1",
      payload: { runId: "run-1", contentType: "text/markdown" },
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

    // The signed payload carries the digest and the length, and no body.
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload[CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe(
      bytesToHex(blake3(row.content_payload!)),
    );
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
      pii: { participantId: PARTICIPANT, piiPayload: { quoted: "something a person typed" } },
    });

    const row = readStoredRow(envelope.id);
    expect(row.content_payload).toBeInstanceOf(Uint8Array);
    expect(row.pii_payload).toBeInstanceOf(Uint8Array);
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe(bytesToHex(blake3(row.pii_payload!)));
    expect(payload[CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe(
      bytesToHex(blake3(row.content_payload!)),
    );
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
    expect(Object.hasOwn(payload, CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY)).toBe(false);
  });

  it("fails loudly rather than dropping prose when no key source is wired", async () => {
    const { service } = buildAppendFixture({ withoutKeySource: true });
    await expect(
      service.append(makeAssistantEnvelope(), { content: { body: "would be lost" } }),
    ).rejects.toThrow(/contentKeySource/);
    // Nothing landed: no row, and no half-written key.
    expect(database.prepare(`SELECT COUNT(*) AS total FROM session_events`).get()).toEqual({
      total: 0,
    });
  });

  it("keeps the chain verifying across a run of content-bearing appends", async () => {
    const { service } = buildAppendFixture();
    for (let index = 0; index < 4; index += 1) {
      await service.append(makeAssistantEnvelope(), {
        content: { body: `turn ${String(index)}` },
      });
    }

    const rows = database
      .prepare(
        `SELECT id, session_id, sequence, occurred_at, category, type, actor, payload,
                correlation_id, causation_id, version, prev_hash, row_hash, daemon_signature
           FROM session_events
          WHERE session_id = ?
          ORDER BY sequence`,
      )
      .all(SESSION) as ReadonlyArray<Record<string, unknown>>;

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const envelope = {
        id: row["id"] as string,
        sessionId: row["session_id"] as SessionId,
        sequence: row["sequence"] as number,
        occurredAt: row["occurred_at"] as string,
        category: row["category"] as UnsequencedEventEnvelope["category"],
        type: row["type"] as string,
        actor: row["actor"] as string | null,
        payload: JSON.parse(row["payload"] as string) as Record<string, unknown>,
        version: row["version"] as UnsequencedEventEnvelope["version"],
        correlationId: (row["correlation_id"] as string | null) ?? undefined,
        causationId: (row["causation_id"] as string | null) ?? undefined,
      };
      const verification = verifyRow(
        canonicalizeEvent(envelope),
        {
          prevHash: new Uint8Array(row["prev_hash"] as Uint8Array),
          rowHash: new Uint8Array(row["row_hash"] as Uint8Array),
          daemonSignature: new Uint8Array(row["daemon_signature"] as Uint8Array),
        },
        DAEMON_PUBLIC_KEY,
      );
      expect(verification).toEqual({ valid: true });
    }
  });
});
