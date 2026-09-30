// The PII partition on the write path: what `writeEventWithPii` keeps out of the canonical bytes,
// what it hands the encryptor, and what it refuses.
//
//   1. Nothing from the PII partition reaches the canonical bytes, neither plaintext nor
//      ciphertext. Canonical bytes are reproducible from the stored row for as long as it exists,
//      so plaintext there would never be shredded.
//   2. Every refusal answerable from the input alone fires before the encrypt step, so a rejected
//      append spends no AEAD nonce; refusals that judge the encrypt's output fire after it.
//
import { blake3 } from "@noble/hashes/blake3.js";
import { EventEnvelopeVersionSchema, SessionIdSchema } from "@ai-sidekicks/contracts";
import type { EventEnvelopeVersion, SessionId } from "@ai-sidekicks/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { canonicalizeEvent, canonicalizeJson } from "../canonicalizer.js";
import { writeEventWithPii } from "../pii-indirection.js";
import type {
  PiiCarryingEventInput,
  PiiEncryptionRequest,
  PiiEncryptor,
  PiiEventWriteResult,
  PiiPayloadCiphertext,
} from "../pii-indirection.js";

// --------------------------------------------------------------------------
// Helpers.
// --------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --------------------------------------------------------------------------
// The test-only PII encryptor stub.
// --------------------------------------------------------------------------

/**
 * A 12-byte pseudo-nonce prefix, so the stub's output has the `iv || ciphertext || tag` shape of
 * the real codec without its properties.
 */
const TEST_NONCE_PREFIX: Uint8Array = utf8Encoder.encode("test-nonce--");

/**
 * The test-only PII encryptor.
 *
 * Not an AEAD. It is deterministic, so an assertion can name the expected bytes, and
 * `writeEventWithPii` stores whatever bytes it is handed. Seeding by user id and event id mirrors
 * the real codec's AAD binding: the ciphertext differs for every (user, event) pair.
 *
 * Call accounting is public because it proves ordering: after a guard that runs before the
 * encrypt step throws, `encryptCallCount` must still be 0.
 */
class DeterministicTestPiiEncryptor implements PiiEncryptor {
  #encryptCallCount = 0;
  #lastRequest: PiiEncryptionRequest | null = null;

  get encryptCallCount(): number {
    return this.#encryptCallCount;
  }

  get lastRequest(): PiiEncryptionRequest | null {
    return this.#lastRequest;
  }

  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array> {
    this.#encryptCallCount += 1;
    this.#lastRequest = request;
    return Promise.resolve(sealWithTestKeystream(request));
  }
}

function sealWithTestKeystream(request: PiiEncryptionRequest): Uint8Array {
  const associatedData: Uint8Array = utf8Encoder.encode(`${request.userId} ${request.eventId}`);
  const keystream: Uint8Array = blake3(associatedData, {
    dkLen: Math.max(1, request.plaintext.length),
  });
  const sealed = new Uint8Array(TEST_NONCE_PREFIX.length + request.plaintext.length);
  sealed.set(TEST_NONCE_PREFIX, 0);
  for (let index = 0; index < request.plaintext.length; index++) {
    sealed[TEST_NONCE_PREFIX.length + index] =
      (request.plaintext[index] ?? 0) ^ (keystream[index] ?? 0);
  }
  return sealed;
}

/** A stub that returns whatever the test tells it to, to inject a bad encryptor result. */
class FixedResultPiiEncryptor implements PiiEncryptor {
  #encryptCallCount = 0;
  readonly #result: unknown;

  constructor(result: unknown) {
    this.#result = result;
  }

  get encryptCallCount(): number {
    return this.#encryptCallCount;
  }

  encrypt(_request: PiiEncryptionRequest): Promise<Uint8Array> {
    this.#encryptCallCount += 1;
    // A value the declared type forbids: the bug `writeEventWithPii`'s result guard exists for,
    // reachable because the encryptor is injected.
    return Promise.resolve(this.#result as Uint8Array);
  }
}

/**
 * A stub that hands back one buffer to every caller and rewrites it afterwards. `PiiEncryptor`
 * fixes a return type, not the lifetime of the memory behind it, so a reusable scratch array
 * conforms. No in-repo implementation mutates a returned buffer; this tests what the contract
 * allows.
 */
class ScratchBufferPiiEncryptor implements PiiEncryptor {
  readonly #scratch: Uint8Array;

  constructor(byteLength: number) {
    this.#scratch = new Uint8Array(byteLength).fill(0xa5);
  }

