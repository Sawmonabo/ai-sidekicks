// Plan-006 T3.3 — `event-anchor.ts` contract coverage.
//
// Two cites drive this file, and each owns a describe block below:
//
//   * Spec coverage — `Spec-006 §Anchoring Cadence`: the anchor payload is
//     "(session_id, node_id, start_sequence, end_sequence, merkle_root,
//     root_signature, anchored_at) — metadata only". The member set is
//     asserted EXACTLY, in both directions (a member the schema stopped
//     carrying, and a member the schema started carrying).
//   * Verifies invariant — I-006-3-02 (metadata-only witness; ADR-017 rejected
//     a shared event log for V1). The three named negative arms — `payload`,
//     `events`, `pii_payload` — are the shapes that would carry event bytes to
//     the control plane, and each must be REFUSED, not silently stripped.
//
// The daemon-side `MerkleAnchorService` behavior (cadence, force-fire, queue
// idempotency) is Plan-006 T3.5's file set; this file covers the wire contract
// only.
//
// Refs: Plan-006 T3.3, ADR-017,
// `docs/architecture/schemas/shared-postgres-schema.md` §Event Log Anchors
// (Plan-006 — Integrity Witness).

import { describe, expect, it } from "vitest";

import {
  AnchorPayloadSchema,
  EventAnchorUploadRequestSchema,
  EventAnchorUploadResponseSchema,
  MERKLE_ROOT_BYTE_LENGTH,
  ROOT_SIGNATURE_BYTE_LENGTH,
  type AnchorPayload,
} from "../event-anchor.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

function base64OfZeroBytes(byteLength: number): string {
  return Buffer.alloc(byteLength).toString("base64");
}

const VALID_MERKLE_ROOT: string = base64OfZeroBytes(MERKLE_ROOT_BYTE_LENGTH);
const VALID_ROOT_SIGNATURE: string = base64OfZeroBytes(ROOT_SIGNATURE_BYTE_LENGTH);

// A structurally valid anchor. Spread-and-override in each test so a single
// field is the variable under test and the other six stay known-good.
const VALID_ANCHOR = {
  sessionId: "01970000-0000-7000-8000-00000000a001",
  nodeId: "node-alpha",
  startSequence: 1,
  endSequence: 1000,
  merkleRoot: VALID_MERKLE_ROOT,
  rootSignature: VALID_ROOT_SIGNATURE,
  anchoredAt: "2026-08-04T12:00:00.000Z",
} as const;

// ----------------------------------------------------------------------------
// Spec-006 §Anchoring Cadence — the seven-member payload
// ----------------------------------------------------------------------------

