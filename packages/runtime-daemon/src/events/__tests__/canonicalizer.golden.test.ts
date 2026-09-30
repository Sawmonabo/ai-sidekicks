// Golden bytes for the RFC 8785 canonicalizer: the RFC's published vectors, one pinned envelope,
// and the refusals that keep the canonical bytes one string per event. Expected bytes are
// transcribed or pinned, never recomputed, so a one-byte drift fails here.

import {
  EVENT_ENVELOPE_SEQUENCE_MAX,
  EventEnvelopeSchema,
  EventEnvelopeVersionSchema,
  SessionIdSchema,
} from "@ai-sidekicks/contracts";
import type { EventEnvelope, EventEnvelopeVersion, SessionId } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";
import { canonicalizeEvent, canonicalizeJson, normalizeOccurredAt } from "../canonicalizer.js";
import { bytesToHex } from "./event-test-fixtures.js";

// Helpers are hand-rolled, not imported from a byte-utility library, so a library bump cannot
// move the expected side of an assertion together with the produced side.

/** Parses grouped lowercase hex, ignoring whitespace so fixtures keep the RFC's layout. */
function hexToBytes(groupedHex: string): Uint8Array {
  const compactHex = groupedHex.replace(/\s+/g, "");
  const bytes = new Uint8Array(compactHex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(compactHex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
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

// RFC 8785 section 3.2.2 sample document, verbatim.
//
// Held as JSON source text and parsed at runtime, because the vector tests the gap between
// tolerant JSON input (uppercase `1E30`, a trailing-zero `4.50`, an escaped `\u0042` for a plain
// `B`) and the fixed ECMAScript output form; hand-decoding the escapes into a TypeScript literal
// would lose the input half. Doubled backslashes keep each `\uXXXX` intact through TypeScript's
// string parsing so it reaches `JSON.parse` as a JSON escape.
const RFC_8785_SAMPLE_DOCUMENT_SOURCE =
  "{\n" +
  '  "numbers": [333333333.33333329, 1E30, 4.50,\n' +
  "              2e-3, 0.000000000000000000000000001],\n" +
  '  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n' +
  '  "literals": [null, true, false]\n' +
  "}";

// RFC 8785 section 3.2.4, verbatim: the expected UTF-8 bytes for the document above, in the
// RFC's own 20-bytes-per-line grouping so it can be compared with the published table by eye.
const RFC_8785_SAMPLE_DOCUMENT_BYTES = `
  7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
  75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
  5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
  65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
  5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
  30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d
`;

// RFC 8785 section 3.2.3 sorting test data, verbatim.
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

// RFC 8785 section 3.2.3 expected order after sorting, verbatim. Stated as values because each
// value names its own key, so the assertion reads as the RFC prints it.
const RFC_8785_EXPECTED_SORTED_VALUES: readonly string[] = [
  "Carriage Return",
  "One",
  "Control",
  "Latin Small Letter O With Diaeresis",
  "Euro Sign",
  "Emoji: Grinning Face",
  "Hebrew Letter Dalet With Dagesh",
];

// RFC 8785 Appendix B, Table 1: all 26 rows, in the RFC's order. A `null` expectation is the
// RFC's empty "JSON Representation" cell (note 3, "Values out of range are not permitted in
// JSON"); those two rows must be refused, not serialized.
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

describe("RFC 8785 published vectors", () => {
  it("canonicalizes the RFC 8785 sample document to its published bytes", () => {
    const canonicalBytes = canonicalizeJson(JSON.parse(RFC_8785_SAMPLE_DOCUMENT_SOURCE));

    // The bytes are the normative check (RFC 8785 section 3.2.4 fixes UTF-8 as the canonical
    // encoding); hex makes a failure print a readable diff.
    expect(bytesToHex(canonicalBytes)).toBe(bytesToHex(hexToBytes(RFC_8785_SAMPLE_DOCUMENT_BYTES)));

    // Redundant with the bytes, but it shows which transform regressed (whitespace removal,
    // number rendering, string escaping or sorting).
    expect(decodeUtf8(canonicalBytes)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts property names by UTF-16 code unit, not by code point", () => {
    const canonicalText = decodeUtf8(canonicalizeJson(JSON.parse(RFC_8785_SORTING_SAMPLE_SOURCE)));

    // Read the order off the canonical text, not a re-parsed object: `JSON.parse` restores
    // JavaScript's property order, which hoists the integer-like key "1" and would mask a sort bug.
    const emittedValues = Array.from(canonicalText.matchAll(/:"([^"]*)"/g), (match) => match[1]);
    expect(emittedValues).toStrictEqual(RFC_8785_EXPECTED_SORTED_VALUES);

    // Negative control: the vector proves UTF-16 ordering only because a code-point sort
    // disagrees with it. The emoji U+1F600 is a surrogate pair whose leading unit U+D83D precedes
    // U+FB33, so UTF-16 order puts it before the Hebrew letter and code-point order after.
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
        // RFC 8785 section 3.2.2.3 requires an error here. The refusal comes from
        // `canonicalize@3.0.0` with its bare wording; pinning it makes a library swap that emits
        // `null` (plain `JSON.stringify` behavior) fail loudly.
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
});

const SESSION_ID: SessionId = SessionIdSchema.parse("0192f3a4-5b6c-7d8e-9f01-234567890abc");
const ENVELOPE_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// Every member carries a distinct value, so no two are interchangeable. A same-typed
// transposition such as `causationId: envelope.correlationId` compiles under the mapped type in
// `canonicalizer.ts`; only distinct values make it move the bytes below.
const GOLDEN_ENVELOPE: EventEnvelope = {
  id: "01960b3c-e1d0-7a41-b2c9-5f8e37d6a204",
  sessionId: SESSION_ID,
  // `Number.MAX_SAFE_INTEGER`, the largest `sequence` the contract admits; one above is refused.
  sequence: 9007199254740991,
  occurredAt: "2026-03-04T05:06:07.008Z",
  category: "event_maintenance",
  type: "event.compacted",
  actor: "user-7f3a",
  payload: {
    zebra: "sorts-last",
    alpha: "sorts-first",
    // Nested sort, in the order a locale-aware or case-insensitive sort gets wrong: UTF-16 code
    // units put "B" (0x42) before "a" (0x61) before "é" (0xE9).
    nested: { é: "e-acute", B: "upper-b", a: "lower-a" },
    ratio: 333333333.3333332,
  },
  correlationId: "correlation-9c2e",
  causationId: "causation-4b1d",
  version: ENVELOPE_VERSION,
};

// Produced by this module and pinned: no publication says what this envelope canonicalizes to, so
// it holds the bytes stable across refactors and dependency bumps.
const GOLDEN_ENVELOPE_CANONICAL_TEXT =
  '{"actor":"user-7f3a","category":"event_maintenance","causationId":"causation-4b1d",' +
  '"correlationId":"correlation-9c2e","id":"01960b3c-e1d0-7a41-b2c9-5f8e37d6a204",' +
  '"occurredAt":"2026-03-04T05:06:07.008Z","payload":{"alpha":"sorts-first",' +
  '"nested":{"B":"upper-b","a":"lower-a","é":"e-acute"},"ratio":333333333.3333332,' +
  '"zebra":"sorts-last"},"sequence":9007199254740991,' +
  '"sessionId":"0192f3a4-5b6c-7d8e-9f01-234567890abc","type":"event.compacted",' +
  '"version":"1.0"}';

const GOLDEN_ENVELOPE_CANONICAL_BYTES = `
  7b 22 61 63 74 6f 72 22 3a 22 75 73 65 72 2d 37 66 33 61 22
  2c 22 63 61 74 65 67 6f 72 79 22 3a 22 65 76 65 6e 74 5f 6d
  61 69 6e 74 65 6e 61 6e 63 65 22 2c 22 63 61 75 73 61 74 69
  6f 6e 49 64 22 3a 22 63 61 75 73 61 74 69 6f 6e 2d 34 62 31
  64 22 2c 22 63 6f 72 72 65 6c 61 74 69 6f 6e 49 64 22 3a 22
  63 6f 72 72 65 6c 61 74 69 6f 6e 2d 39 63 32 65 22 2c 22 69
  64 22 3a 22 30 31 39 36 30 62 33 63 2d 65 31 64 30 2d 37 61
  34 31 2d 62 32 63 39 2d 35 66 38 65 33 37 64 36 61 32 30 34
  22 2c 22 6f 63 63 75 72 72 65 64 41 74 22 3a 22 32 30 32 36
  2d 30 33 2d 30 34 54 30 35 3a 30 36 3a 30 37 2e 30 30 38 5a
  22 2c 22 70 61 79 6c 6f 61 64 22 3a 7b 22 61 6c 70 68 61 22
  3a 22 73 6f 72 74 73 2d 66 69 72 73 74 22 2c 22 6e 65 73 74
  65 64 22 3a 7b 22 42 22 3a 22 75 70 70 65 72 2d 62 22 2c 22
  61 22 3a 22 6c 6f 77 65 72 2d 61 22 2c 22 c3 a9 22 3a 22 65
  2d 61 63 75 74 65 22 7d 2c 22 72 61 74 69 6f 22 3a 33 33 33
  33 33 33 33 33 33 2e 33 33 33 33 33 33 32 2c 22 7a 65 62 72
  61 22 3a 22 73 6f 72 74 73 2d 6c 61 73 74 22 7d 2c 22 73 65
  71 75 65 6e 63 65 22 3a 39 30 30 37 31 39 39 32 35 34 37 34
  30 39 39 31 2c 22 73 65 73 73 69 6f 6e 49 64 22 3a 22 30 31
  39 32 66 33 61 34 2d 35 62 36 63 2d 37 64 38 65 2d 39 66 30
  31 2d 32 33 34 35 36 37 38 39 30 61 62 63 22 2c 22 74 79 70
  65 22 3a 22 65 76 65 6e 74 2e 63 6f 6d 70 61 63 74 65 64 22
  2c 22 76 65 72 73 69 6f 6e 22 3a 22 31 2e 30 22 7d
`;

describe("canonicalizeEvent — the canonical envelope", () => {
  it("produces byte-stable canonical bytes for the golden envelope", () => {
    const canonicalBytes = canonicalizeEvent(GOLDEN_ENVELOPE);
    expect(decodeUtf8(canonicalBytes)).toBe(GOLDEN_ENVELOPE_CANONICAL_TEXT);
    expect(bytesToHex(canonicalBytes)).toBe(
      bytesToHex(hexToBytes(GOLDEN_ENVELOPE_CANONICAL_BYTES)),
    );
  });

  it("ignores declaration order — RFC 8785 section 3.2.3 lex-sort fixes the byte order", () => {
    // The same eleven members in reverse declaration order; declaration order must not matter.
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

  it("serializes version as a quoted string, never as a JSON number", () => {
    // `version` is a "MAJOR.MINOR" string on the wire. A numeric `1.0` would serialize as `1` and
    // change the bytes of every row.
    expect(decodeUtf8(canonicalizeEvent(GOLDEN_ENVELOPE))).toContain('"version":"1.0"');
    expect(decodeUtf8(canonicalizeEvent(GOLDEN_ENVELOPE))).not.toContain('"version":1');
  });

  it("projects only the canonical set — a runtime-only member is not serialized", () => {
    // `pii_payload` is a storage column, not an envelope member: crypto-shred clears it, so the
    // canonical bytes must not depend on it. The explicit projection in `canonicalizeEvent`
    // keeps a runtime-only member out of the bytes.
    const withStorageOnlyMember: EventEnvelope = {
      ...GOLDEN_ENVELOPE,
      ...{ pii_payload: "ciphertext-that-must-not-be-serialized" },
    };
    // Guards the fixture: the inner spread lets the excess member past the object-literal check.
    // If the member stopped landing on the runtime object, the assertions below would pass while
    // testing nothing.
    expect(Object.keys(withStorageOnlyMember)).toContain("pii_payload");
    const canonicalText = decodeUtf8(canonicalizeEvent(withStorageOnlyMember));
    expect(canonicalText).toBe(GOLDEN_ENVELOPE_CANONICAL_TEXT);
    expect(canonicalText).not.toContain("pii_payload");
  });

  it("normalizes occurredAt inside canonicalization — one instant, one byte string", () => {
    // Three spellings of one instant (Z form, a positive offset, a negative offset) must produce
    // identical bytes, because the canonical form records the instant.
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

  it("keeps present-null and absent distinguishable in the canonical bytes", () => {
    // A member with value null must be included. JSON has no `undefined`, so an absent member is
    // an absent key, and the two must not collapse; the append path chooses between them.
    const presentNullActor: EventEnvelope = { ...GOLDEN_ENVELOPE, actor: null };
    const { actor: _absentActor, ...withoutActorMember } = GOLDEN_ENVELOPE;
    const absentActor: EventEnvelope = withoutActorMember;

    const presentNullText = decodeUtf8(canonicalizeEvent(presentNullActor));
    const absentText = decodeUtf8(canonicalizeEvent(absentActor));

    expect(presentNullText).toContain('"actor":null');
    expect(absentText).not.toContain('"actor"');
    expect(presentNullText).not.toBe(absentText);

    // An explicit `undefined` is the same wire state as an absent key (what `.optional()` yields
    // for a key the producer never sent), so it must serialize like the absent case.
    const explicitlyUndefinedActor: EventEnvelope = { ...GOLDEN_ENVELOPE, actor: undefined };
    expect(decodeUtf8(canonicalizeEvent(explicitlyUndefinedActor))).toBe(absentText);
  });

  it("refuses a sequence one above the ceiling, unparsed", () => {
    // Above 2^53 - 1 distinct integers share one double, so two events would share canonical bytes
    // and a replay key. `canonicalizeEvent` does not parse, so the guard sits here, not the schema.
    const message = captureThrownMessage(() =>
      canonicalizeEvent({ ...GOLDEN_ENVELOPE, sequence: 9007199254740992 }),
    );
    expect(message).toMatch(/canonicalization refused: sequence .* is not a safe integer/);
    expect(message).toMatch(/replay key/);
  });
});

/** Extracts the union of member names whose declared type admits `null`. */
type MemberAdmittingNull<Envelope> = {
  [MemberName in keyof Envelope]-?: null extends Envelope[MemberName] ? MemberName : never;
}[keyof Envelope];

// Compile-time check by mutual assignability between the derived union and `"actor"`. If a
// second `EventEnvelope` member admits `null`, the conditional resolves to `false` and this
// initializer fails to typecheck (TS2322) before any test runs.
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
  it("set-equals the wire authority's declared member set", () => {
    // Set equality against the schema's members, not a count: if the schema gained or lost a
    // member while this list stayed at eleven, count assertions would stay green, and the
    // runtime derivation below iterates this list. Both directions in one assertion, so no
    // member is missing and none is extra. A same-size swap for a stray key is also refused at
    // compile time by the `keyof EventEnvelope` element type.
    //
    // The cast is needed because `EventEnvelopeSchema` is exported as `z.ZodType<EventEnvelope>`
    // (required by `isolatedDeclarations`), which hides `.shape` from the type but not from the
    // runtime object. `session-event.test.ts` in contracts uses the same cast.
    const declaredMembers = Object.keys(
      (EventEnvelopeSchema as unknown as { shape: Record<string, unknown> }).shape,
    ).sort();

    // The count is taken from the derived array, so "eleven" comes from the schema, not this file.
    expect(declaredMembers).toHaveLength(11);
    expect([...CANONICAL_MEMBER_NAMES].sort()).toEqual(declaredMembers);
    // Only the hand-written list can hold a duplicate. The equality above would already fail on
    // one, but as an opaque array diff; this names it.
    expect(new Set(CANONICAL_MEMBER_NAMES).size).toBe(CANONICAL_MEMBER_NAMES.length);
    // `EventEnvelopeSchema` is `.strict()`, so a clean parse shows the golden envelope carries
    // every declared member and nothing else, which makes it a valid stand-in for the wire shape.
    expect(EventEnvelopeSchema.safeParse(GOLDEN_ENVELOPE).success).toBe(true);
  });

  it("derives the null-admitting member set from the contract, at compile time", () => {
    expect(NULL_ADMITTING_MEMBER_IS_ACTOR_ONLY).toBe(true);
  });

  it("derives the null-admitting member set from the contract, at runtime", () => {
    // Independent of the type-level check: asks the runtime validator which members accept `null`.
    const membersAcceptingNull = CANONICAL_MEMBER_NAMES.filter(
      (memberName) =>
        EventEnvelopeSchema.safeParse({ ...GOLDEN_ENVELOPE, [memberName]: null }).success,
    );
    expect(membersAcceptingNull).toStrictEqual(["actor"]);
  });
});

/** Wraps `innermostLeaf` in `containerLevels` objects, so the leaf sits at depth levels + 1. */
function buildNestedContainerChain(containerLevels: number, innermostLeaf: unknown): unknown {
  let nested = innermostLeaf;
  for (let level = 0; level < containerLevels; level++) nested = { a: nested };
  return nested;
}

describe("canonicalizeJson — refusals", () => {
  it("refuses containers nested 65 deep", () => {
    expect(() => canonicalizeJson(buildNestedContainerChain(65, 0))).toThrow(
      /nests containers deeper than 64 levels/,
    );
  });

  it("accepts a SCALAR at depth 65 while refusing a CONTAINER at depth 65", () => {
    // Both inputs have the same 64 wrapper containers and differ only in the kind of node at
    // depth 65. `assertWithinCanonicalDepth` queues containers only and skips a scalar before
    // checking its depth, so a scalar leaf at depth 65 is accepted. Moving the depth check above
    // that skip, or dropping the container-only filter, breaks only this test.
    expect(() =>
      canonicalizeJson(buildNestedContainerChain(64, "scalar-at-depth-65")),
    ).not.toThrow();
    expect(() => canonicalizeJson(buildNestedContainerChain(64, {}))).toThrow(
      /nests containers deeper than 64 levels/,
    );
  });

  it("reports a cyclic own-property graph as depth exhaustion, not as a hang", () => {
    // The depth walk drives a cycle's depth up without bound, so it fires before
    // `canonicalize@3.0.0`'s own cycle detection. Pinning which message arrives shows the
    // iterative guard ran, not the library's recursion, which would overflow the stack on deep
    // untrusted input.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const message = captureThrownMessage(() => canonicalizeJson(cyclic));
    expect(message).toMatch(/nests containers deeper than 64 levels/);
    expect(message).not.toMatch(/Circular reference detected/);
  });

  it("refuses undefined at the top level rather than emitting zero bytes", () => {
    // The library delegates non-objects to `JSON.stringify`, which returns `undefined` here.
    expect(() => canonicalizeJson(undefined)).toThrow(
      /RFC 8785 canonicalization produced no output/,
    );
  });

  it("surfaces the NaN and Infinity refusals the RFC requires", () => {
    // These come from `canonicalize@3.0.0` with its bare wording; a library that emitted `null`
    // instead would fail here.
    expect(captureThrownMessage(() => canonicalizeJson({ sequence: Number.NaN }))).toBe(
      "NaN is not allowed",
    );
    expect(
      captureThrownMessage(() => canonicalizeJson({ sequence: Number.POSITIVE_INFINITY })),
    ).toBe("Infinity is not allowed");
  });
});

// RFC 8785 section 3.2.2.2 requires an error on a lone surrogate. The library would escape it as
// `\ud800`, valid JSON that no conforming implementation agrees is canonical.

/** A lone HIGH surrogate (no low surrogate follows) — the U+D800 end of the range. */
const LONE_HIGH_SURROGATE = "\ud800";
/** A correctly paired U+1F600 GRINNING FACE, which must keep serializing. */
const VALID_SURROGATE_PAIR = "😀";

const LONE_SURROGATE_REFUSAL = /canonicalization refused: .* carries an unpaired UTF-16 surrogate/;

describe("canonicalizeJson — lone surrogates", () => {
  it("accepts a VALID surrogate pair and serializes it 'as is', never escaped", () => {
    const canonicalText = decodeUtf8(canonicalizeJson({ pair: VALID_SURROGATE_PAIR }));
    expect(canonicalText).toBe('{"pair":"😀"}');
    // A valid pair is serialized as is: UTF-8 bytes, not a \uXXXX escape.
    expect(bytesToHex(canonicalizeJson({ pair: VALID_SURROGATE_PAIR }))).toContain("f09f9880");
    expect(canonicalText).not.toContain("\\u");
    // Property names take a separate check.
    expect(() => canonicalizeJson({ [VALID_SURROGATE_PAIR]: "v" })).not.toThrow();
  });

  it("refuses a lone surrogate in a PROPERTY NAME", () => {
    // The RFC's JSON string data includes object property names.
    const message = captureThrownMessage(() =>
      canonicalizeJson({ [LONE_HIGH_SURROGATE]: "well-formed value" }),
    );
    expect(message).toMatch(LONE_SURROGATE_REFUSAL);
    expect(message).toMatch(/a property name/);
  });

  it("reports the code unit and index but NEVER the offending string", () => {
    // The PII codec calls `canonicalizeJson(input.piiPayload)` directly, so this guard runs over
    // PII plaintext and its message reaches logs. The locator must not quote the value.
    const secret = `patient-record-4417-${LONE_HIGH_SURROGATE}`;
    const message = captureThrownMessage(() => canonicalizeJson({ note: secret }));
    expect(message).toMatch(/\(U\+D800\) at index 20/);
    expect(message).not.toContain("patient-record-4417");
    expect(message).not.toContain(LONE_HIGH_SURROGATE);
  });

  it("refuses a lone surrogate that a clean parse of the wire schema admits", () => {
    // Shows the guard is reachable. `"\ud800"` is a six-ASCII-character escape in the wire text,
    // so the ill-formed value rides inside a well-formed JSON document and `JSON.parse` then
    // produces the lone surrogate. Nothing upstream objects: `wireFreeFormString` bounds length
    // and rejects NUL and whitespace-only strings but checks no well-formedness, and `payload` is
    // an open record. The envelope parses, and the canonicalizer is the only refusal.
    const wireText = JSON.stringify({ ...GOLDEN_ENVELOPE, actor: LONE_HIGH_SURROGATE });
    const parsed: unknown = JSON.parse(wireText);
    const parseResult = EventEnvelopeSchema.safeParse(parsed);
    expect(parseResult.success).toBe(true);
    expect(() => canonicalizeEvent(parsed as EventEnvelope)).toThrow(LONE_SURROGATE_REFUSAL);
  });

  it("runs AFTER the depth ceiling, so a cyclic graph still refuses instead of hanging", () => {
    // The well-formedness walk has no cycle detection or depth bound, so on a cyclic graph it
    // would spin forever; it is safe only because `assertWithinCanonicalDepth` throws first. This
    // input is cyclic and holds a lone surrogate, so reversing the two guards in
    // `canonicalizeJson` turns this test from a refusal into a hang.
    const cyclic: Record<string, unknown> = { field: LONE_HIGH_SURROGATE };
    cyclic["self"] = cyclic;
    const message = captureThrownMessage(() => canonicalizeJson(cyclic));
    expect(message).toMatch(/nests containers deeper than 64 levels/);
    expect(message).not.toMatch(LONE_SURROGATE_REFUSAL);
  });

  it("reports the sequence refusal ahead of a simultaneous lone surrogate", () => {
    // Refusal order on this entry point is sequence, occurredAt, depth, toJSON, well-formedness;
    // the caller sees only the first to fire.
    const message = captureThrownMessage(() =>
      canonicalizeEvent({
        ...GOLDEN_ENVELOPE,
        sequence: 9007199254740992,
        actor: LONE_HIGH_SURROGATE,
      }),
    );
    expect(message).toMatch(/canonicalization refused: sequence .* is not a safe integer/);
    expect(message).not.toMatch(LONE_SURROGATE_REFUSAL);
  });
});

// `canonicalize@3.0.0` serializes whatever a callable `toJSON` returns, an uninspected tree, so
// `canonicalizeJson` refuses the whole class.
const TO_JSON_REFUSAL = /canonicalization refused: .* carries a callable toJSON/;

describe("canonicalizeJson — refuses a callable toJSON", () => {
  it("refuses a top-level callable toJSON, closing that bypass", () => {
    const message = captureThrownMessage(() =>
      canonicalizeJson({ toJSON: () => ({ a: LONE_HIGH_SURROGATE }) }),
    );
    expect(message).toMatch(TO_JSON_REFUSAL);
    expect(message).toMatch(/the top-level value/);
  });

  it("locates the offender by NESTING DEPTH and never by property path", () => {
    // Like `assertNoLoneSurrogate`: the PII codec calls `canonicalizeJson(input.piiPayload)`
    // directly, so property names are caller data and this message reaches logs. Depth is
    // structure, which the depth refusal already discloses.
    const message = captureThrownMessage(() =>
      canonicalizeJson({ record: { "patient-record-4417": new Date(0) } }),
    );
    expect(message).toMatch(TO_JSON_REFUSAL);
    expect(message).toMatch(/nested 2 containers deep/);
    expect(message).not.toContain("patient-record-4417");
    expect(message).not.toContain("1970-01-01");
  });

  it("costs one more getter invocation per member — the count the module documents", () => {
    // `assertWithinCanonicalDepth`'s docblock states six invocations of an own enumerable getter
    // end to end: one per walk (depth, `toJSON`, well-formedness) and three inside the
    // serializer's per-member `undefined` / `symbol` / recurse sequence. A non-idempotent getter
    // is the one residual the `toJSON` refusal does not close, so this count bounds how many
    // different trees it can hand out.
    let accessorCalls = 0;
    const withGetter: Record<string, unknown> = {
      get member(): unknown {
        accessorCalls += 1;
        return "value";
      },
    };
    expect(decodeUtf8(canonicalizeJson(withGetter))).toBe('{"member":"value"}');
    expect(accessorCalls).toBe(6);
  });

  it("runs AFTER the depth ceiling, so a cyclic graph still refuses instead of hanging", () => {
    // This walk has no cycle detection either, so it is safe only because
    // `assertWithinCanonicalDepth` reports a cycle as depth exhaustion first. The input is cyclic
    // and has a `toJSON`, so moving this guard above the depth walk turns a refusal into a hang.
    const cyclic: Record<string, unknown> = { toJSON: (): unknown => ({ v: 1 }) };
    cyclic["self"] = cyclic;
    const message = captureThrownMessage(() => canonicalizeJson(cyclic));
    expect(message).toMatch(/nests containers deeper than 64 levels/);
    expect(message).not.toMatch(TO_JSON_REFUSAL);
  });

  it("runs BEFORE the well-formedness walk, so the accurate refusal is the one reported", () => {
    // The lone surrogate sits in a subtree the serializer would discard, because `toJSON`
    // replaces it, so reporting it would be wrong. The `toJSON` refusal makes the well-formedness
    // verdict a statement about the output, so it must fire first.
    const carriesBoth = {
      discarded: LONE_HIGH_SURROGATE,
      toJSON: (): unknown => ({ kept: "well-formed" }),
    };
    const message = captureThrownMessage(() => canonicalizeJson(carriesBoth));
    expect(message).toMatch(TO_JSON_REFUSAL);
    expect(message).not.toMatch(LONE_SURROGATE_REFUSAL);
  });

  it("SHADOWS the library's third refusal in both shapes that could reach it", () => {
    // `Circular reference detected` is the third library throw the module header lists. No
    // ordinary input reaches it, and a regression in either guard would surface it.
    //
    // Shape 1: an own-property cycle drives the depth walk past the ceiling, so this module's
    // depth refusal fires first.
    const ownPropertyCycle: Record<string, unknown> = {};
    ownPropertyCycle["self"] = ownPropertyCycle;
    expect(captureThrownMessage(() => canonicalizeJson(ownPropertyCycle))).not.toBe(
      "Circular reference detected",
    );

    // Shape 2: a cycle reachable only through a `toJSON` result is invisible to both walks
    // (`toJSON` is a function, so it fails their `typeof === "object"` child filter). The
    // `toJSON` refusal catches the carrier before any serialization runs.
    const cycleReachableOnlyViaToJson: { toJSON: () => unknown } = {
      toJSON: () => ({ nested: cycleReachableOnlyViaToJson }),
    };
    const message = captureThrownMessage(() => canonicalizeJson(cycleReachableOnlyViaToJson));
    expect(message).toMatch(TO_JSON_REFUSAL);
    expect(message).not.toBe("Circular reference detected");

    // Residual case: a non-idempotent accessor hands the guards one tree and the serializer
    // another, so the library's cycle detection is the last line for that shape alone.
    // `canonicalizeJson` runs three walks before serializing (depth, `toJSON`, well-formedness),
    // so a getter that turns cyclic on call 4 shows every guard an acyclic tree and the
    // serializer a cyclic one. The threshold is the walk count from the six-invocation test.
    let accessorCalls = 0;
    const nonIdempotentAccessor: Record<string, unknown> = {
      get member(): unknown {
        accessorCalls += 1;
        return accessorCalls > 3 ? nonIdempotentAccessor : { acyclic: true };
      },
    };
    expect(captureThrownMessage(() => canonicalizeJson(nonIdempotentAccessor))).toBe(
      "Circular reference detected",
    );
  });

  it("is inherited by canonicalizeEvent through the payload", () => {
    // The event entry point routes through `canonicalizeJson`, so the guard covers it. A `Date`
    // in a payload is the realistic carrier: a producer reaches for it for a timestamp member.
    expect(() =>
      canonicalizeEvent({
        ...GOLDEN_ENVELOPE,
        payload: { ...GOLDEN_ENVELOPE.payload, recordedAt: new Date(0) },
      }),
    ).toThrow(TO_JSON_REFUSAL);
    // The sequence guard still comes first: sequence, occurredAt, depth, toJSON, well-formedness.
    const message = captureThrownMessage(() =>
      canonicalizeEvent({
        ...GOLDEN_ENVELOPE,
        sequence: 9007199254740992,
        payload: { ...GOLDEN_ENVELOPE.payload, recordedAt: new Date(0) },
      }),
    );
    expect(message).toMatch(/canonicalization refused: sequence .* is not a safe integer/);
    expect(message).not.toMatch(TO_JSON_REFUSAL);
  });
});

const OCCURRED_AT_NORMALIZATIONS: ReadonlyArray<{
  readonly input: string;
  readonly normalized: string;
  readonly why: string;
}> = [
  {
    input: "2026-01-01T00:00Z",
    normalized: "2026-01-01T00:00:00.000Z",
    why: "omitted seconds expand instant-preserved",
  },
  {
    input: "2025-12-31T19:00:00-05:00",
    normalized: "2026-01-01T00:00:00.000Z",
    why: "negative offset folds across a year boundary",
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
    why: "RFC 3339 section 5.6 permits lowercase t, but the wire schema does not",
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
      // Both directions: the expected refusal fires and the neighboring one does not, so two
      // merged refusal messages would fail here.
      const message = captureThrownMessage(() => normalizeOccurredAt(vector.input));
      expect(message).toMatch(vector.expected);
      expect(message).not.toMatch(vector.rejected);
    });
  }

  it("reports sub-millisecond precision BEFORE calendar validity — check order is observable", () => {
    // This input trips both the sub-millisecond guard and the calendar-existence guard;
    // `normalizeOccurredAt` runs the sub-millisecond guard first, so only that message appears.
    // The single-fault rows in the refusal table above show each guard fires on its own input,
    // so this test shows order, not a broken calendar guard.
    const message = captureThrownMessage(() => normalizeOccurredAt("2026-02-30T00:00:00.0001Z"));
    expect(message).toMatch(/carries sub-millisecond precision/);
    expect(message).not.toMatch(/does not exist on the calendar/);
  });

  it("is idempotent — the canonical form is a fixed point of every branch", () => {
    // A stored row must re-canonicalize to the same bytes whether the append path persisted the
    // raw or the normalized string.
    for (const vector of OCCURRED_AT_NORMALIZATIONS) {
      const onceNormalized = normalizeOccurredAt(vector.input);
      expect(normalizeOccurredAt(onceNormalized)).toBe(onceNormalized);
    }
  });
});

// Sequence ceiling: the canonical bytes must stay injective.
//
// `canonicalizeEvent` does not parse. Every other bound on `sequence` lives on
// `EventEnvelopeSchema`, so an in-process caller that builds an `EventEnvelope` literal (the type
// permits it, `sequence` being a plain `number`) meets no schema at all; the guard therefore
// sits at the canonicalizer. Above 2^53 - 1 distinct integers share one IEEE-754 double, so two
// events would canonicalize to identical bytes and share one replay key.

describe("canonicalizeEvent — sequence must be faithfully representable", () => {
  const sequenceRefusalPattern = /canonicalization refused: sequence .* is not a safe integer/;

  it("refuses the collapsed pair that would otherwise share canonical bytes", () => {
    // Why the guard exists, in three steps.
    //
    // Step 1: the collapse is reachable on the read path. `session_events.sequence` is a 64-bit
    // SQLite INTEGER; `SessionService` reads it with `safeIntegers(true)` so it arrives as a
    // `bigint`, and `hydrateRow` narrows it with `Number(row.sequence)`. Two distinct stored rows
    // land on one number.
    const collapsedLower = Number(9007199254740992n);
    const collapsedUpper = Number(9007199254740993n);
    expect(collapsedUpper).toBe(collapsedLower);

    // Step 2: the generic serializer is correct to emit the collapsed value. RFC 8785
    // canonicalizes the double it is handed and cannot know two integers produced it, so the
    // guard cannot live in `canonicalizeJson`.
    expect(bytesToHex(canonicalizeJson({ sequence: collapsedLower }))).toBe(
      bytesToHex(canonicalizeJson({ sequence: collapsedUpper })),
    );

    // Step 3: the refusal has to happen where the value is still known to be an event's
    // `sequence`. Both members of the collapsed pair are refused.
    expect(() => canonicalizeEvent({ ...GOLDEN_ENVELOPE, sequence: collapsedLower })).toThrow(
      sequenceRefusalPattern,
    );
    expect(() => canonicalizeEvent({ ...GOLDEN_ENVELOPE, sequence: collapsedUpper })).toThrow(
      sequenceRefusalPattern,
    );
  });

  it("keeps the daemon guard and the contract ceiling on the same boundary", () => {
    // `canonicalizer.ts` does not import `EVENT_ENVELOPE_SEQUENCE_MAX`; it enforces
    // `Number.isSafeInteger`, the property the bytes need, and a shared import would make the two
    // agree even on a wrong value. This checks that the schema and the canonicalizer flip at the
    // same integer.
    const atCeiling = EVENT_ENVELOPE_SEQUENCE_MAX;
    const oneAbove = EVENT_ENVELOPE_SEQUENCE_MAX + 1;

    expect(EventEnvelopeSchema.safeParse({ ...GOLDEN_ENVELOPE, sequence: atCeiling }).success).toBe(
      true,
    );
    expect(() => canonicalizeEvent({ ...GOLDEN_ENVELOPE, sequence: atCeiling })).not.toThrow();

    expect(EventEnvelopeSchema.safeParse({ ...GOLDEN_ENVELOPE, sequence: oneAbove }).success).toBe(
      false,
    );
    expect(() => canonicalizeEvent({ ...GOLDEN_ENVELOPE, sequence: oneAbove })).toThrow(
      sequenceRefusalPattern,
    );
  });

  it("reports the sequence refusal ahead of a simultaneous occurredAt defect", () => {
    // Refusal order is observable, so `canonicalizeEvent` fixes it. This envelope trips both the
    // sequence guard and `normalizeOccurredAt`'s sub-millisecond refusal.
    const message = captureThrownMessage(() =>
      canonicalizeEvent({
        ...GOLDEN_ENVELOPE,
        sequence: 9007199254740992,
        occurredAt: "2026-03-04T05:06:07.0081Z",
      }),
    );
    expect(message).toMatch(sequenceRefusalPattern);
    expect(message).not.toMatch(/sub-millisecond|millisecond precision/);
  });
});