  /** The array every call returns — the alias the codec must not carry forward. */
  get scratch(): Uint8Array {
    return this.#scratch;
  }

  /** Stands in for the next encryption writing through the same memory. */
  overwriteScratch(fillByte: number): void {
    this.#scratch.fill(fillByte);
  }

  encrypt(_request: PiiEncryptionRequest): Promise<Uint8Array> {
    return Promise.resolve(this.#scratch);
  }
}

// --------------------------------------------------------------------------
// Fixtures.
// --------------------------------------------------------------------------

const FIXTURE_SESSION_ID: SessionId = SessionIdSchema.parse("0192f3a4-5b6c-7d8e-9f01-234567890abc");
const FIXTURE_ENVELOPE_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");
const FIXTURE_EVENT_ID = "01960b3c-e1d0-7a41-b2c9-5f8e37d6a204";
const FIXTURE_USER_ID = "user-3f9a";
const FIXTURE_OCCURRED_AT = "2026-03-04T05:06:07.008Z";

/**
 * A string that appears nowhere except inside the PII partition: the leak detector. Composing the
 * stored envelope by spreading `input` instead of `input.payload` would put the whole partition
 * inside the canonical `payload`, and this sentinel catches it.
 */
const PII_PLAINTEXT_SENTINEL = "sentinel-plaintext-do-not-store-b7f2c1";
const PII_PLAINTEXT_SENTINEL_KEY = "nationalIdentityNumber";

/**
 * The one factory for every envelope this suite builds. `interactive_request` / `user.message`
 * carries a user's own content and has no registered payload variant, so the payload members are
 * admitted as a tolerant carrier.
 */
function buildPiiCarryingEventInput(
  overrides: Partial<PiiCarryingEventInput> = {},
): PiiCarryingEventInput {
  return {
    id: FIXTURE_EVENT_ID,
    sessionId: FIXTURE_SESSION_ID,
    sequence: 0,
    occurredAt: FIXTURE_OCCURRED_AT,
    category: "interactive_request",
    type: "user.message",
    actor: FIXTURE_USER_ID,
    payload: { exportFormat: "json", recordCount: 3 },
    correlationId: "correlation-9c2e",
    causationId: "causation-4b1d",
    version: FIXTURE_ENVELOPE_VERSION,
    piiUserId: FIXTURE_USER_ID,
    piiPayload: {
      displayName: "Ada Lovelace",
      emailAddress: "ada@example.invalid",
      [PII_PLAINTEXT_SENTINEL_KEY]: PII_PLAINTEXT_SENTINEL,
    },
    ...overrides,
  };
}

/**
 * `CANONICAL_JSON_MAX_DEPTH` from `canonicalizer.ts`, restated rather than imported: a shared
 * constant would agree by construction even after it drifted. The paired cases below (a payload at
 * this depth is admitted, one level past it is refused) are the drift guard.
 */
const CANONICAL_JSON_MAX_DEPTH = 64;

/**
 * Builds a `payload` whose deepest container sits at `canonicalDepth`, counted as
 * `canonicalizer.ts` counts: the projected envelope is depth 1, `payload` is depth 2, and each
 * nesting level adds one, so a flat payload is `canonicalDepth = 2`. Counting in the ceiling's
 * unit rather than in payload-local levels avoids an off-by-two that would turn the boundary
 * control into a refusal.
 */
function buildPayloadNestedToCanonicalDepth(canonicalDepth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {};
  for (let depth = canonicalDepth; depth > 2; depth--) {
    node = { nested: node };
  }
  return node;
}

/** Narrows a codec result to its PII partition, throwing when it has none. */
function piiPartitionOf(result: PiiEventWriteResult): {
  readonly ciphertext: Uint8Array;
  readonly userId: string;
} {
  if (result.piiPayload === undefined || result.piiUserId === undefined) {
    throw new Error(
      "the codec returned no PII partition for an input that carries one — every arm in this file writes a PII-carrying row",
    );
  }
  return { ciphertext: result.piiPayload, userId: result.piiUserId };
}

// ==========================================================================
// The canonical bytes carry nothing from the PII partition.
// ==========================================================================

describe("canonical bytes carry nothing from the PII partition", () => {
  let encryptor: DeterministicTestPiiEncryptor;

  beforeEach(() => {
    encryptor = new DeterministicTestPiiEncryptor();
  });

  it("leaks neither the PII plaintext nor the ciphertext into the canonical bytes", async () => {
    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput(),
      encryptor,
    );
    const canonicalText: string = utf8Decoder.decode(canonicalizeEvent(result.envelope));

    // The canonical bytes are the one place PII must never appear: they are reproducible from the
    // stored row, and shredding the PII column does not reach them.
    expect(canonicalText).not.toContain(PII_PLAINTEXT_SENTINEL);
    expect(canonicalText).not.toContain(PII_PLAINTEXT_SENTINEL_KEY);
    expect(canonicalText).not.toContain("Ada Lovelace");
    expect(canonicalText).not.toContain("ada@example.invalid");
    // Nor the ciphertext in its likeliest encoding: it would give an attacker a
    // length-and-structure oracle over the sealed data.
    expect(canonicalText).not.toContain(bytesToHex(piiPartitionOf(result).ciphertext));
    expect(canonicalText).not.toContain("piiPayload");
    expect(canonicalText).not.toContain("pii_payload");

    // `piiUserId` reaches the canonical bytes only if the stored envelope spreads `input` instead
    // of taking `input.payload`, which would carry `piiPayload` along too.
    expect(canonicalText).not.toContain("piiUserId");

    // The non-PII payload is canonical; without this the assertions above could pass on an empty
    // one.
    expect(canonicalText).toContain('"exportFormat":"json"');
  });

  it("binds the ciphertext to (user, event) and canonicalizes the partition once", async () => {
    const input: PiiCarryingEventInput = buildPiiCarryingEventInput();
    await writeEventWithPii(input, encryptor);

    // One encrypt per row, sealed for this (user, event) pair.
    expect(encryptor.encryptCallCount).toBe(1);
    expect(encryptor.lastRequest?.userId).toBe(FIXTURE_USER_ID);
    expect(encryptor.lastRequest?.eventId).toBe(FIXTURE_EVENT_ID);
    // The plaintext handed to the AEAD is the RFC 8785 serialization of the partition, as
    // `PiiEncryptionRequest.plaintext` fixes.
    expect(encryptor.lastRequest?.plaintext).toEqual(canonicalizeJson(input.piiPayload));
  });

  it("returns the PII owner's user id, on an event whose actor is not that owner", async () => {
    // The owner fills the `pii_user_id` column and is the user half of the AEAD's associated data,
    // which no decrypt can rebuild from the ciphertext. `actor` is no substitute (it may be an
    // agent id or `null`), so this case diverges from the default fixture, where the two coincide.
    const input: PiiCarryingEventInput = buildPiiCarryingEventInput({ actor: null });
    const result: PiiEventWriteResult = await writeEventWithPii(input, encryptor);

    expect(result.piiUserId).toBe(FIXTURE_USER_ID);
    // Confirms the divergence: with equal ids the assertion above would also pass on an
    // implementation that returned `actor`.
    expect(result.envelope.actor).toBeNull();
    // It is the value bound into the AEAD's associated data, not a second reading of the input.
    expect(result.piiUserId).toBe(encryptor.lastRequest?.userId);
  });

  it("copies the encryptor's ciphertext, so a reused scratch buffer cannot change the stored bytes", async () => {
    // The interface fixes a return type, not a buffer lifetime, so an implementation may hand back
    // scratch memory and overwrite it on its next call. If the returned array were the encryptor's
    // own, a later write would change the bytes persisted into `pii_payload`.
    const encryptorWithScratch = new ScratchBufferPiiEncryptor(48);
    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput(),
      encryptorWithScratch,
    );

    encryptorWithScratch.overwriteScratch(0x5a);

    // The caller's bytes are not the encryptor's array, and the overwrite did not reach them.
    expect(result.piiPayload).not.toBe(encryptorWithScratch.scratch);
    expect(result.piiPayload).not.toEqual(encryptorWithScratch.scratch);
    // A copy, not a re-encryption: the bytes are the ones the encryptor returned.
    expect(result.piiPayload).toEqual(new Uint8Array(48).fill(0xa5));
  });
});

