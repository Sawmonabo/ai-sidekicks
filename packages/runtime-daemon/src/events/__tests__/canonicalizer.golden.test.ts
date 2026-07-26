// Golden-vector suite for the RFC 8785 JCS canonicalizer (Plan-006 T2.3).
//
// WHY GOLDEN VECTORS AND NOT ROUND-TRIP TESTS. The canonical bytes this module
// produces are the input to every `row_hash` and `daemon_signature` on disk
// (`Spec-006 §Canonical Serialization Rules`), so the property that matters is
// not "canonicalization is self-consistent" — it is "these exact bytes, today
// and after every future refactor and dependency bump" (I-006-2-03). A
// self-consistent implementation that changed one byte would invalidate the
// whole chain silently. Hence inline hex fixtures (the crypto-paseto
// convention) and RFC-sourced expected values rather than values recomputed
// from the code under test.
//
// PROVENANCE OF THE RFC VECTORS. All three RFC 8785 vector sets are transcribed
// from the published RFC, NOT from this implementation's output:
//   • RFC 8785 §3.2.2 sample document → §3.2.4 expected UTF-8 bytes.
//   • RFC 8785 §3.2.3 property-sorting test data and its expected order.
//   • RFC 8785 Appendix B, Table 1 — "ECMAScript-Compatible JSON Number
//     Serialization Samples", 26 rows.
//
// NOTE ON "APPENDIX A". Plan-006's T2.3 row and the header of `canonicalizer.ts`
// both call these "RFC 8785 Appendix-A vectors". That is a mis-citation:
// Appendix A of RFC 8785 is "ECMAScript Sample Canonicalizer" (illustrative
// JavaScript source, no vectors), and the number-serialization vectors live in
// Appendix B, Table 1. This suite cites Appendix B, which is where the data
// actually is. Flagged for a plan/comment true-up rather than silently
// propagated.
//
// Refs: `Spec-006 §Canonical Serialization Rules`, `Spec-006 §Integrity Protocol`.
import {
  EventEnvelopeSchema,
  EventEnvelopeVersionSchema,
  SessionIdSchema,
} from "@ai-sidekicks/contracts";
import type { EventEnvelope, EventEnvelopeVersion, SessionId } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";
import { canonicalizeEvent, canonicalizeJson, normalizeOccurredAt } from "../canonicalizer.js";

// --------------------------------------------------------------------------
// Helpers — deliberately hand-rolled rather than imported from a byte-utility
// library, so a library bump can never move the expected side of an assertion
// at the same time as it moves the produced side.
// --------------------------------------------------------------------------

