// The PII write path keeps the partition's plaintext and ciphertext out of the canonical bytes,
// stores the owner and an owned copy of the ciphertext, and refuses PII it could never shred.

import { EventEnvelopeVersionSchema, SessionIdSchema } from "@ai-sidekicks/contracts";
import type { EventEnvelopeVersion, SessionId } from "@ai-sidekicks/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { canonicalizeEvent } from "../canonicalizer.js";
import { writeEventWithPii } from "../pii-indirection.js";
import type {
  PiiCarryingEventInput,
  PiiEncryptionRequest,
  PiiEncryptor,
  PiiEventWriteResult,
  PiiPayloadCiphertext,
} from "../pii-indirection.js";
import { DeterministicPiiEncryptor, bytesToHex } from "./event-test-fixtures.js";

// --------------------------------------------------------------------------
// Helpers.
// --------------------------------------------------------------------------

const utf8Decoder = new TextDecoder();

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
  let encryptor: DeterministicPiiEncryptor;

  beforeEach(() => {
    encryptor = new DeterministicPiiEncryptor();
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
  it("refuses an event_maintenance event before the encrypt step", async () => {
    // `event_maintenance` rows are never purged, so a PII payload on one would be permanent.
    // `piiPayload?: never` is only the compile-time half; the runtime check catches a value that
    // arrived across a serialization boundary or an `as` cast.
    const encryptor = new DeterministicPiiEncryptor();
    const refusedCategoryInput = {
      ...buildPiiCarryingEventInput(),
      category: "event_maintenance",
    } as unknown as PiiCarryingEventInput;

    await expect(writeEventWithPii(refusedCategoryInput, encryptor)).rejects.toThrow(
      /refuses category "event_maintenance"/,
    );
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses an encryptor result that is not non-empty bytes rather than storing it", async () => {
    // This guard cannot precede the encrypt step: it judges the encryptor's output. No AEAD emits a
    // zero-length output, so an empty result means the injected implementation returned nothing
    // while claiming success.
    const emptyEncryptor = new FixedResultPiiEncryptor(new Uint8Array(0));

    await expect(writeEventWithPii(buildPiiCarryingEventInput(), emptyEncryptor)).rejects.toThrow(
      /must return non-empty Uint8Array ciphertext/,
    );
    expect(emptyEncryptor.encryptCallCount).toBe(1);

    // A hex string is what a codec round-tripping through a text column or JSON boundary hands
    // back; without the guard the byte-array constructor would coerce it and the column would hold
    // bytes the encryptor never produced.
    const hexEncryptor = new FixedResultPiiEncryptor("6465616462656566");

    await expect(writeEventWithPii(buildPiiCarryingEventInput(), hexEncryptor)).rejects.toThrow(
      /received a non-Uint8Array value of type string/,
    );
    expect(hexEncryptor.encryptCallCount).toBe(1);
  });

  it("refuses an empty piiUserId BEFORE spending the nonce", async () => {
    // No later stage re-checks this value and it never reaches the canonical bytes, so nothing else
    // would catch it: the row would hold PII sealed against an AAD no decrypt can rebuild, under an
    // owner column naming nobody. An empty string satisfies `PiiCarryingEventInput` yet names no
    // key holder.
    const encryptor = new DeterministicPiiEncryptor();

    await expect(
      writeEventWithPii(buildPiiCarryingEventInput({ piiUserId: "" }), encryptor),
    ).rejects.toThrow(/requires a non-empty piiUserId/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("keeps the ciphertext brand a COMPILE error — a bare array is not ciphertext", () => {
    // An unused `@ts-expect-error` is itself a TS2578 error, so `tsc -p tsconfig.test.json` fails
    // if the brand ever gains an exported constructor. No `as never` / `as any` on the assignment,
    // which would silence the error this case exists to surface.
    const bareCiphertext: Uint8Array = new Uint8Array([1, 2, 3]);

    // Only the encrypt stage in pii-indirection.ts mints the ciphertext brand.
    // @ts-expect-error a bare Uint8Array is not PiiPayloadCiphertext
    const forgedCiphertext: PiiPayloadCiphertext = bareCiphertext;

    // A runtime read keeps the binding used for lint; the compile is the load-bearing check.
    expect(forgedCiphertext.length).toBe(3);
  });
});