// ==========================================================================
// Refusals on the PII write path. The input-answerable ones precede the
// encrypt; the ones that judge the encrypt's own output follow it.
// ==========================================================================

describe("refusals on the PII write path", () => {
  it("refuses a non-canonical occurredAt before the encrypt step", async () => {
    // `normalizeOccurredAt` runs ahead of the encrypt. Sub-millisecond precision cannot be folded
    // away: the canonical form cannot represent it, and truncating would store a different
    // timestamp.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ occurredAt: "2026-03-04T05:06:07.0081Z" }),
        encryptor,
      ),
    ).rejects.toThrow(/sub-millisecond precision/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses an event_maintenance event before the encrypt step", async () => {
    // `event_maintenance` rows are never purged, so a PII payload on one would be permanent.
    // `piiPayload?: never` is only the compile-time half; the runtime check catches a value that
    // arrived across a serialization boundary or an `as` cast.
    const encryptor = new DeterministicTestPiiEncryptor();
    const refusedCategoryInput = {
      ...buildPiiCarryingEventInput(),
      category: "event_maintenance",
    } as unknown as PiiCarryingEventInput;

    await expect(writeEventWithPii(refusedCategoryInput, encryptor)).rejects.toThrow(
      /refuses category "event_maintenance"/,
    );
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses an empty ciphertext rather than storing nothing", async () => {
    // This guard cannot precede the encrypt step: it judges the encryptor's output. No AEAD emits a
    // zero-length output, so the injected implementation returned nothing while claiming success.
    const encryptor = new FixedResultPiiEncryptor(new Uint8Array(0));

    await expect(writeEventWithPii(buildPiiCarryingEventInput(), encryptor)).rejects.toThrow(
      /must return non-empty Uint8Array ciphertext/,
    );
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses a non-Uint8Array ciphertext rather than storing coerced bytes", async () => {
    // A hex string is what a codec round-tripping through a text column or JSON boundary hands
    // back; without the guard the byte-array constructor would coerce it and the column would hold
    // bytes the encryptor never produced.
    const encryptor = new FixedResultPiiEncryptor("6465616462656566");

    await expect(writeEventWithPii(buildPiiCarryingEventInput(), encryptor)).rejects.toThrow(
      /received a non-Uint8Array value of type string/,
    );
    // This refusal legitimately costs a nonce: there is no value to judge until the encryptor ran.
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses a NaN sequence before the encrypt step", async () => {
    // The `Number.isSafeInteger` predicate `canonicalizeEvent` runs, hoisted ahead of the encrypt.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(buildPiiCarryingEventInput({ sequence: Number.NaN }), encryptor),
    ).rejects.toThrow(/writeEventWithPii refuses sequence NaN/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a sequence past the safe-integer ceiling before the encrypt step", async () => {
    // The collision the guard exists for: `9007199254740993` collapses onto `9007199254740992`, so
    // two events would canonicalize to identical bytes and share a replay key. The value in the
    // message is already the collapsed one.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ sequence: Number.MAX_SAFE_INTEGER + 2 }),
        encryptor,
      ),
    ).rejects.toThrow(/writeEventWithPii refuses sequence 9007199254740992/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("reports the SEQUENCE refusal for an input defective in both sequence and occurredAt", async () => {
    // Refusal order is observable: the sequence guard runs ahead of `normalizeOccurredAt`, as in
    // `canonicalizeEvent`, so the PII and plain paths answer alike for one doubly-defective row.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({
          sequence: Number.NaN,
          occurredAt: "2026-03-04T05:06:07.0081Z",
        }),
        encryptor,
      ),
    ).rejects.toThrow(/writeEventWithPii refuses sequence NaN/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("still admits a valid input at the sequence ceiling (over-refusal control)", async () => {
    // Control for the two cases above, which a guard refusing everything would satisfy:
    // `Number.MAX_SAFE_INTEGER` must pass and reach the encryptor once.
    const encryptor = new DeterministicTestPiiEncryptor();

    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput({ sequence: Number.MAX_SAFE_INTEGER }),
      encryptor,
    );

    expect(result.envelope.sequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses an empty piiUserId BEFORE spending the nonce", async () => {
    // No later stage re-checks this value and it never reaches the canonical bytes, so nothing else
    // would catch it: the row would hold PII sealed against an AAD no decrypt can rebuild, under an
    // owner column naming nobody. An empty string satisfies `PiiCarryingEventInput` yet names no
    // key holder.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(buildPiiCarryingEventInput({ piiUserId: "" }), encryptor),
    ).rejects.toThrow(/requires a non-empty piiUserId/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a non-string piiUserId before spending the nonce", async () => {
    // Reachable only through a cast or an untyped boundary, since the input type declares a
    // required `string`. The message reports a type, never the value.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ piiUserId: null as unknown as string }),
        encryptor,
      ),
    ).rejects.toThrow(/received a non-string value of type object/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("still admits an unusual but well-shaped piiUserId (over-refusal control)", async () => {
    // Control for the two cases above: a one-character id passes, because this guard checks shape
    // only. Whether `user_keys` holds a row for the id is the encryptor's verdict to give.
    const encryptor = new DeterministicTestPiiEncryptor();

    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput({ piiUserId: "x" }),
      encryptor,
    );

    expect(encryptor.encryptCallCount).toBe(1);
    expect(encryptor.lastRequest?.userId).toBe("x");
    expect(result.piiUserId).toBe("x");
  });

  it("refuses an over-deep payload only AFTER the encrypt, and is off by one from a standalone walk", async () => {
    // `input.payload`'s nesting is answerable from the input, yet it is refused after the encrypt:
    // the canonicalizer exports no depth-only checker, so a pre-check would need a second full
    // canonicalization or a duplicate walk with a depth-offset correction. The offset is real: the
    // first assertion shows this payload canonicalizing cleanly on its own, because a standalone
    // walk seeds at the payload while `canonicalizeEvent` seeds at the envelope, one level up. A
    // pre-check spelled `canonicalizeJson(input.payload)` would admit this input before the
    // encrypt. The `encryptCallCount` assertion fails if this refusal is hoisted.
    const boundaryPayload: Record<string, unknown> = buildPayloadNestedToCanonicalDepth(
      CANONICAL_JSON_MAX_DEPTH + 1,
    );
    expect(() => canonicalizeJson(boundaryPayload)).not.toThrow();
    // The offset is exactly one: one level deeper and the standalone walk refuses too. Without this
    // the assertion above would also pass against a depth guard that never fired.
    expect(() =>
      canonicalizeJson(buildPayloadNestedToCanonicalDepth(CANONICAL_JSON_MAX_DEPTH + 2)),
    ).toThrow(
      new RegExp(`nests containers deeper than ${String(CANONICAL_JSON_MAX_DEPTH)} levels`),
    );

    const encryptor = new DeterministicTestPiiEncryptor();
    await expect(
      writeEventWithPii(buildPiiCarryingEventInput({ payload: boundaryPayload }), encryptor),
    ).rejects.toThrow(
      new RegExp(`nests containers deeper than ${String(CANONICAL_JSON_MAX_DEPTH)} levels`),
    );
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("admits a payload AT the depth ceiling (over-refusal control)", async () => {
    // The accepting side of the boundary above. Moving `CANONICAL_JSON_MAX_DEPTH` in
    // `canonicalizer.ts` without the local restatement fails exactly one of this pair.
    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput({
        payload: buildPayloadNestedToCanonicalDepth(CANONICAL_JSON_MAX_DEPTH),
      }),
      new DeterministicTestPiiEncryptor(),
    );

    expect(result.piiPayload).toBeInstanceOf(Uint8Array);
  });

  it("refuses a NaN inside payload only AFTER the encrypt, from the library's own guard", async () => {
    // A second post-encrypt refusal, from a different layer: this throw is `canonicalize@3.0.0`'s,
    // with its bare wording. `NaN` is a scalar, so the depth walk never queues it; only
    // serialization catches it, and that runs over the stored envelope, composed after the encrypt.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ payload: { exportFormat: "json", ratio: Number.NaN } }),
        encryptor,
      ),
    ).rejects.toThrow(/NaN is not allowed/);
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses a NaN inside the PII partition BEFORE the encrypt (the mirror control)", async () => {
    // The mirror of the case above: the PII partition is serialized before the encrypt, so the same
    // defect one member over is refused for free.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(
        buildPiiCarryingEventInput({ piiPayload: { displayName: "Ada", ratio: Number.NaN } }),
        encryptor,
      ),
    ).rejects.toThrow(/NaN is not allowed/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("keeps the ciphertext brand a COMPILE error — a bare array is not ciphertext", () => {
    // An unused `@ts-expect-error` is itself a TS2578 error, so `tsc -p tsconfig.test.json` fails
    // if the brand ever gains an exported constructor. No `as never` / `as any` on the assignment,
    // which would silence the error this case exists to surface.
    const bareCiphertext: Uint8Array = new Uint8Array([1, 2, 3]);

    // @ts-expect-error a bare Uint8Array is not PiiPayloadCiphertext — the encrypt stage mints that brand at exactly one site inside pii-indirection.ts
    const forgedCiphertext: PiiPayloadCiphertext = bareCiphertext;

    // A runtime read keeps the binding used for lint; the compile is the load-bearing check.
    expect(forgedCiphertext.length).toBe(3);
  });
});