/** Parses grouped lowercase hex, ignoring whitespace so fixtures can keep the RFC's own line layout. */
function hexToBytes(groupedHex: string): Uint8Array {
  const compactHex = groupedHex.replace(/\s+/g, "");
  const bytes = new Uint8Array(compactHex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(compactHex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Renders bytes as continuous lowercase hex — used on the PRODUCED side so failures diff as text. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Reconstructs an IEEE 754 binary64 value from the big-endian hex Appendix B tabulates. */
function ieee754HexToNumber(ieee754Hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  for (let byteIndex = 0; byteIndex < 8; byteIndex++) {
    view.setUint8(
      byteIndex,
      Number.parseInt(ieee754Hex.slice(byteIndex * 2, byteIndex * 2 + 2), 16),
    );
  }
  return view.getFloat64(0);
}

/** Captures the message of the error a thunk throws, or fails loudly if it throws nothing. */
function captureThrownMessage(thunk: () => unknown): string {
  try {
    thunk();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

// --------------------------------------------------------------------------
// RFC 8785 conformance vectors.
// --------------------------------------------------------------------------

// RFC 8785 §3.2.2, verbatim: "Assume the following JSON object is parsed".
//
// Held as JSON SOURCE TEXT and parsed at runtime rather than transcribed into a
// TypeScript object literal, because the vector's whole point is the gap
// between tolerant JSON INPUT — uppercase `1E30`, a trailing-zero `4.50`, an
// escaped `\u0042` standing in for a plain `B` — and the fixed ECMAScript
// OUTPUT form. Hand-decoding those escapes into a TS literal would throw away
// the input half of the vector, leaving it to assert only that output is
// stable.
//
// Doubled backslashes keep each `\uXXXX` intact through TypeScript's own string
// parsing so it reaches `JSON.parse` as a JSON escape. A transcription slip here
// cannot weaken the test silently: the expected side is the RFC's own published
// byte string, so a wrong input simply fails to produce it.
const RFC_8785_SAMPLE_DOCUMENT_SOURCE =
  "{\n" +
  '  "numbers": [333333333.33333329, 1E30, 4.50,\n' +
  "              2e-3, 0.000000000000000000000000001],\n" +
  '  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n' +
  '  "literals": [null, true, false]\n' +
  "}";

// RFC 8785 §3.2.4, verbatim — the expected UTF-8 bytes for the document above,
// in the RFC's own 20-bytes-per-line grouping so the fixture can be diffed
// against the published table by eye.
const RFC_8785_SAMPLE_DOCUMENT_BYTES = `
  7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
  75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
  5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
  65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
  5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
  30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d
`;

// RFC 8785 §3.2.3, verbatim — "The following JSON test data can be used for
// verifying the correctness of the sorting scheme in a JCS implementation".
const RFC_8785_SORTING_SAMPLE_SOURCE =
  "{\n" +
  '  "\\u20ac": "Euro Sign",\n' +
  '  "\\r": "Carriage Return",\n' +
  '  "\\ufb33": "Hebrew Letter Dalet With Dagesh",\n' +
  '  "1": "One",\n' +
  '  "\\ud83d\\ude00": "Emoji: Grinning Face",\n' +
  '  "\\u0080": "Control",\n' +
  '  "\\u00f6": "Latin Small Letter O With Diaeresis"\n' +
  "}";

// RFC 8785 §3.2.3, verbatim — "Expected argument order after sorting property
// strings". Stated as VALUES because each value names its own key, so the
// assertion reads as the RFC prints it.
const RFC_8785_EXPECTED_SORTED_VALUES: readonly string[] = [
  "Carriage Return",
  "One",
  "Control",
  "Latin Small Letter O With Diaeresis",
  "Euro Sign",
  "Emoji: Grinning Face",
  "Hebrew Letter Dalet With Dagesh",
];

// RFC 8785 Appendix B, Table 1 — all 26 rows, in the RFC's order. A `null`
// expectation is the RFC's empty "JSON Representation" cell, annotated note (3)
// ("Values out of range are not permitted in JSON") — those two rows MUST be
// refused rather than serialized.
const RFC_8785_NUMBER_SAMPLES: ReadonlyArray<{
  readonly ieee754Hex: string;
  readonly expectedJson: string | null;
  readonly comment: string;
}> = [
  { ieee754Hex: "0000000000000000", expectedJson: "0", comment: "Zero" },
  { ieee754Hex: "8000000000000000", expectedJson: "0", comment: "Minus zero" },
  { ieee754Hex: "0000000000000001", expectedJson: "5e-324", comment: "Min pos number" },
  { ieee754Hex: "8000000000000001", expectedJson: "-5e-324", comment: "Min neg number" },
  {
    ieee754Hex: "7fefffffffffffff",
    expectedJson: "1.7976931348623157e+308",
    comment: "Max pos number",
  },
  {
    ieee754Hex: "ffefffffffffffff",
    expectedJson: "-1.7976931348623157e+308",
    comment: "Max neg number",
  },
  { ieee754Hex: "4340000000000000", expectedJson: "9007199254740992", comment: "Max pos int" },
  { ieee754Hex: "c340000000000000", expectedJson: "-9007199254740992", comment: "Max neg int" },
  { ieee754Hex: "4430000000000000", expectedJson: "295147905179352830000", comment: "~2**68" },
  { ieee754Hex: "7fffffffffffffff", expectedJson: null, comment: "NaN" },
  { ieee754Hex: "7ff0000000000000", expectedJson: null, comment: "Infinity" },
  { ieee754Hex: "44b52d02c7e14af5", expectedJson: "9.999999999999997e+22", comment: "" },
  { ieee754Hex: "44b52d02c7e14af6", expectedJson: "1e+23", comment: "" },
  { ieee754Hex: "44b52d02c7e14af7", expectedJson: "1.0000000000000001e+23", comment: "" },
  { ieee754Hex: "444b1ae4d6e2ef4e", expectedJson: "999999999999999700000", comment: "" },
  { ieee754Hex: "444b1ae4d6e2ef4f", expectedJson: "999999999999999900000", comment: "" },
  { ieee754Hex: "444b1ae4d6e2ef50", expectedJson: "1e+21", comment: "" },
  { ieee754Hex: "3eb0c6f7a0b5ed8c", expectedJson: "9.999999999999997e-7", comment: "" },
  { ieee754Hex: "3eb0c6f7a0b5ed8d", expectedJson: "0.000001", comment: "" },
  { ieee754Hex: "41b3de4355555553", expectedJson: "333333333.3333332", comment: "" },
  { ieee754Hex: "41b3de4355555554", expectedJson: "333333333.33333325", comment: "" },
  { ieee754Hex: "41b3de4355555555", expectedJson: "333333333.3333333", comment: "" },
  { ieee754Hex: "41b3de4355555556", expectedJson: "333333333.3333334", comment: "" },
  { ieee754Hex: "41b3de4355555557", expectedJson: "333333333.33333343", comment: "" },
  {
    ieee754Hex: "becbf647612f3696",
    expectedJson: "-0.0000033333333333333333",
    comment: "",
  },
  { ieee754Hex: "43143ff3c1cb0959", expectedJson: "1424953923781206.2", comment: "Round to even" },
];

describe("RFC 8785 conformance — the published JCS vectors", () => {
  it("§3.2.2 sample document canonicalizes to the exact UTF-8 bytes of §3.2.4", () => {
    const canonicalBytes = canonicalizeJson(JSON.parse(RFC_8785_SAMPLE_DOCUMENT_SOURCE));

    // The byte assertion is the normative one — RFC 8785 §3.2.4 fixes UTF-8 as
    // the canonical output encoding, and these are the bytes a signature
    // commits to. Asserted as hex so a failure prints a readable diff.
    expect(bytesToHex(canonicalBytes)).toBe(bytesToHex(hexToBytes(RFC_8785_SAMPLE_DOCUMENT_BYTES)));

    // The text assertion is redundant with the bytes but is what a human reads
    // when the byte assertion fails: it names WHICH transform regressed
    // (whitespace removal, number re-rendering, string escaping, or lex-sort).
    expect(decodeUtf8(canonicalBytes)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("§3.2.3 sorts property names by UTF-16 code unit, not by code point", () => {
    const canonicalText = decodeUtf8(canonicalizeJson(JSON.parse(RFC_8785_SORTING_SAMPLE_SOURCE)));

    // Read the ORDER off the canonical TEXT, never off a re-parsed object:
    // `JSON.parse` reinstates JavaScript's own property order, which hoists the
    // integer-like key "1" to the front and would silently mask a sort bug.
    const emittedValues = Array.from(canonicalText.matchAll(/:"([^"]*)"/g), (match) => match[1]);
    expect(emittedValues).toStrictEqual(RFC_8785_EXPECTED_SORTED_VALUES);

    // Negative control — this vector only PROVES something because a code-point
    // sort disagrees with it. U+1F600 (the emoji) is a surrogate pair whose
    // leading unit U+D83D precedes U+FB33, so UTF-16 order puts the emoji
    // BEFORE the Hebrew letter while code-point order puts it after. Without
    // this assertion, a re-implementation that sorted by code point could pass
    // the check above if the expected list were ever "corrected" to match it.
    const codePointSortedValues = [...RFC_8785_EXPECTED_SORTED_VALUES].sort();
    expect(codePointSortedValues).not.toStrictEqual(RFC_8785_EXPECTED_SORTED_VALUES);
    expect(RFC_8785_EXPECTED_SORTED_VALUES.indexOf("Emoji: Grinning Face")).toBeLessThan(
      RFC_8785_EXPECTED_SORTED_VALUES.indexOf("Hebrew Letter Dalet With Dagesh"),
    );
  });

  for (const sample of RFC_8785_NUMBER_SAMPLES) {
    const label =
      sample.comment === "" ? sample.ieee754Hex : `${sample.ieee754Hex} (${sample.comment})`;

    if (sample.expectedJson === null) {
      it(`Appendix B — ${label} is refused: JSON admits no such value`, () => {
        // RFC 8785 §3.2.2.3: "occurrences of NaN or Infinity MUST cause a
        // compliant JCS implementation to terminate with an appropriate error."
        // These two refusals originate inside `canonicalize@3.0.0` and surface
        // with its bare wording — pinned here so a library swap that started
        // emitting `null` (plain `JSON.stringify` behavior) fails loudly
        // instead of signing a silently-substituted value.
        const message = captureThrownMessage(() =>
          canonicalizeJson(ieee754HexToNumber(sample.ieee754Hex)),
        );
        expect(message).toBe(`${sample.comment} is not allowed`);
      });
      continue;
    }

    it(`Appendix B — ${label} serializes as ${sample.expectedJson}`, () => {
      expect(decodeUtf8(canonicalizeJson(ieee754HexToNumber(sample.ieee754Hex)))).toBe(
        sample.expectedJson,
      );
    });
  }

  it("processed all 26 Appendix B Table 1 rows", () => {
    // Guards against a row being dropped during an edit: a shorter table would
    // otherwise just be a quieter suite, not a failing one.
    expect(RFC_8785_NUMBER_SAMPLES).toHaveLength(26);
    expect(RFC_8785_NUMBER_SAMPLES.filter((sample) => sample.expectedJson === null)).toHaveLength(
      2,
    );
  });
});

// --------------------------------------------------------------------------
// canonicalizeEvent — the canonical eleven-member envelope (I-006-1-03).
// --------------------------------------------------------------------------

const SESSION_ID: SessionId = SessionIdSchema.parse("0192f3a4-5b6c-7d8e-9f01-234567890abc");
const ENVELOPE_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// EVERY MEMBER CARRIES A DISTINCT, NON-INTERCHANGEABLE VALUE, AND THAT IS THE
// POINT — do not "tidy" this fixture into repeated placeholders.
// `canonicalizer.ts` documents one drift its mapped-type annotation cannot
// catch: a SAME-TYPED transposition such as `causationId: envelope.correlationId`
// compiles clean under any annotation, and it explicitly assigns that residue to
// this suite ("That residue is T2.3's golden vectors' to close, by construction
// rather than by annotation"). The construction that closes it is exactly this:
// no two members share a value, so any crosswire moves the bytes below.
const GOLDEN_ENVELOPE: EventEnvelope = {
  id: "01960b3c-e1d0-7a41-b2c9-5f8e37d6a204",
  sessionId: SESSION_ID,
  // The T2.3 row's "numeric edge cases per ECMA-262 ToString" obligation,
  // applied to the one canonical member that is a number. This is
  // `Number.MAX_SAFE_INTEGER` — exactly the upper bound RFC 8785 Appendix B
  // note (1) recommends for values "interpreted as true integers", and the
  // largest `sequence` the envelope schema admits (Zod's `.int()` bounds to the
  // safe-integer range). Appendix B's next row up, 9007199254740992, is a valid
  // ECMAScript integer that `EventEnvelopeSchema` REJECTS; it is covered in the
  // number table above, where no envelope contract applies.
  sequence: 9007199254740991,
  occurredAt: "2026-03-04T05:06:07.008Z",
  category: "audit_integrity",
  type: "audit.chain_verified",
  actor: "participant-7f3a",
  payload: {
    zebra: "sorts-last",
    alpha: "sorts-first",
    // Nested lex-sort, and specifically the case a locale-aware or
    // case-insensitive sort gets wrong: UTF-16 code units put "B" (0x42) before
    // "a" (0x61) before "é" (0xE9).
    nested: { é: "e-acute", B: "upper-b", a: "lower-a" },
    ratio: 333333333.3333332,
  },
  correlationId: "correlation-9c2e",
  causationId: "causation-4b1d",
  version: ENVELOPE_VERSION,
};

// Produced by this module and pinned as a REGRESSION constant: unlike the RFC
// vectors above there is no external publication of what an AI-Sidekicks
// envelope must hash to, so what this fixture buys is byte-stability across
// refactors and dependency bumps (I-006-2-03) — the property that keeps every
// `row_hash` already on disk verifiable.
const GOLDEN_ENVELOPE_CANONICAL_TEXT =
  '{"actor":"participant-7f3a","category":"audit_integrity","causationId":"causation-4b1d",' +
  '"correlationId":"correlation-9c2e","id":"01960b3c-e1d0-7a41-b2c9-5f8e37d6a204",' +
  '"occurredAt":"2026-03-04T05:06:07.008Z","payload":{"alpha":"sorts-first",' +
  '"nested":{"B":"upper-b","a":"lower-a","é":"e-acute"},"ratio":333333333.3333332,' +
  '"zebra":"sorts-last"},"sequence":9007199254740991,' +
  '"sessionId":"0192f3a4-5b6c-7d8e-9f01-234567890abc","type":"audit.chain_verified",' +
  '"version":"1.0"}';

const GOLDEN_ENVELOPE_CANONICAL_BYTES = `
  7b 22 61 63 74 6f 72 22 3a 22 70 61 72 74 69 63 69 70 61 6e
  74 2d 37 66 33 61 22 2c 22 63 61 74 65 67 6f 72 79 22 3a 22
  61 75 64 69 74 5f 69 6e 74 65 67 72 69 74 79 22 2c 22 63 61
  75 73 61 74 69 6f 6e 49 64 22 3a 22 63 61 75 73 61 74 69 6f
  6e 2d 34 62 31 64 22 2c 22 63 6f 72 72 65 6c 61 74 69 6f 6e
  49 64 22 3a 22 63 6f 72 72 65 6c 61 74 69 6f 6e 2d 39 63 32
  65 22 2c 22 69 64 22 3a 22 30 31 39 36 30 62 33 63 2d 65 31
  64 30 2d 37 61 34 31 2d 62 32 63 39 2d 35 66 38 65 33 37 64
  36 61 32 30 34 22 2c 22 6f 63 63 75 72 72 65 64 41 74 22 3a
  22 32 30 32 36 2d 30 33 2d 30 34 54 30 35 3a 30 36 3a 30 37
  2e 30 30 38 5a 22 2c 22 70 61 79 6c 6f 61 64 22 3a 7b 22 61
  6c 70 68 61 22 3a 22 73 6f 72 74 73 2d 66 69 72 73 74 22 2c
  22 6e 65 73 74 65 64 22 3a 7b 22 42 22 3a 22 75 70 70 65 72
  2d 62 22 2c 22 61 22 3a 22 6c 6f 77 65 72 2d 61 22 2c 22 c3
  a9 22 3a 22 65 2d 61 63 75 74 65 22 7d 2c 22 72 61 74 69 6f
  22 3a 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 32 2c
  22 7a 65 62 72 61 22 3a 22 73 6f 72 74 73 2d 6c 61 73 74 22
  7d 2c 22 73 65 71 75 65 6e 63 65 22 3a 39 30 30 37 31 39 39
  32 35 34 37 34 30 39 39 31 2c 22 73 65 73 73 69 6f 6e 49 64
  22 3a 22 30 31 39 32 66 33 61 34 2d 35 62 36 63 2d 37 64 38
  65 2d 39 66 30 31 2d 32 33 34 35 36 37 38 39 30 61 62 63 22
  2c 22 74 79 70 65 22 3a 22 61 75 64 69 74 2e 63 68 61 69 6e
  5f 76 65 72 69 66 69 65 64 22 2c 22 76 65 72 73 69 6f 6e 22
  3a 22 31 2e 30 22 7d
`;

describe("canonicalizeEvent — the canonical eleven-member envelope (I-006-1-03)", () => {
  it("produces byte-stable canonical bytes for the golden envelope", () => {
    const canonicalBytes = canonicalizeEvent(GOLDEN_ENVELOPE);
    expect(decodeUtf8(canonicalBytes)).toBe(GOLDEN_ENVELOPE_CANONICAL_TEXT);
    expect(bytesToHex(canonicalBytes)).toBe(
      bytesToHex(hexToBytes(GOLDEN_ENVELOPE_CANONICAL_BYTES)),
    );
  });

  it("ignores declaration order — RFC 8785 §3.2.3 lex-sort fixes the byte order", () => {
    // Same eleven members, written in reverse declaration order. The wire
    // authority calls declaration order non-load-bearing; this pins it.
    const reverseDeclarationOrder: EventEnvelope = {
      version: GOLDEN_ENVELOPE.version,
      causationId: GOLDEN_ENVELOPE.causationId,
      correlationId: GOLDEN_ENVELOPE.correlationId,
      payload: GOLDEN_ENVELOPE.payload,
      actor: GOLDEN_ENVELOPE.actor,
      type: GOLDEN_ENVELOPE.type,
      category: GOLDEN_ENVELOPE.category,
      occurredAt: GOLDEN_ENVELOPE.occurredAt,
      sequence: GOLDEN_ENVELOPE.sequence,
      sessionId: GOLDEN_ENVELOPE.sessionId,
      id: GOLDEN_ENVELOPE.id,
    };
    expect(decodeUtf8(canonicalizeEvent(reverseDeclarationOrder))).toBe(
      GOLDEN_ENVELOPE_CANONICAL_TEXT,
    );
  });

  it("detects a same-typed member transposition, which no type annotation can", () => {
    // `correlationId` and `causationId` are both `string | undefined`, so
    // swapping them compiles clean. It must not serialize clean.
    const transposed: EventEnvelope = {
      ...GOLDEN_ENVELOPE,
      correlationId: GOLDEN_ENVELOPE.causationId,
      causationId: GOLDEN_ENVELOPE.correlationId,
    };
    expect(decodeUtf8(canonicalizeEvent(transposed))).not.toBe(GOLDEN_ENVELOPE_CANONICAL_TEXT);
  });

  it("serializes version as a quoted string, never as a JSON number", () => {
    // ADR-018 makes `version` a "MAJOR.MINOR" semver STRING on the wire. A
    // regression to a numeric `1.0` would serialize as `1` and change the bytes
    // of every row.
    expect(decodeUtf8(canonicalizeEvent(GOLDEN_ENVELOPE))).toContain('"version":"1.0"');
    expect(decodeUtf8(canonicalizeEvent(GOLDEN_ENVELOPE))).not.toContain('"version":1');
  });

  it("projects only the canonical set — a runtime-only member is not serialized", () => {
    // `pii_payload` is a storage column, deliberately NOT an envelope member
    // (`Spec-006 §Canonical Serialization Rules`): the Spec-022 crypto-shred
    // clears that column and the canonical bytes must survive it. The explicit
    // projection in `canonicalizeEvent` is what guarantees a member the
    // envelope happens to carry at runtime never reaches the signed bytes.
    const withStorageOnlyMember: EventEnvelope = {
      ...GOLDEN_ENVELOPE,
      ...{ pii_payload: "ciphertext-that-must-not-be-signed" },
    };
    // Guard the FIXTURE, not the module. The inner spread is what lets an
    // excess member past the object-literal check; if a later refactor changes
    // how this fixture is built and the member stops landing on the runtime
    // object, the two assertions below would both pass while testing nothing.
    expect(Object.keys(withStorageOnlyMember)).toContain("pii_payload");
    const canonicalText = decodeUtf8(canonicalizeEvent(withStorageOnlyMember));
    expect(canonicalText).toBe(GOLDEN_ENVELOPE_CANONICAL_TEXT);
    expect(canonicalText).not.toContain("pii_payload");
  });

  it("normalizes occurredAt inside canonicalization — one instant, one byte string", () => {
    // Three lexical spellings of the SAME instant (Z form, a positive offset,
    // and a negative offset with omitted seconds) must produce identical bytes,
    // because `daemon_signature` commits to the instant.
    const utcSpelling: EventEnvelope = {
      ...GOLDEN_ENVELOPE,
      occurredAt: "2026-03-04T05:06:07.008Z",
    };
    const positiveOffsetSpelling: EventEnvelope = {
      ...GOLDEN_ENVELOPE,
      occurredAt: "2026-03-04T10:06:07.008+05:00",
    };
    const negativeOffsetSpelling: EventEnvelope = {
      ...GOLDEN_ENVELOPE,
      occurredAt: "2026-03-04T00:06:07.008-05:00",
    };
    expect(decodeUtf8(canonicalizeEvent(positiveOffsetSpelling))).toBe(
      GOLDEN_ENVELOPE_CANONICAL_TEXT,
    );
    expect(decodeUtf8(canonicalizeEvent(negativeOffsetSpelling))).toBe(
      GOLDEN_ENVELOPE_CANONICAL_TEXT,
    );
    expect(decodeUtf8(canonicalizeEvent(utcSpelling))).toBe(GOLDEN_ENVELOPE_CANONICAL_TEXT);
  });

  it("refuses an envelope whose occurredAt cannot be normalized", () => {
    const subMillisecond: EventEnvelope = {
      ...GOLDEN_ENVELOPE,
      occurredAt: "2026-03-04T05:06:07.0081Z",
    };
    expect(() => canonicalizeEvent(subMillisecond)).toThrow(/sub-millisecond precision/);
  });
});

// --------------------------------------------------------------------------
// actor — the canonical set's SOLE null-admitting member.
// --------------------------------------------------------------------------

/** Extracts the union of member names whose declared type admits `null`. */
type MemberAdmittingNull<Envelope> = {
  [MemberName in keyof Envelope]-?: null extends Envelope[MemberName] ? MemberName : never;
}[keyof Envelope];

// COMPILE-TIME derivation, and the tightest of the three: mutual assignability
// between the derived union and `"actor"`. If a second `EventEnvelope` member
// ever admits `null`, the derived union widens, the first `extends` fails, the
// conditional resolves to `false`, and this initializer stops typechecking
// (TS2322) — in `pnpm --filter @ai-sidekicks/runtime-daemon typecheck`, before
// any test runs. Verified to fail on perturbation rather than assumed to.
const NULL_ADMITTING_MEMBER_IS_ACTOR_ONLY: [MemberAdmittingNull<EventEnvelope>] extends ["actor"]
  ? ["actor"] extends [MemberAdmittingNull<EventEnvelope>]
    ? true
    : false
  : false = true;

const CANONICAL_MEMBER_NAMES: readonly (keyof EventEnvelope)[] = [
  "id",
  "sessionId",
  "sequence",
  "occurredAt",
  "category",
  "type",
  "actor",
  "payload",
  "correlationId",
  "causationId",
  "version",
];

describe("actor is the canonical set's only null-admitting member", () => {
  it("has exactly eleven canonical members", () => {
    // I-006-1-03 fixes membership at eleven. `EventEnvelopeSchema` is
    // `.strict()`, so an envelope carrying every listed member and nothing else
    // parsing clean is a two-sided check: no member missing, none extra.
    expect(CANONICAL_MEMBER_NAMES).toHaveLength(11);
    expect(EventEnvelopeSchema.safeParse(GOLDEN_ENVELOPE).success).toBe(true);
    expect(new Set(CANONICAL_MEMBER_NAMES).size).toBe(11);
  });

  it("derives the null-admitting member set from the contract, at compile time", () => {
    expect(NULL_ADMITTING_MEMBER_IS_ACTOR_ONLY).toBe(true);
  });

  it("derives the null-admitting member set from the contract, at runtime", () => {
    // Independent of the type-level derivation above: ask the RUNTIME validator
    // which members accept `null`, rather than trusting a hand-maintained count.
    const membersAcceptingNull = CANONICAL_MEMBER_NAMES.filter(
      (memberName) =>
        EventEnvelopeSchema.safeParse({ ...GOLDEN_ENVELOPE, [memberName]: null }).success,
    );
    expect(membersAcceptingNull).toStrictEqual(["actor"]);
  });

  it("keeps present-null and absent distinguishable in the canonical bytes", () => {
    // `Spec-006 §Canonical Serialization Rules`: "fields with value null MUST be
    // included". JSON has no `undefined`, so an absent member is an absent key —
    // and the two MUST NOT collapse, which is why `canonicalizeEvent`'s
    // precondition puts the absent-vs-null choice on the append path.
    const presentNullActor: EventEnvelope = { ...GOLDEN_ENVELOPE, actor: null };
    const { actor: _absentActor, ...withoutActorMember } = GOLDEN_ENVELOPE;
    const absentActor: EventEnvelope = withoutActorMember;

    const presentNullText = decodeUtf8(canonicalizeEvent(presentNullActor));
    const absentText = decodeUtf8(canonicalizeEvent(absentActor));

    expect(presentNullText).toContain('"actor":null');
    expect(absentText).not.toContain('"actor"');
    expect(presentNullText).not.toBe(absentText);

    // An explicitly-`undefined` member is the same wire state as an absent key —
    // that is what the wire schema's `.optional()` yields for a key the producer
    // never sent — so it must serialize identically to the absent case.
    const explicitlyUndefinedActor: EventEnvelope = { ...GOLDEN_ENVELOPE, actor: undefined };
    expect(decodeUtf8(canonicalizeEvent(explicitlyUndefinedActor))).toBe(absentText);
  });
});

// --------------------------------------------------------------------------
// Nesting-depth ceiling.
// --------------------------------------------------------------------------

/** Wraps `innermostLeaf` in exactly `containerLevels` objects, so the leaf sits at nominal depth `containerLevels + 1`. */
function buildNestedContainerChain(containerLevels: number, innermostLeaf: unknown): unknown {
  let nested = innermostLeaf;
  for (let level = 0; level < containerLevels; level++) nested = { a: nested };
  return nested;
}

describe("canonicalizeJson — the nesting-depth ceiling", () => {
  it("accepts containers nested 64 deep", () => {
    expect(() => canonicalizeJson(buildNestedContainerChain(63, {}))).not.toThrow();
    expect(() => canonicalizeJson(buildNestedContainerChain(64, 0))).not.toThrow();
  });

  it("refuses containers nested 65 deep", () => {
    expect(() => canonicalizeJson(buildNestedContainerChain(65, 0))).toThrow(
      /nests containers deeper than 64 levels/,
    );
  });

  it("accepts a SCALAR at depth 65 while refusing a CONTAINER at depth 65", () => {
    // THE DISCRIMINATING PAIR, and the reason this case is not redundant with
    // the two above. Both inputs carry the SAME 64 wrapper containers; they
    // differ only in the KIND of the node at depth 65.
    //
    // `assertWithinCanonicalDepth` queues containers only and `continue`s past a
    // scalar BEFORE consulting its depth, so a scalar leaf at depth 65 is
    // accepted by construction. A refactor that hoisted the depth check above
    // that `continue` — or that dropped the container-only push filter — would
    // break exactly this assertion and nothing else in the suite.
    expect(() =>
      canonicalizeJson(buildNestedContainerChain(64, "scalar-at-depth-65")),
    ).not.toThrow();
    expect(() => canonicalizeJson(buildNestedContainerChain(64, {}))).toThrow(
      /nests containers deeper than 64 levels/,
    );
  });

  it("reports a cyclic own-property graph as depth exhaustion, not as a hang", () => {
    // The depth walk drives a cycle's depth up without bound, so it fires before
    // `canonicalize@3.0.0`'s own cycle detection. Both refuse; the guard's
    // wording is the one that reaches the caller, and pinning WHICH message
    // arrives is what proves the iterative guard ran rather than the library
    // recursing (which is what would stack-overflow on deep untrusted input).
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const message = captureThrownMessage(() => canonicalizeJson(cyclic));
    expect(message).toMatch(/nests containers deeper than 64 levels/);
    expect(message).not.toMatch(/Circular reference detected/);
  });
});

// --------------------------------------------------------------------------
// occurredAt normalization.
// --------------------------------------------------------------------------

const OCCURRED_AT_NORMALIZATIONS: ReadonlyArray<{
  readonly input: string;
  readonly normalized: string;
  readonly why: string;
}> = [
  {
    input: "2026-03-04T05:06:07.008Z",
    normalized: "2026-03-04T05:06:07.008Z",
    why: "already canonical — the form is a fixed point",
  },
  {
    input: "2026-01-01T00:00Z",
    normalized: "2026-01-01T00:00:00.000Z",
    why: "omitted seconds expand instant-preserved",
  },
  {
    input: "2026-01-01T05:00:00+05:00",
    normalized: "2026-01-01T00:00:00.000Z",
    why: "positive offset folds to UTC",
  },
  {
    input: "2025-12-31T19:00:00-05:00",
    normalized: "2026-01-01T00:00:00.000Z",
    why: "negative offset folds across a year boundary",
  },
  {
    input: "2026-01-01T00:00:00.000+00:00",
    normalized: "2026-01-01T00:00:00.000Z",
    why: "a numeric zero offset is the Z instant",
  },
  {
    input: "2026-01-01T00:00:00.1Z",
    normalized: "2026-01-01T00:00:00.100Z",
    why: "a short fraction zero-pads to three digits",
  },
  {
    input: "2026-01-01T00:00:00.1230Z",
    normalized: "2026-01-01T00:00:00.123Z",
    why: "trailing zeros past the third digit are pure notation",
  },
  {
    input: "2026-02-28T23:59:59.999Z",
    normalized: "2026-02-28T23:59:59.999Z",
    why: "clock-tick boundary — last millisecond of a non-leap February",
  },
  {
    input: "2026-03-01T00:00:00.000Z",
    normalized: "2026-03-01T00:00:00.000Z",
    why: "clock-tick boundary — first millisecond of the next month",
  },
];

const OCCURRED_AT_REFUSALS: ReadonlyArray<{
  readonly input: string;
  readonly expected: RegExp;
  readonly rejected: RegExp;
  readonly why: string;
}> = [
  {
    input: "2026-01-01T00:00:00.0001Z",
    expected: /carries sub-millisecond precision/,
    rejected: /does not exist on the calendar/,
    why: "sub-millisecond precision is refused, never truncated",
  },
  {
    input: "2026-02-29T00:00:00.000Z",
    expected: /names a date that does not exist on the calendar/,
    rejected: /sub-millisecond/,
    why: "2026 is not a leap year",
  },
  {
    input: "2026-02-30T00:00:00.000Z",
    expected: /names a date that does not exist on the calendar/,
    rejected: /sub-millisecond/,
    why: "February never has 30 days",
  },
  {
    input: "0000-01-01T00:00:00+05:00",
    expected: /does not fold into the canonical form/,
    rejected: /does not exist on the calendar/,
    why: "year-fold UNDERFLOW — folds back to year -1, outside the four-digit range",
  },
  {
    input: "9999-12-31T23:59:59-05:00",
    expected: /does not fold into the canonical form/,
    rejected: /does not exist on the calendar/,
    why: "year-fold OVERFLOW — folds forward to year 10000",
  },
  {
    input: "2026-01-01t00:00:00.000Z",
    expected: /must be an RFC 3339 date-time with an uppercase T separator/,
    rejected: /sub-millisecond/,
    why: "RFC 3339 §5.6 permits lowercase t, but the wire schema does not",
  },
  {
    input: "2026-01-01 00:00:00.000Z",
    expected: /must be an RFC 3339 date-time with an uppercase T separator/,
    rejected: /sub-millisecond/,
    why: "a space separator is outside the wire schema's lexical form",
  },
];

describe("normalizeOccurredAt — normalize where the instant survives, refuse otherwise", () => {
  for (const vector of OCCURRED_AT_NORMALIZATIONS) {
    it(`normalizes ${vector.input} to ${vector.normalized} — ${vector.why}`, () => {
      expect(normalizeOccurredAt(vector.input)).toBe(vector.normalized);
    });
  }

  for (const vector of OCCURRED_AT_REFUSALS) {
    it(`refuses ${vector.input} — ${vector.why}`, () => {
      // Assert BOTH directions: the expected refusal class fires AND the
      // neighbouring class does not. A bare "it threw" would still pass if two
      // refusal messages were merged, which is exactly the regression that
      // would make the precedence test below vacuous.
      const message = captureThrownMessage(() => normalizeOccurredAt(vector.input));
      expect(message).toMatch(vector.expected);
      expect(message).not.toMatch(vector.rejected);
    });
  }

  it("reports sub-millisecond precision BEFORE calendar validity — check order is observable", () => {
    // 2026-02-30T00:00:00.0001Z trips guard 2 (sub-millisecond) AND guard 3
    // (calendar existence). `canonicalizer.ts` fixes the execution order and
    // documents it as observable: "an input tripping both reports the
    // sub-millisecond refusal and never the calendar one".
    //
    // The two single-fault controls in the refusal table above are what make
    // this assertion meaningful: they establish that each guard fires on its own
    // input, so seeing the sub-millisecond message here is evidence of ORDER
    // rather than evidence that the calendar guard is simply broken.
    const message = captureThrownMessage(() => normalizeOccurredAt("2026-02-30T00:00:00.0001Z"));
    expect(message).toMatch(/carries sub-millisecond precision/);
    expect(message).not.toMatch(/does not exist on the calendar/);
  });

  it("is idempotent — the canonical form is a fixed point of every branch", () => {
    // Load-bearing: verifiers re-canonicalize a stored row to recompute
    // `row_hash`, so byte-reproduction must hold whether the append path
    // persisted the raw or the normalized string.
    for (const vector of OCCURRED_AT_NORMALIZATIONS) {
      const onceNormalized = normalizeOccurredAt(vector.input);
      expect(normalizeOccurredAt(onceNormalized)).toBe(onceNormalized);
    }
  });
});

// --------------------------------------------------------------------------
// JSON representability and library-originated refusals.
// --------------------------------------------------------------------------

describe("canonicalizeJson — values with no JSON representation", () => {
  // `canonicalize@3.0.0` DELEGATES to `JSON.stringify` for non-objects, which
  // returns `undefined` rather than throwing for these three. Unguarded, the
  // encoder would turn that into ZERO canonical bytes and the signer would sign
  // the empty string for an input it could not represent.
  const valuesWithoutJsonRepresentation: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: "undefined", value: undefined },
    { label: "a function", value: (): number => 1 },
    { label: "a symbol", value: Symbol("not-serializable") },
  ];

  for (const { label, value } of valuesWithoutJsonRepresentation) {
    it(`refuses ${label} at the top level rather than emitting zero bytes`, () => {
      expect(() => canonicalizeJson(value)).toThrow(/RFC 8785 canonicalization produced no output/);
    });
  }

  it("surfaces the three library-originated refusals intelligibly", () => {
    // These originate inside `canonicalize@3.0.0` and reach the caller with the
    // library's own bare wording. The module's header inventories them rather
    // than claiming it owns every throw; this pins the inventory so a library
    // bump that changed a message — or, worse, stopped throwing — is visible.
    expect(captureThrownMessage(() => canonicalizeJson({ sequence: Number.NaN }))).toBe(
      "NaN is not allowed",
    );
    expect(
      captureThrownMessage(() => canonicalizeJson({ sequence: Number.POSITIVE_INFINITY })),
    ).toBe("Infinity is not allowed");

    // A cycle reachable ONLY through a `toJSON` result is invisible to the
    // depth walk — `toJSON` is a function, so it fails the walk's
    // `typeof === "object"` child filter and the walk terminates — so this is
    // the one cycle shape that surfaces as the library's message rather than as
    // depth exhaustion. Contrast with the plain own-property cycle above.
    const cycleReachableOnlyViaToJson: { toJSON: () => unknown } = {
      toJSON: () => ({ nested: cycleReachableOnlyViaToJson }),
    };
    expect(captureThrownMessage(() => canonicalizeJson(cycleReachableOnlyViaToJson))).toBe(
      "Circular reference detected",
    );
  });
});