describe("AnchorPayload — the seven-member metadata payload (Spec-006 §Anchoring Cadence)", () => {
  it("accepts the canonical seven-member anchor", () => {
    const result = AnchorPayloadSchema.safeParse(VALID_ANCHOR);
    expect(result.success).toBe(true);
  });

  it("carries EXACTLY the seven columns of the canonical event_log_anchors DDL", () => {
    const parsed: AnchorPayload = AnchorPayloadSchema.parse(VALID_ANCHOR);

    // The schema's runtime output shape. `.strict()` passes through only
    // declared members, so this key set IS the schema's member set — a member
    // dropped from the schema surfaces here even though the interface still
    // declares it.
    expect(Object.keys(parsed).sort()).toEqual([
      "anchoredAt",
      "endSequence",
      "merkleRoot",
      "nodeId",
      "rootSignature",
      "sessionId",
      "startSequence",
    ]);
  });

  it("pins the member set at the TYPE level too (interface-vs-schema drift)", () => {
    // The runtime assertion above catches a SCHEMA change. This one catches an
    // INTERFACE change: `Record<keyof AnchorPayload, true>` is exhaustive, so
    // adding a member to `AnchorPayload` without adding it here is a compile
    // error — which is what a `payload` member sneaking onto the interface
    // would be. Together the two assertions close both directions.
    const everyMember: Record<keyof AnchorPayload, true> = {
      sessionId: true,
      nodeId: true,
      startSequence: true,
      endSequence: true,
      merkleRoot: true,
      rootSignature: true,
      anchoredAt: true,
    };
    expect(Object.keys(everyMember)).toHaveLength(7);
  });

  it("rejects an anchor missing any one of the seven members", () => {
    for (const member of Object.keys(VALID_ANCHOR)) {
      const incomplete: Record<string, unknown> = { ...VALID_ANCHOR };
      delete incomplete[member];
      const result = AnchorPayloadSchema.safeParse(incomplete);
      expect(result.success, `omitting \`${member}\` must be refused`).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// I-006-3-02 — metadata-only, structurally enforced
// ----------------------------------------------------------------------------

describe("I-006-3-02 — the anchor is metadata-only (ADR-017: no shared event log in V1)", () => {
  // The three named shapes from the T3.3 acceptance criteria. Each is a way
  // event content could ride an anchor to the control plane; each must fail
  // the parse rather than be silently dropped, because a silent strip leaves
  // a caller believing it uploaded data that never arrived AND leaves the
  // invariant asserted by nothing.
  for (const smuggledMember of ["payload", "events", "pii_payload"] as const) {
    it(`REFUSES an anchor carrying \`${smuggledMember}\` (not a silent strip)`, () => {
      const result = AnchorPayloadSchema.safeParse({
        ...VALID_ANCHOR,
        [smuggledMember]: { secret: "event bytes that must never reach the control plane" },
      });
      expect(result.success).toBe(false);
    });
  }

  it("refuses ANY unknown member, not just the three named ones", () => {
    // `.strict()` is a general guard: the three arms above name the shapes the
    // invariant calls out, but a future leak would arrive under some other
    // name, so the general property is the one worth pinning.
    const result = AnchorPayloadSchema.safeParse({
      ...VALID_ANCHOR,
      someFutureMemberNobodyReviewed: "x",
    });
    expect(result.success).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Byte-width + range constraints
// ----------------------------------------------------------------------------

describe("AnchorPayload — the commitment fields decode to their DDL-pinned widths", () => {
  it("requires merkleRoot to decode to exactly 32 bytes", () => {
    expect(MERKLE_ROOT_BYTE_LENGTH).toBe(32);
    for (const wrongWidth of [31, 33, 0, 64]) {
      const result = AnchorPayloadSchema.safeParse({
        ...VALID_ANCHOR,
        merkleRoot: base64OfZeroBytes(wrongWidth),
      });
      expect(result.success, `${wrongWidth}-byte merkleRoot must be refused`).toBe(false);
    }
  });

  it("requires rootSignature to decode to exactly 64 bytes", () => {
    expect(ROOT_SIGNATURE_BYTE_LENGTH).toBe(64);
    for (const wrongWidth of [63, 65, 0, 32]) {
      const result = AnchorPayloadSchema.safeParse({
        ...VALID_ANCHOR,
        rootSignature: base64OfZeroBytes(wrongWidth),
      });
      expect(result.success, `${wrongWidth}-byte rootSignature must be refused`).toBe(false);
    }
  });

  it("refuses a non-base64 commitment field WITHOUT throwing out of safeParse", () => {
    // Length-only validation would accept 44 characters of garbage, so the
    // charset check is what makes the decode meaningful. The `safeParse`
    // wrapper is the second half of the assertion: zod aggregates checks
    // rather than short-circuiting, so the byte-width refinement also runs on
    // this input and `atob` throws on it — a regression that dropped the
    // decode guard surfaces here as a raw DOMException escaping the call that
    // promised not to throw, which `.success === false` alone would not catch.
    let result: ReturnType<typeof AnchorPayloadSchema.safeParse> | undefined;
    expect(() => {
      result = AnchorPayloadSchema.safeParse({ ...VALID_ANCHOR, merkleRoot: "!".repeat(44) });
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });

  it("refuses base64url spelling of an otherwise correct root", () => {
    // The two alphabets are NOT interchangeable on this wire: the control
    // plane decodes with the standard alphabet, so a `-`/`_` spelling would
    // decode to different bytes (or fail to decode). Accepting it here would
    // let two spellings of "the same" root disagree about what was signed.
    //
    // The leading `0xFB 0xFF 0xFF` is chosen so the standard encoding contains
    // BOTH `+` (sextet 62) and `/` (sextet 63) — an all-zero or evenly-spaced
    // byte pattern encodes to alphanumerics only, and the two spellings would
    // then be identical, making this test vacuous.
    const bytes = new Uint8Array(32);
    bytes[0] = 0xfb;
    bytes[1] = 0xff;
    bytes[2] = 0xff;
    const standard = Buffer.from(bytes).toString("base64");
    expect(standard).toContain("+");
    expect(standard).toContain("/");

    const urlSafe = standard.replaceAll("+", "-").replaceAll("/", "_");
    const result = AnchorPayloadSchema.safeParse({ ...VALID_ANCHOR, merkleRoot: urlSafe });
    expect(result.success).toBe(false);
  });

  it("enforces endSequence >= startSequence (mirrors the DDL CHECK)", () => {
    const inverted = AnchorPayloadSchema.safeParse({
      ...VALID_ANCHOR,
      startSequence: 1000,
      endSequence: 999,
    });
    expect(inverted.success).toBe(false);

    // A single-row anchor is a legitimate range, not a degenerate one: the
    // force-fire path anchors exactly one row when a compaction range is one
    // row wide.
    const singleRow = AnchorPayloadSchema.safeParse({
      ...VALID_ANCHOR,
      startSequence: 7,
      endSequence: 7,
    });
    expect(singleRow.success).toBe(true);
  });

  it("refuses a non-integer, negative, or unsafe range endpoint", () => {
    for (const badEndpoint of [1.5, -1, Number.MAX_SAFE_INTEGER + 2]) {
      const result = AnchorPayloadSchema.safeParse({
        ...VALID_ANCHOR,
        startSequence: 0,
        endSequence: badEndpoint,
      });
      expect(result.success, `endSequence ${badEndpoint} must be refused`).toBe(false);
    }
  });

  it("requires anchoredAt to carry an explicit UTC offset", () => {
    // A naked local timestamp is ambiguous across the daemon's and the control
    // plane's timezones, and the two stored copies of the anchor are meant to
    // be byte-comparable.
    const naked = AnchorPayloadSchema.safeParse({
      ...VALID_ANCHOR,
      anchoredAt: "2026-08-04T12:00:00.000",
    });
    expect(naked.success).toBe(false);

    const offset = AnchorPayloadSchema.safeParse({
      ...VALID_ANCHOR,
      anchoredAt: "2026-08-04T07:00:00.000-05:00",
    });
    expect(offset.success).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// The `eventanchor.upload` request/response pair
// ----------------------------------------------------------------------------

describe("eventanchor.upload wire pair", () => {
  it("the upload request IS the anchor payload schema (one contract, both ends)", () => {
    // Identity, not merely equivalence: the daemon signs what the control
    // plane parses. Two separately-declared schemas could drift apart while
    // both still passing their own tests.
    expect(EventAnchorUploadRequestSchema).toBe(AnchorPayloadSchema);
  });

  it("the upload response reports the two idempotent-success arms", () => {
    expect(EventAnchorUploadResponseSchema.parse({ stored: true })).toEqual({ stored: true });
    expect(EventAnchorUploadResponseSchema.parse({ stored: false })).toEqual({ stored: false });
    expect(EventAnchorUploadResponseSchema.safeParse({ stored: true, rowId: "x" }).success).toBe(
      false,
    );
    expect(EventAnchorUploadResponseSchema.safeParse({}).success).toBe(false);
  });
});
