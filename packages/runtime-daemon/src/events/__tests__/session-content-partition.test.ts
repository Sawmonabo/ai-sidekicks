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
//   * `CODEC_REFUSAL_MATRIX` — every arm of the codec's fixed refusal order,
//     each row naming the ordinal and the guard block that must answer. The
//     order is observable (the first guard to fire is the only one a caller
//     ever sees), so an arm that stopped firing or started firing ahead of a
//     sibling changes which message matches and fails. Ordinals 1–8 are
//     pre-encrypt and every one of them carries the no-nonce-spent claim;
//     ordinal 9 — the composed-variant parse — is documented as firing BEHIND
//     the seal, and each row states the encrypt count it must observe rather
//     than inheriting a blanket zero that would be false evidence.
//
// A matrix declared and never executed is a comment. All three are executed row
// by row, and all three carry a completeness assertion so adding a reason, a
// routing case, or a refusal arm without covering it fails here rather than
// shipping uncovered. The refusal matrix goes one step further and reads the
// codec's own published order back out of the source: a numbered list a reader
// trusts is exactly the kind of contract that drifts silently.
//
// The file's LAST arm is not a matrix and is not about this module alone: it
// pins the codec's refused-category set against the contracts registration of
// the two PII indirection members, deriving both halves rather than restating
// either. It lives here rather than beside the per-variant ratchet in
// `packages/contracts/src/__tests__/event-source-epoch.test.ts` because it is
// the only place both packages are already in scope — that ratchet is
// variant-granular but single-package, this arm is category-granular but
// cross-package, and neither subsumes the other. Its own header says why the
// direction it covers is the silent one.
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
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
  SessionIdSchema,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { canonicalizeEvent } from "../canonicalizer.js";
import { EventLogService, type UnsequencedEventEnvelope } from "../event-log-service.js";
import { IngestHaltRegistry } from "../ingest-halt-source.js";
import {
  BODY_BEARING_EVENT_TYPES,
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
  /**
   * Runs INSIDE one read, after the key has been captured and before the promise
   * resolves — the arranged interleaving seam for the mint/rotation race.
   *
   * The capture-then-hook order is the whole point rather than an
   * implementation detail: it models a source that obtained the master key
   * BEFORE a rotation and resolves with it AFTER, which is precisely the
   * sequence that lets a first mint wrap under a destroyed master. A hook that
   * ran before the capture would simply hand back the new key and reproduce
   * nothing.
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
  /**
   * How many times the injected encryptor must have run when this arm fires —
   * ZERO for every arm the codec documents as answerable from the input alone,
   * and the field exists because refusal 9 is not one of them.
   *
   * Stated per arm rather than assumed, because a bare `toBe(0)` is FALSE
   * EVIDENCE of pre-encrypt ordering on any content-only row: the injected
   * encryptor is never called for one whatever happens, so the zero says
   * nothing about when the guard fired. The arms that pin the ordering are the
   * ones carrying a participant partition — where the encrypt step WOULD have
   * run — and refusal 9's PII arm asserts `1` for exactly that reason.
   */
  readonly expectedEncryptCalls?: number;
}

/** An otherwise-valid content row, defective only in the named way. */
function contentRowWith(overrides: Record<string, unknown>): RawEventInput {
  return { ...makeContentOnlyInput(), ...overrides } as unknown as RawEventInput;
}

/**
 * The `type` / `category` / `payload` trio a body-bearing row of `eventType`
 * must carry to satisfy that type's own registered `SessionEventSchema` variant.
 *
 * The trio is what refusal 9 judges, so it cannot be reduced to a type string:
 * the tool variants REQUIRE `toolName` while the assistant ones declare no such
 * member, so `.strict()` rejects it there along with anything else it does not
 * name. A loop that supplied one payload for all five would be asserting that
 * the codec seals rows half of which their own schema rejects — which is exactly
 * the defect refusal 9 exists to stop.
 */
