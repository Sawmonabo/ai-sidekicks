// The PII partition on the write path: what `writeEventWithPii` keeps out of
// the canonical bytes, what it hands the encryptor, and what it refuses.
//
// Two properties carry the file:
//
//   1. Nothing from the PII partition reaches the canonical bytes — neither the
//      plaintext nor the ciphertext. Canonical bytes are reproducible from the
//      stored row for as long as it exists, so plaintext that lands there is
//      never shredded.
//   2. Every refusal answerable from the input alone fires BEFORE the encrypt
//      step, so a rejected append spends no AEAD nonce; the refusals that
//      judge a value the encrypt produces fire after it, and say so.
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
 * A 12-byte pseudo-nonce prefix, so the stub's output carries the `iv ||
 * ciphertext || tag` SHAPE fixes for the real codec even though it has none of
 * its properties.
 */
const TEST_NONCE_PREFIX: Uint8Array = utf8Encoder.encode("test-nonce--");

/**
 * The test-only PII encryptor.
 *
 * NOT AN AEAD, AND THE DIVERGENCES ARE DELIBERATE. Determinism is bought on
 * purpose: it makes every ciphertext in this file reproducible from the
 * fixture, so an assertion can name the expected bytes instead of re-deriving
 * them from whatever the encryptor happened to return. Nothing under test
 * depends on the cipher being real — `writeEventWithPii` stores whatever bytes
 * it is handed and asserts nothing about their width, as an interface that does
 * not fix an AEAD requires.
 *
 * The `userId || eventId` seeding mirrors the real codec's AAD binding
 * in the one observable way a stub can: a ciphertext produced for one
 * (user, event) pair differs bytewise from every other pair's.
 *
 * Call accounting is public because it carries an ORDERING proof: the guards
 * `writeEventWithPii` runs BEFORE the irreversible encrypt step are exactly the
 * ones for which `encryptCallCount` must still be 0 after the throw.
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

/** A stub that returns whatever the test tells it to — bad-injection driver. */
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
    // The whole point is to return a value the declared type forbids — that is
    // the injection bug `writeEventWithPii`'s result guard exists for, and it is
    // reachable in production because the implementation crosses an injection
    // boundary this package neither owns nor imports.
    return Promise.resolve(this.#result as Uint8Array);
  }
}

/**
 * A stub that hands back ONE buffer to every caller and rewrites it afterwards —
 * a reusable-scratch implementation the interface permits.
 *
 * `PiiEncryptor` fixes a return TYPE and says nothing about the lifetime of the
 * memory behind it, so an implementation that keeps a scratch array and
 * overwrites it on the next encrypt conforms to the interface completely. This
 * stub exists because the hazard is otherwise untestable: it is a statement about
 * what the CONTRACT allows, not about what any shipped code does.
 *
 * NO IN-REPO IMPLEMENTATION MUTATES A RETURNED BUFFER TODAY, and saying so is
 * part of the test's honesty.
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

  /** Stands in for the NEXT encryption writing through the same memory. */
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
 * A string that appears NOWHERE except inside the PII partition.
 *
 * It is the leak detector: the canonical-bytes assertions below check that
 * neither this value nor the member name carrying it survives into the
 * canonical bytes. A single-token regression in composing the stored envelope
 * — spreading `input` instead of `input.payload` — puts the whole partition
 * inside `payload`, which IS canonical, and this sentinel is what catches it.
 */
const PII_PLAINTEXT_SENTINEL = "sentinel-plaintext-do-not-store-b7f2c1";
const PII_PLAINTEXT_SENTINEL_KEY = "nationalIdentityNumber";

/**
 * ONE factory for every envelope this suite builds.
 *
 * `interactive_request` / `user.message` is a census pairing that carries a
 * user's own content, and the strict layer registers no payload variant for
 * it, so the fixture's payload members are admitted as a tolerant carrier.
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
 * `canonicalizer.ts`'s `CANONICAL_JSON_MAX_DEPTH`, RESTATED RATHER THAN
 * IMPORTED — and not only because the const is module-private there. Same
 * argument that module makes for not importing `EVENT_ENVELOPE_SEQUENCE_MAX`:
 * a shared const would make the two surfaces agree BY CONSTRUCTION, including
 * agreeing on a value that drifted. The paired cases below — a payload AT this
 * depth is admitted, one level past it is refused — are the drift guard a
 * shared const could not be.
 */
const CANONICAL_JSON_MAX_DEPTH = 64;

/**
 * Builds a `payload` whose DEEPEST container sits at `canonicalDepth`, counted
 * exactly the way `canonicalizer.ts` counts: the projected envelope
 * `canonicalizeEvent` hands the serializer is depth 1, `payload` itself is
 * depth 2, and each further nesting level adds one. So a flat payload is
 * `canonicalDepth = 2`, and the payload tree contributes `canonicalDepth - 2`
 * levels below itself.
 *
 * Counting in the CEILING'S OWN UNIT rather than in payload-local levels is
 * deliberate: the off-by-two between the two framings is exactly the mistake
 * that would turn the boundary control below into a second refusal.
 */
function buildPayloadNestedToCanonicalDepth(canonicalDepth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {};
  for (let depth = canonicalDepth; depth > 2; depth--) {
    node = { nested: node };
  }
  return node;
}

/**
 * Narrows a codec result to its PII partition, and throws when the codec
 * returned none, since every arm in this file writes a PII-carrying row.
 */
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

    // The canonical bytes are the ONE place PII must never appear: they are
    // reproducible from the stored row for as long as it exists, and no
    // shredding of the PII column reaches them.
    expect(canonicalText).not.toContain(PII_PLAINTEXT_SENTINEL);
    expect(canonicalText).not.toContain(PII_PLAINTEXT_SENTINEL_KEY);
    expect(canonicalText).not.toContain("Ada Lovelace");
    expect(canonicalText).not.toContain("ada@example.invalid");
    // Nor the ciphertext, in the encoding it would most plausibly take.
    // Ciphertext in the canonical bytes would hand an attacker a
    // length-and-structure oracle over the sealed data.
    expect(canonicalText).not.toContain(bytesToHex(piiPartitionOf(result).ciphertext));
    expect(canonicalText).not.toContain("piiPayload");
    expect(canonicalText).not.toContain("pii_payload");

    // `piiUserId` is `PiiCarryingEventInput`'s member name, and it can only
    // reach the canonical bytes if the stored envelope spreads `input` instead
    // of taking `input.payload` — the single-token regression that would carry
    // `piiPayload` along with it.
    expect(canonicalText).not.toContain("piiUserId");

    // The non-PII payload partition IS canonical — without this the assertions
    // above could pass on an empty payload.
    expect(canonicalText).toContain('"exportFormat":"json"');
  });

  it("binds the ciphertext to (user, event) and canonicalizes the partition once", async () => {
    const input: PiiCarryingEventInput = buildPiiCarryingEventInput();
    await writeEventWithPii(input, encryptor);

    // Exactly one encrypt per row, so the ciphertext heading for the column is
    // the one sealed for this (user, event) pair.
    expect(encryptor.encryptCallCount).toBe(1);
    expect(encryptor.lastRequest?.userId).toBe(FIXTURE_USER_ID);
    expect(encryptor.lastRequest?.eventId).toBe(FIXTURE_EVENT_ID);
    // The plaintext handed to the AEAD is the RFC 8785 serialization of the
    // partition, which is the convention `PiiEncryptionRequest.plaintext` fixes
    // for the eventual decrypt counterpart.
    expect(encryptor.lastRequest?.plaintext).toEqual(canonicalizeJson(input.piiPayload));
  });

  it("returns the PII owner's user id, on an event whose actor is not that owner", async () => {
    // The owner fills the `pii_user_id` column and is the user half of the
    // AEAD's associated data, which no decrypt can rebuild from the ciphertext.
    //
    // `actor` IS NOT A SUBSTITUTE, which is why this case is built on the
    // divergence rather than on the default fixture where the two coincide.
    // `PiiEncryptionRequest.userId` documents that `actor` may be an agent id
    // or `null`; here it is `null`, so an implementation that took the owner
    // from `actor` would record no owner at all.
    const input: PiiCarryingEventInput = buildPiiCarryingEventInput({ actor: null });
    const result: PiiEventWriteResult = await writeEventWithPii(input, encryptor);

    expect(result.piiUserId).toBe(FIXTURE_USER_ID);
    // The divergence is real on this fixture and not incidental: without this,
    // the assertion above would also pass on an implementation that returned
    // `actor`, since the default fixture sets both members to the same id.
    expect(result.envelope.actor).toBeNull();
    // And it is the value that was actually bound into the AEAD's associated
    // data, not a second reading of the input taken after the encrypt.
    expect(result.piiUserId).toBe(encryptor.lastRequest?.userId);
  });

  it("copies the encryptor's ciphertext, so a reused scratch buffer cannot change the stored bytes", async () => {
    // Fixes a return TYPE and no buffer lifetime, so an implementation may hand
    // back scratch memory and overwrite it on its next call. If the returned
    // array were the encryptor's own, a later write through it would leave the
    // caller persisting different bytes into `pii_payload` than the ones sealed
    // for this row.
    const encryptorWithScratch = new ScratchBufferPiiEncryptor(48);
    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput(),
      encryptorWithScratch,
    );

    encryptorWithScratch.overwriteScratch(0x5a);

    // Ownership is stated directly: the caller's bytes are not the encryptor's
    // array, and the overwrite did not reach them.
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
    // `normalizeOccurredAt` runs ahead of the encrypt call for the same reason.
    // Sub-millisecond precision is the refusal that cannot be folded away: the
    // canonical form cannot represent it, and truncating would store a
    // timestamp other than the recorded one.
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
    // `event_maintenance` rows are never purged, so a PII payload attached to
    // one would be permanent. The compile-time half
    // (`piiPayload?: never`) is only one half; the runtime half catches a value
    // that arrived across a serialization boundary or an `as` cast, which is the
    // only way this call can be made at all.
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
    // The one guard that CANNOT precede the encrypt step — it judges a value
    // that does not exist until the encryptor has run. No AEAD emits a
    // zero-length output, so this means the injected implementation returned
    // nothing while claiming success.
    const encryptor = new FixedResultPiiEncryptor(new Uint8Array(0));

    await expect(writeEventWithPii(buildPiiCarryingEventInput(), encryptor)).rejects.toThrow(
      /must return non-empty Uint8Array ciphertext/,
    );
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses a non-Uint8Array ciphertext rather than storing coerced bytes", async () => {
    // A hex STRING is the realistic shape of this bug — it is what a codec
    // round-tripping through a text column or a JSON boundary hands back — and
    // it is silent without the guard: the byte-array constructor would coerce
    // it, and the column would hold bytes the encryptor never produced.
    const encryptor = new FixedResultPiiEncryptor("6465616462656566");

    await expect(writeEventWithPii(buildPiiCarryingEventInput(), encryptor)).rejects.toThrow(
      /received a non-Uint8Array value of type string/,
    );
    // The OTHER direction of the ordering contract: this refusal legitimately
    // costs a nonce, because there is no value to judge until the encryptor has
    // run. Pinned as 1 rather than left unasserted so the encrypt-then-throw
    // class is a documented member of the contract and not an omission.
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses a NaN sequence before the encrypt step", async () => {
    // The same `Number.isSafeInteger` predicate `canonicalizeEvent` runs, hoisted
    // ahead of the encrypt; it is total, so the early copy cannot disagree with
    // the late one — `NaN` is refused here rather than one stage past the point
    // where the nonce is gone.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(buildPiiCarryingEventInput({ sequence: Number.NaN }), encryptor),
    ).rejects.toThrow(/writeEventWithPii refuses sequence NaN/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a sequence past the safe-integer ceiling before the encrypt step", async () => {
    // The collision case the guard actually exists for, as distinct from `NaN`:
    // `9007199254740993` collapses onto `9007199254740992`, so two different
    // events would canonicalize to identical bytes and share a replay key. The
    // interpolated value in the message is already the COLLAPSED one, which is
    // the failure made visible rather than a reporting defect.
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
    // Refusal order is observable, and the hoisted sequence guard is placed
    // ahead of `normalizeOccurredAt` on purpose: `canonicalizeEvent`'s own
    // REFUSAL ORDER note fixes that precedence, so the PII write path and the
    // plain one must not answer differently for one doubly-defective row.
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
    // THE CONTROL FOR THE TWO CASES ABOVE. A guard that refused everything would
    // satisfy them both, so the boundary is pinned from the accepting side too:
    // `Number.MAX_SAFE_INTEGER` is representable, must pass, and must reach the
    // encryptor exactly once.
    const encryptor = new DeterministicTestPiiEncryptor();

    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput({ sequence: Number.MAX_SAFE_INTEGER }),
      encryptor,
    );

    expect(result.envelope.sequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(encryptor.encryptCallCount).toBe(1);
  });

  it("refuses an empty piiUserId BEFORE spending the nonce", async () => {
    // REFUSAL 5, and the only guard on this path that fronts nothing: no later
    // stage re-checks this value, and it never reaches the canonical bytes. So
    // the failure it refuses is invisible to every other check here — the row
    // would hold PII sealed against an AAD no decrypt can rebuild, under an
    // owner column that names nobody.
    //
    // An EMPTY string is the case with no type-system defense at all: it
    // satisfies `PiiCarryingEventInput` completely and names no key holder.
    const encryptor = new DeterministicTestPiiEncryptor();

    await expect(
      writeEventWithPii(buildPiiCarryingEventInput({ piiUserId: "" }), encryptor),
    ).rejects.toThrow(/requires a non-empty piiUserId/);
    expect(encryptor.encryptCallCount).toBe(0);
  });

  it("refuses a non-string piiUserId before spending the nonce", async () => {
    // The other half of the predicate, reachable only through a cast or an
    // untyped boundary, since the input type declares the member a required
    // `string`. The message reports a TYPE and never the
    // value.
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
    // THE CONTROL FOR THE TWO CASES ABOVE, and it discriminates more than a
    // refuses-everything guard: a one-character id passes, because refusal 5 is
    // a SHAPE check and nothing more. Whether `user_keys` actually holds
    // a row for an id is answerable only across inside a module this one
    // neither owns nor imports — a well-shaped id naming no key holder is the
    // encryptor's verdict to give, not this guard's.
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
    // THE NARROWED HALF OF THE ORDERING CONTRACT, pinned rather than left as
    // prose, together with the discriminator that decided the narrowing.
    //
    // `input.payload`'s nesting IS answerable from the input, and it is refused
    // late anyway. The canonicalizer exports no depth-only checker, so a pre-check would be
    // either a second full canonicalization of the row or a duplicate of the
    // walk carrying a depth-offset correction — and the offset is real: the
    // first assertion below shows this payload canonicalizing CLEANLY on its
    // own, because a standalone walk seeds at the payload while
    // `canonicalizeEvent` seeds at the envelope, one level up. A pre-check
    // spelled `canonicalizeJson(input.payload)` would therefore ADMIT this
    // input pre-encrypt and let the real guard refuse it post-encrypt, making
    // the ordering claim false for exactly this row.
    //
    // The `encryptCallCount` assertion is what keeps the docstring's account of
    // the refusals behind the encrypt honest: hoist this refusal and the
    // expectation fails, so the docstring gets revisited with the code.
    const boundaryPayload: Record<string, unknown> = buildPayloadNestedToCanonicalDepth(
      CANONICAL_JSON_MAX_DEPTH + 1,
    );
    expect(() => canonicalizeJson(boundaryPayload)).not.toThrow();
    // ...and the offset is EXACTLY one, not merely non-zero: one level deeper
    // and the standalone walk refuses too. Without this the assertion above
    // would also pass against a depth guard that never fired at all.
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
    // The accepting side of the boundary above: one level shallower passes the
    // write path, so that case is a boundary rather than "deep payloads are
    // rejected". Move `CANONICAL_JSON_MAX_DEPTH` in `canonicalizer.ts` without
    // touching the local restatement and exactly one of this pair fails.
    const result: PiiEventWriteResult = await writeEventWithPii(
      buildPiiCarryingEventInput({
        payload: buildPayloadNestedToCanonicalDepth(CANONICAL_JSON_MAX_DEPTH),
      }),
      new DeterministicTestPiiEncryptor(),
    );

    expect(result.piiPayload).toBeInstanceOf(Uint8Array);
  });

  it("refuses a NaN inside payload only AFTER the encrypt, from the library's own guard", async () => {
    // The second member of the post-encrypt class, and a different layer from
    // the depth ceiling: this throw is `canonicalize@3.0.0`'s, with its bare
    // wording. `NaN` is a SCALAR, so the depth walk never queues it and no
    // depth pre-check would catch it either — only serialization does, and it
    // runs over the stored envelope, which is composed after the encrypt.
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
    // The mirror of the case above, and what makes it a statement about WHERE
    // the value sits rather than about `NaN`: the PII partition is serialized
    // ahead of the encrypt, so the identical defect one member over is refused
    // for free.
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
    // Self-verifying: an UNUSED `@ts-expect-error` is itself a TS2578 error, so
    // if the brand ever gained an exported constructor — or an implicit-any
    // escape hatch — the `tsc -p tsconfig.test.json` pass fails. No `as never` /
    // `as any` is used on the branded assignment itself: that would silence the
    // very error the case exists to surface.
    const bareCiphertext: Uint8Array = new Uint8Array([1, 2, 3]);

    // @ts-expect-error a bare Uint8Array is not PiiPayloadCiphertext — the encrypt stage mints that brand at exactly one site inside pii-indirection.ts
    const forgedCiphertext: PiiPayloadCiphertext = bareCiphertext;

    // A runtime read keeps the binding used for lint and anchors the type proof
    // to an executing assertion; the load-bearing check is the compile.
    expect(forgedCiphertext.length).toBe(3);
  });
});