function bodyBearingRowFor(eventType: string): Record<string, unknown> {
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
        payload: { sessionId: SESSION, runId: "run-1" },
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
    // The closed set is derived from the contracts union, so this arm is what
    // stops a body being sealed onto a type whose `.strict()` payload schema
    // declares none of the three members the embed step projects — a row that
    // would be signed, chained, and then rejected by its own schema on the way
    // back out.
    name: "a content partition on a type that declares no content members",
    ordinal: 1,
    arm: "content on an unregistered type",
    build: () => contentRowWith({ type: "session.created", category: "session_lifecycle" }),
    message: /content partition on event type "session\.created"/,
  },
  {
    name: "a payload that pre-seeds the participant ciphertext digest",
    ordinal: 2,
    arm: "reserved PII digest",
    build: () =>
      ({
        ...makePiiCarryingInput({
          payload: {
            sessionId: SESSION,
            runId: "run-1",
            [PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "planted",
          },
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
        payload: {
          sessionId: SESSION,
          runId: "run-1",
          [PII_PARTICIPANT_ID_PAYLOAD_KEY]: "planted",
        },
      }) as RawEventInput,
    message: new RegExp(PII_PARTICIPANT_ID_PAYLOAD_KEY),
  },
  {
    name: "a payload that pre-seeds the content ciphertext digest",
    ordinal: 2,
    arm: "reserved content members",
    build: () =>
      makeContentOnlyInput({
        payload: {
          sessionId: SESSION,
          runId: "run-1",
          [CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "planted",
        },
      }),
    message: new RegExp(CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY),
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
  {
    // `TextEncoder` substitutes U+FFFD for an unpaired surrogate rather than
    // refusing, so without this arm the row would carry a signed, digested
    // commitment to a replacement character standing where the producer's text
    // was — and the read side's `fatal: true` decoder would pass it, because the
    // stored UTF-8 is perfectly valid. The corruption happens on the way in.
    name: "a body carrying an unpaired surrogate",
    ordinal: 8,
    arm: "content body well-formedness",
    build: () =>
      contentRowWith({
        content: { body: "prose with a lone \ud800 half", contentKey: CONTENT_KEY },
      }),
    message: /well-formed UTF-16/,
  },
  {
    // Refusal 1's fourth arm reads `type` and nothing else, so a body on one of
    // the five under the WRONG category clears it and reaches the embed step.
    // The variant's `category` is a literal, so the row it would have signed is
    // rejected by its own schema on the way back out.
    name: "a body-bearing type under a category its variant does not declare",
    ordinal: 9,
    arm: "composed-variant parse",
    build: () => contentRowWith({ category: "tool_activity" }),
    message: /category \(invalid_value\)/,
  },
  {
    name: "a payload missing a member its registered variant requires",
    ordinal: 9,
    arm: "composed-variant parse",
    build: () => makeContentOnlyInput({ payload: { runId: "run-1" } }),
    message: /payload\.sessionId \(invalid_type\)/,
  },
  {
    // The tool trio's own required member, which the assistant pair does not
    // have: one payload shape for all five would seal rows half of which their
    // own schema rejects.
    name: "a tool row with no tool name",
    ordinal: 9,
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
    // The `unrecognized_keys` arm, and the one code whose rendering carries
    // member NAMES — the only way the message can say WHICH member the strict
    // layer does not know.
    name: "a payload carrying a member no variant declares",
    ordinal: 9,
    arm: "composed-variant parse",
    build: () =>
      makeContentOnlyInput({
        payload: { sessionId: SESSION, runId: "run-1", improvisedMember: "not in any variant" },
      }),
    message: /payload \(unrecognized_keys: improvisedMember\)/,
  },
  {
    // THE PII ROUTE, and the arm that pins refusal 9's placement. This row
    // carries a participant partition on a registered type, so the encrypt step
    // has already run when the parse refuses — `expectedEncryptCalls: 1` is the
    // assertion, and a `0` here would mean the guard had been hoisted ahead of
    // the seal and was judging a reconstruction rather than the signed form.
    name: "a participant row whose payload its registered variant rejects",
    ordinal: 9,
    arm: "composed-variant parse",
    build: () => makePiiCarryingInput({ payload: { runId: "run-1" } }),
    message: /payload\.sessionId \(invalid_type\)/,
    expectedEncryptCalls: 1,
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
    expect(documented).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

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
      [1, 4],
      [2, 3],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 1],
      [8, 3],
      // Refusal 9 answers through ONE guard block over every shape the strict
      // layer can reject — a category mismatch, a missing member, an
      // unrecognized one — because the block delegates the judgement to the
      // registered variant rather than enumerating defects of its own.
      [9, 1],
    ]);
  });

  for (const refusal of CODEC_REFUSAL_MATRIX) {
    it(`refuses ${refusal.name}`, async () => {
      const encryptor = new DeterministicPiiEncryptor();
      await expect(
        writeEventWithPii(
          refusal.build(),
          refusal.prevHash ?? GENESIS_PREV_HASH,
          encryptor,
          refusal.signingKey ?? DAEMON_PRIVATE_KEY,
        ),
      ).rejects.toThrow(refusal.message);
      // Arms 1–8 are documented as answerable from the input alone, which is
      // what makes the ordering claim worth stating: the refusal costs no AEAD
      // nonce on either partition. Refusal 9 is documented as the one that
      // fires BEHIND the encrypt, and its PII arm asserts the `1` that proves
      // it — see `expectedEncryptCalls` for why a blanket zero would be false
      // evidence on a content-only row.
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

  it("never asks the encoder to materialize more than the bound", async () => {
    // THE ALLOCATION CLAIM, ASSERTED AT THE SEAM RATHER THAN ON THE HEAP.
    // `applyPlaintextBound` computes the pre-truncation byte length by walking
    // code points, so the only string it ever hands `TextEncoder` is the bounded
    // prefix. A body eight times the budget is therefore encoded ONCE, at the
    // budget — an encode-then-cut implementation would materialize all of it
    // before learning it must be thrown away, which is unbounded allocation on
    // exactly the input the bound exists to contain.
    const body = "a".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX * 8);
    const originalEncode = TextEncoder.prototype.encode;
    let widestEncodedBytes = 0;
    // Installed immediately before the sealing call and removed immediately
    // after, so no other arm's encoding pollutes the measurement.
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
    // The negative control the assertion above needs: the bound still did its
    // job over the whole body, so this is a claim about HOW the length was
    // computed rather than about the walk having been skipped.
    const payload = result.envelope.payload as Record<string, unknown>;
    expect(payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX * 8);
    expect(payload[CONTENT_TRUNCATED_PAYLOAD_KEY]).toBe(true);
  });

  it("counts astral code points at four bytes without encoding the body", async () => {
    // The walk's own arithmetic, over the width it is easiest to get wrong: a
    // surrogate PAIR is one code point of four UTF-8 bytes, not two units of
    // three. A per-unit sum would report six and truncate a body that fits.
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
    // The four-byte sibling of the em-dash arm: three filler bytes short of the
    // budget, then a code point that needs four. The whole code point is
    // dropped, and a fatal decoder proves nothing half of it survived.
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
  // The refusal arms themselves are enumerated and driven by
  // `CODEC_REFUSAL_MATRIX` above. What stays here is what a per-arm table cannot
  // say: the admitted input one perturbation away from a refused one, and the
  // ORDER two defects resolve in.

  it("admits a payload one perturbation away from every reserved member", async () => {
    // The negative control for refusal 2's content arm: the same payload shape
    // without the reserved member is sealed, so the arm above is refusing the
    // member rather than the shape.
    await expect(
      seal(
        makeContentOnlyInput({ payload: { sessionId: SESSION, runId: "run-1" } }),
        new DeterministicPiiEncryptor(),
      ),
    ).resolves.toBeDefined();
  });

  it("admits the producer-owned content type beside the codec-owned members", async () => {
    // `contentType` is the producer's member and is deliberately NOT reserved:
    // the producer knows the media type of what it emitted and the codec never
    // could. This is the boundary of the refusal above.
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

  it("seals a body on every event type the contracts union registers as body-bearing", async () => {
    // THE CLOSED SET IS READ, NOT RE-TYPED. `BODY_BEARING_EVENT_TYPES` is derived
    // in the codec from the `SessionEvent` union, so this loop drives whatever
    // that derivation yields; re-listing the five here would be the second
    // source of truth the derivation exists to prevent.
    const bodyBearingTypes = Object.keys(BODY_BEARING_EVENT_TYPES);
    // The count IS the claim, and it is what makes the loop non-vacuous: a
    // derivation that collapsed to `never` would satisfy its own type annotation
    // and drive nothing at all.
    expect(bodyBearingTypes).toEqual([
      "assistant.message",
      "assistant.thinking_update",
      "tool.invoked",
      "tool.result",
      "tool.error",
    ]);

    for (const bodyBearingType of bodyBearingTypes) {
      const result = await seal(
        contentRowWith(bodyBearingRowFor(bodyBearingType)),
        new DeterministicPiiEncryptor(),
      );
      expect(result.contentPayload).toBeInstanceOf(Uint8Array);
    }
  });

  it("refuses a content partition on an unregistered type before spending the participant nonce", async () => {
    // The refusal matrix drives this arm on a content-ONLY row, where the
    // encryptor is never called whatever happens. Pairing it with a PII
    // partition is what makes `encryptCallCount` a real assertion: the encrypt
    // step WOULD run for this input if the guard did not fire first.
    const encryptor = new DeterministicPiiEncryptor();
    const misroutedRow = {
      ...makePiiCarryingInput({ withContent: true }),
      type: "session.created",
      category: "session_lifecycle",
    } as unknown as RawEventInput;

    await expect(seal(misroutedRow, encryptor)).rejects.toThrow(/content partition on event type/);
    expect(encryptor.encryptCallCount).toBe(0);

    // The perturbation back: the identical row on a registered type seals both
    // partitions and DOES spend the nonce, so the count above is a fact about
    // the guard rather than about the fixture.
    const admitted = await seal(makePiiCarryingInput({ withContent: true }), encryptor);
    expect(admitted.contentPayload).toBeInstanceOf(Uint8Array);
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses an ill-formed body before spending the participant nonce", async () => {
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
    // away from a working seal rather than away from nothing. A pair is ordinary
    // text and must round-trip byte-for-byte.
    const paired = "an emoji \u{1F331} in ordinary prose";
    const result = await seal(
      makeContentOnlyInput({ body: paired }),
      new DeterministicPiiEncryptor(),
    );
    expect(
      openContentPayload(result.contentPayload!, CONTENT_KEY, SESSION, result.envelope.id),
    ).toBe(paired);

    // Every way a surrogate can be unpaired: a lead alone, a trail alone, a lead
    // followed by ordinary text, a trail reached before any lead, and a lead in
    // the final position with nothing after it.
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

  it("signs a row whose type the strict layer registers no variant for", async () => {
    // THE TOLERANT-CARRIER NEGATIVE CONTROL, and the boundary of refusal 9's
    // dispatch. `packages/contracts/src/event.ts` requires a reader to persist
    // an envelope whose `type` it cannot interpret rather than reject it, so a
    // guard that parsed every row would make this codec the one place the
    // carrier is not tolerated. This payload would satisfy no registered
    // variant — it declares a member none of them knows — and the row seals
    // anyway, because no variant claims to interpret `participant.exported`.
    const result = await seal(
      {
        ...makePiiCarryingInput(),
        type: "participant.exported",
        category: "participant_lifecycle",
        payload: { improvisedMember: "a higher-MINOR producer's member" },
      } as unknown as RawEventInput,
      new DeterministicPiiEncryptor(),
    );

    expect(result.piiPayload).toBeInstanceOf(Uint8Array);
    // The perturbation back: the identical payload on a REGISTERED type is
    // refused, so the seal above is a fact about the dispatch rather than about
    // the guard having quietly stopped firing.
    await expect(
      seal(
        makePiiCarryingInput({ payload: { improvisedMember: "a higher-MINOR producer's member" } }),
        new DeterministicPiiEncryptor(),
      ),
    ).rejects.toThrow(/registered SessionEventSchema variant rejects/);
  });

  it("parses the composed row VERBATIM — nothing is projected away before the guard", async () => {
    // THE CLAIM THE SEAM RESTS ON. An earlier revision of this guard cut the
    // two participant bindings out of its parse subject, because no registered
    // variant declared them and every payload schema is `.strict()`, so a
    // verbatim parse would have refused every participant row ever written.
    // `packages/contracts/src/event.ts` now registers both as schema-optional
    // members on every variant whose category may carry a PII partition, which
    // is what `Spec-006 §Canonical Serialization Rules` requires of such a row —
    // so the cut is gone and the guard judges the signed row exactly as a reader
    // will get it back.
    //
    // Asserted on the SUCCESS path, in three legs, because a regression here
    // would be silent: a guard that quietly went back to projecting would still
    // refuse the defects the arms above cover.
    const result = await seal(
      makePiiCarryingInput({ withContent: true }),
      new DeterministicPiiEncryptor(),
    );

    // (1) Both bindings are on the row that was signed — the owner stamp the
    // shred selector reads, and the digest the verifier compares.
    const payload = result.envelope.payload as Record<string, unknown>;
    expect(payload[PII_PARTICIPANT_ID_PAYLOAD_KEY]).toBe(PARTICIPANT);
    expect(typeof payload[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]).toBe("string");

    // (2) The signature covers that row: canonical bytes re-derived from the
    // returned envelope still verify.
    expect(
      verifyRow(canonicalizeEvent(result.envelope), result.signedRow, DAEMON_PUBLIC_KEY),
    ).toEqual({ valid: true });

    // (3) And the same object — with the content trio embedded beside the PII
    // pair, nothing removed — parses through the strict layer. This is the leg
    // the excision made impossible, and it is what makes "parse what you sign"
    // literally true on this route rather than true of a projection of it.
    const parsed = SessionEventSchema.safeParse(result.envelope);
    expect(parsed.success).toBe(true);
  });

  it("reports the composed-variant refusal after every input-answerable one, so no message moves", async () => {
    // Refusal 9 is LAST, and an input defective in both an earlier way and the
    // schema way must report the earlier one — which is what it reported before
    // the parse existed. The content key width is refusal 8.
    const doublyDefective = contentRowWith({
      payload: { runId: "run-1" },
      content: { body: "prose", contentKey: new Uint8Array(16) },
    });

    await expect(seal(doublyDefective, new DeterministicPiiEncryptor())).rejects.toThrow(
      /content\.contentKey/,
    );
  });

  it("reports the well-formedness refusal after the key-width one, so no message moves", async () => {
    // The well-formedness arm is appended LAST within refusal 8. An input
    // defective in both ways must still report the key width, which is what it
    // reported before this arm existed.
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

  // --------------------------------------------------------------------------
  // The mint / rotate-on-shred race
  // --------------------------------------------------------------------------
  //
  // The worst failure this store has, and the one no other arm can reach: a
  // FIRST mint reads master `M`, loses the CPU at its own `await`, and wakes to
  // find rotate-on-shred installed `M'` and destroyed `M`. Rotation's own
  // `BEGIN EXCLUSIVE` cannot help — there is no row yet, because the row is
  // still in the minter's hand. The blob lands wrapped under a key that no
  // longer exists, the append succeeds, and every later read of that session's
  // bodies is permanently undecryptable while every integrity check stays green.
  //
  // `ScriptedMasterKeySource.beforeRead` arranges exactly that interleaving.

  it("never persists a key wrapped under a master that rotation destroyed", async () => {
    const { store, masterKeySource } = buildKeyStore();
    // A row rotation will genuinely re-wrap, so the arm exercises a real
    // rotation rather than an epoch bump over an empty table.
    const otherBefore = await store.resolveForWrite(OTHER_SESSION);
    expect(masterKeySource.readCallCount).toBe(1);

    masterKeySource.beforeRead = () => {
      // One-shot: the retry must find a settled world, or the arm would be
      // testing the retry ceiling instead of the fence.
      masterKeySource.beforeRead = undefined;
      store.rewrapAll(MASTER_KEY, ROTATED_MASTER_KEY);
      masterKeySource.key = ROTATED_MASTER_KEY;
    };

    const minted = await store.resolveForWrite(SESSION);

    // Two reads for this mint: the one that lost the race, and the retry.
    expect(masterKeySource.readCallCount).toBe(3);

    // THE ASSERTION THAT MATTERS. `resolveForWrite` returns a usable key either
    // way — it opens the row with the master it just wrapped under, destroyed or
    // not — so the failure is only visible on a LATER read, which is exactly how
    // it would reach production.
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
    // The fence is bumped at `rewrapAll`'s ENTRY, ahead of its own width guard.
    // Over-signalling costs a racing mint one spurious retry; under-signalling
    // costs a session its bodies, so the ordering is one-directional on purpose.
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
    // The retry is BOUNDED, and this is why: a source that rotated on every read
    // would spin an append forever behind an unbounded loop. The refusal reuses
    // `master_key_unavailable` rather than minting a fourth reason the read path
    // could never produce.
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

// ----------------------------------------------------------------------------
// THE SEAM BETWEEN THIS MODULE AND THE CONTRACTS REGISTRATION
// ----------------------------------------------------------------------------
//
// Two layers now hold the same rule about which rows may carry the PII
// indirection pair, and each spells it in its own vocabulary:
//
//   * the codec, per CATEGORY, at `PII_REFUSED_CATEGORY_NAMES` and the switch
//     that reads it — the refusal that keeps a `pii_payload` off a row
//     `Plan-006 §Audit Integrity Invariant` says is never compacted and never
//     crypto-shredded;
//   * `packages/contracts/src/event.ts`, per registered VARIANT, as the
//     presence or absence of the two optional members in that variant's payload
//     shape.
//
// One direction of drift is loud on its own: a category the contracts layer
// stops admitting is refused by the composed-variant parse (refusal 9) on every
// such row, immediately and with the member named. The OTHER direction is
// silent. If `PII_REFUSED_CATEGORY_NAMES` ever narrows — a name dropped in a
// refactor, a category added to `EventCategorySchema` and forgotten here — the
// codec starts sealing rows whose variants do not register the pair, and the
// failure surfaces only AFTER the AES seal, on a row class the corpus says
// never carries participant text at all. The per-variant ratchet in
// `packages/contracts/src/__tests__/event-source-epoch.test.ts` cannot see
// that: it knows only what its own file spells.
//
// So this arm asserts the EQUIVALENCE, and DERIVES both halves rather than
// re-spelling either. The codec half is behavioural — hand `writeEventWithPii`
// a row in each category and observe whether the category guard answers. The
// contracts half is a parse probe read against a control. Neither half restates
// the list, so there is no third copy to drift.
// ----------------------------------------------------------------------------

/**
 * What a registered strict variant does with the two PII indirection members,
 * decided by probing rather than by restating a list.
 *
 * `inconclusive` is a real third answer, not a failure. `audit_integrity_failed`
 * is a DISCRIMINATED UNION on `failureMode`, so a probe payload that carries no
 * discriminator stops at the union and never reaches any arm's strict check —
 * the probe learns nothing about that arm's keys either way. Reporting that
 * honestly is what keeps the aggregate below from silently recording a union
 * variant as admitting the pair, which is what a two-valued verdict did on the
 * first run of this arm.
 *
 * An inconclusive verdict is not a coverage hole. The contracts ratchet reads
 * that same variant ARM-EXACTLY (it resolves a union payload to its option
 * list and aggregates key presence across every arm), so the variant is pinned
 * there; what this arm adds is the CATEGORY-level agreement with the codec,
 * and `audit_integrity` is decided here by its two non-union siblings. The
 * `undecided` assertion below is what guarantees that substitution exists.
 */
type PiiIndirectionVariantVerdict = "admits" | "refuses" | "inconclusive";

function probeVariant(
  eventType: string,
  category: string,
  payload: unknown,
): ReturnType<typeof SessionEventSchema.safeParse> {
  return SessionEventSchema.safeParse({
    id: nextEventId(),
    sessionId: SESSION,
    sequence: 0,
    occurredAt: "2026-08-30T12:00:00.000Z",
    category,
    type: eventType,
    actor: null,
    payload,
    version: ENVELOPE_VERSION,
  });
}

/**
 * Read a variant's verdict off two parses: the pair alone, and the empty
 * payload as its control.
 *
 * Both probes fail for almost every variant — one fixture payload cannot
 * satisfy 30 shapes — so the verdict is never "did it parse". It is what the
 * PAIR added relative to the control:
 *
 *   * an `unrecognized_keys` issue NAMING either member is the strict layer
 *     saying it does not know them — `refuses`;
 *   * no such issue, on a control that reached the payload's own members, is
 *     the strict layer taking them without comment — `admits`;
 *   * no such issue, on a control that never got past a union discriminator, is
 *     the probe learning nothing — `inconclusive`.
 */
function readPiiIndirectionVerdict(
  eventType: string,
  category: string,
): PiiIndirectionVariantVerdict {
  const withPair = probeVariant(eventType, category, {
    [PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: "0".repeat(64),
    [PII_PARTICIPANT_ID_PAYLOAD_KEY]: PARTICIPANT,
  });
  if (withPair.success) {
    return "admits";
  }
  const namesPair = withPair.error.issues.some(
    (issue) =>
      issue.code === "unrecognized_keys" &&
      issue.keys.some(
        (key) =>
          key === PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY || key === PII_PARTICIPANT_ID_PAYLOAD_KEY,
      ),
  );
  if (namesPair) {
    return "refuses";
  }
  const control = probeVariant(eventType, category, {});
  if (!control.success && control.error.issues.every((issue) => issue.code === "invalid_union")) {
    return "inconclusive";
  }
  return "admits";
}

/**
 * Whether the codec's CATEGORY guard answers for a row in `category`.
 *
 * The input is a PII-carrying row with no content partition, so refusal arm 4
 * cannot fire and arm 1's category test is reached first — it is the first arm
 * of the first refusal. An admitted category throws too, but from refusal 9
 * (the composed-variant parse, since one fixture payload cannot satisfy 30
 * variants), which is why the discriminator is the message and not the throw.
 *
 * The cast is the point of the arm: it hands the codec categories its own
 * `PiiEligibleCategory` input type forbids, which is exactly the runtime input
 * the guard exists to answer.
 */
async function codecRefusesCategory(eventType: string, category: string): Promise<boolean> {
  const row = {
    ...makePiiCarryingInput(),
    category,
    type: eventType,
  } as unknown as RawEventInput;
  try {
    await seal(row, new DeterministicPiiEncryptor());
    return false;
  } catch (error) {
    return error instanceof Error && /refuses category/.test(error.message);
  }
}

describe("the codec's refused categories and the contracts registration agree", () => {
  it("refuses exactly the categories whose registered variants refuse the PII pair", async () => {
    const codecRefused = new Set<string>();
    const contractsRefused = new Set<string>();
    const contractsAdmitted = new Set<string>();
    const categoriesSeen = new Set<string>();

    for (const eventType of SESSION_EVENT_TYPES) {
      const category = SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType);
      expect(category, `no category registered for ${eventType}`).toBeDefined();
      if (category === undefined) {
        continue;
      }
      categoriesSeen.add(category);

      const verdict = readPiiIndirectionVerdict(eventType, category);
      if (verdict === "refuses") {
        contractsRefused.add(category);
      } else if (verdict === "admits") {
        contractsAdmitted.add(category);
      }

      if (await codecRefusesCategory(eventType, category)) {
        codecRefused.add(category);
      }
    }

    // Every category must be DECIDED by at least one of its types. A category
    // whose every registered variant went inconclusive would drop out of both
    // sides of the equivalence below and pass by absence — the exact vacuity
    // this arm exists to rule out.
    const undecided = [...categoriesSeen].filter(
      (category) => !contractsRefused.has(category) && !contractsAdmitted.has(category),
    );
    expect(undecided).toEqual([]);

    // Non-vacuity in BOTH directions. An equivalence between two empty sets, or
    // between two sets that happen to be everything, would pass while proving
    // nothing.
    expect(contractsRefused.size).toBeGreaterThan(0);
    expect(contractsAdmitted.size).toBeGreaterThan(0);

    // The rule is per-category, so a category cannot land on both sides. If one
    // did, the equivalence below would be comparing sets that do not partition
    // and the failure it reported would name the wrong defect.
    expect([...contractsRefused].filter((category) => contractsAdmitted.has(category))).toEqual([]);

    expect([...codecRefused].sort()).toEqual([...contractsRefused].sort());
  });
});
