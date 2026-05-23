// Plan-002 Phase 1 T1.4 — `channels.ts` schema tests.
//
// Backstops the C5 acceptance criterion (Plan-002 §C5, Spec-002 line 87):
// `ChannelList` request/response shape parses the read-only projection of
// channels in a session per the canonical wire form at
// docs/architecture/contracts/api-payload-contracts.md lines 438-450.
//
// Test surface enumerated (the "what" each block pins):
//   * ChannelStateSchema wire-form pin — exactly the 3 canonical lowercase
//     literals `{active, muted, archived}` per Spec-002 line 87 (referenced
//     in the `state: ChannelState` field) + api-payload-contracts.md:166.
//     `"deleted"` / `"pending"` rejected (drift defense).
//   * Re-exports — `ChannelIdSchema`, `SessionIdSchema`, `ChannelStateSchema`
//     branded UUID + enum guards round-trip from session.ts (anti-cosmetic
//     check — a typo in `export { ... } from "./session.js"` would only
//     surface as a downstream typecheck failure).
//   * ChannelListRequestSchema happy path + missing/malformed/.strict() guards.
//   * ChannelListResponseChannelSchema (per-element) — all required fields
//     present (without `name`), all required + optional `name`,
//     missing-field rejections, malformed-id rejection, invalid-state
//     rejection, `participantCount` int/non-negative/NaN/string rejection,
//     `name` length boundaries, `name` NUL-byte and whitespace-only
//     wireFreeFormString guards, `.strict()` per-element anti-leakage.
//   * ChannelListResponseSchema (outer) — empty list, one element, multiple
//     elements, missing `channels`, non-array `channels`, `.strict()` outer
//     anti-leakage.
//
// Coverage shape mirrors presence.test.ts and invites.test.ts.
import { describe, expect, it } from "vitest";

import {
  CHANNEL_NAME_MAX_LEN,
  ChannelIdSchema,
  ChannelListRequestSchema,
  ChannelListResponseChannelSchema,
  ChannelListResponseSchema,
  ChannelStateSchema,
  SessionIdSchema,
  type ChannelState,
} from "../channels.js";

// Real RFC 9562 UUIDs (mix of v4 and v7). z.uuid() validates the version
// nibble + variant bits in canonical positions; mismatch is rejected at the
// branded-id schema layer.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const CHANNEL_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f02";
const SECOND_CHANNEL_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f03";
const THIRD_CHANNEL_ID = "660e8400-e29b-41d4-a716-446655440004";

// Fixture returns a wire-shaped object without per-field brand casts —
// safeParse accepts plain UUID strings and brands them on the way out.
// The schema (not the type system) is the unit under test, so feeding raw
// wire data is the natural test surface. Mirrors the presence.test.ts pattern.
const buildValidChannelElement = () => ({
  id: CHANNEL_ID,
  name: "general",
  state: "active" as ChannelState,
  participantCount: 3,
});

// =============================================================================
// Re-exports from session.ts — branded UUID + enum guards
// =============================================================================
//
// Anti-cosmetic: a typo in the `export { ChannelIdSchema, ... }` line would
// otherwise only surface as a downstream consumer typecheck failure at PR
// review time. Mirrors the pattern in presence.test.ts:91.

describe("ChannelIdSchema / SessionIdSchema (re-exported from session.ts)", () => {
  it("ChannelIdSchema parses a valid UUID", () => {
    expect(ChannelIdSchema.parse(CHANNEL_ID)).toBe(CHANNEL_ID);
  });

  it("SessionIdSchema parses a valid UUID", () => {
    expect(SessionIdSchema.parse(SESSION_ID)).toBe(SESSION_ID);
  });

  it.each([
    ["ChannelIdSchema", ChannelIdSchema],
    ["SessionIdSchema", SessionIdSchema],
  ])("%s rejects malformed UUID", (_label, schema) => {
    expect(schema.safeParse("not-a-uuid").success).toBe(false);
  });
});

// =============================================================================
// ChannelStateSchema — canonical lifecycle enum
// (api-payload-contracts.md:166 — re-exported from session.ts:189-190)
// =============================================================================
//
// Spec-002 line 87 + api-payload-contracts.md:166 bind the wire form to
// EXACTLY three lowercase literals. Adding `"deleted"` / `"pending"` /
// `"draft"` here is a contract break requiring the spec edit FIRST per
// doc-first ordering.

describe("ChannelStateSchema (wire form is exactly {active, muted, archived})", () => {
  const EXPECTED_STATES = ["active", "muted", "archived"] as const;

  it("enumerates exactly three canonical states (no more, no less)", () => {
    // Read `.options` from the underlying enum construct. The schema is
    // typed as the abstract `z.ZodType<ChannelState>` so we cast via
    // `unknown` to read the construct-specific `.options` property; the
    // assertions below check both length AND exact set membership.
    const schemaInternals = ChannelStateSchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toHaveLength(3);
    expect([...schemaInternals.options].sort()).toEqual([...EXPECTED_STATES].sort());
  });

  it.each(EXPECTED_STATES)("accepts canonical state: %s", (state) => {
    expect(ChannelStateSchema.safeParse(state).success).toBe(true);
  });

  it.each([
    ["deleted (contract break — not in canonical set)", "deleted"],
    ["pending (contract break — not in canonical set)", "pending"],
    ["draft (contract break — not in canonical set)", "draft"],
    ["closed (contract break — closed is a SessionState, not ChannelState)", "closed"],
    ["empty string", ""],
    ["null", null],
    ["number", 1],
  ])("rejects non-canonical value: %s", (_label, value) => {
    expect(ChannelStateSchema.safeParse(value).success).toBe(false);
  });
});

// =============================================================================
// C5 — ChannelListRequestSchema (Spec-002 line 87)
// =============================================================================
//
// Spec-002 line 87 verbatim: "Request: `{sessionId: SessionId}`". Single
// required field; .strict() rejects unknown keys at the outer envelope.

describe("ChannelListRequestSchema (C5: sessionId-only request per Spec-002 line 87)", () => {
  it("accepts a request with sessionId only", () => {
    const parsed = ChannelListRequestSchema.parse({ sessionId: SESSION_ID });
    expect(parsed.sessionId).toBe(SESSION_ID);
  });

  it("rejects request missing sessionId (with the field name surfaced in the issue path)", () => {
    const result = ChannelListRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("sessionId");
    }
  });

  it("rejects request with malformed sessionId (UUID guard composes from SessionIdSchema)", () => {
    expect(ChannelListRequestSchema.safeParse({ sessionId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects request with non-string sessionId", () => {
    expect(ChannelListRequestSchema.safeParse({ sessionId: 42 }).success).toBe(false);
  });

  it("rejects extraneous top-level keys (.strict() guard matches session.ts convention)", () => {
    const broken = { sessionId: SESSION_ID, extra: "leak" };
    expect(ChannelListRequestSchema.safeParse(broken).success).toBe(false);
  });
});

// =============================================================================
// C5 — ChannelListResponseChannelSchema (per-element projection)
// =============================================================================
//
// Spec-002 line 87 verbatim: "Response: `{channels: Array<{id: ChannelId,
// name?: string, state: ChannelState, participantCount: number}>}`". This
// describe block exercises the per-element shape; the next describe block
// covers the outer envelope.
//
// Per-element invariants:
//   * `id`, `state`, `participantCount` are REQUIRED at parse time.
//   * `name` is OPTIONAL (the `?` is verbatim per Spec-002:87) — the
//     bootstrap default channel may have no friendly label; the wire
//     signal for "no name" is KEY ABSENT.
//   * `participantCount` is non-negative integer (`.int().nonnegative()`
//     enforces both guards; the canonical wire-form gloss `number` is
//     imprecise about JSON's int-vs-float ambiguity).
//   * `.strict()` rejects unknown keys per the package anti-leakage stance.

describe("ChannelListResponseChannelSchema (per-element projection)", () => {
  // --------------------------------------------------------------------
  // Happy paths — REQUIRED-fields-only AND REQUIRED + optional `name`
  // --------------------------------------------------------------------

  it("accepts a minimal element (id, state, participantCount — no `name` key)", () => {
    const payload = { id: CHANNEL_ID, state: "active" as ChannelState, participantCount: 0 };
    const parsed = ChannelListResponseChannelSchema.parse(payload);
    expect(parsed.id).toBe(CHANNEL_ID);
    expect(parsed.state).toBe("active");
    expect(parsed.participantCount).toBe(0);
    expect(parsed.name).toBeUndefined();
  });

  it("accepts a fully-populated element (all required + optional `name`)", () => {
    const parsed = ChannelListResponseChannelSchema.parse(buildValidChannelElement());
    expect(parsed.id).toBe(CHANNEL_ID);
    expect(parsed.name).toBe("general");
    expect(parsed.state).toBe("active");
    expect(parsed.participantCount).toBe(3);
  });

  it.each(["active", "muted", "archived"] as const)(
    "accepts every canonical state: %s",
    (state) => {
      const payload = { ...buildValidChannelElement(), state };
      expect(ChannelListResponseChannelSchema.safeParse(payload).success).toBe(true);
    },
  );

  // --------------------------------------------------------------------
  // Required-field guards — id / state / participantCount
  // --------------------------------------------------------------------

  it.each(["id", "state", "participantCount"] as const)(
    "rejects element missing required field: %s (with the field name surfaced in the issue path)",
    (field) => {
      const valid = buildValidChannelElement();
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      const result = ChannelListResponseChannelSchema.safeParse(broken);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path.join("."));
        expect(paths).toContain(field);
      }
    },
  );

  it("accepts an element with `name` ABSENT (bootstrap default channel may be unnamed)", () => {
    const { name: _omitted, ...withoutName } = buildValidChannelElement();
    const parsed = ChannelListResponseChannelSchema.parse(withoutName);
    expect(parsed.name).toBeUndefined();
  });

  // --------------------------------------------------------------------
  // Field-level type guards — UUID composability, enum composability
  // --------------------------------------------------------------------

  it("rejects element with malformed id (UUID guard composes from ChannelIdSchema)", () => {
    const broken = { ...buildValidChannelElement(), id: "not-a-uuid" };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects element with unknown state (composes from ChannelStateSchema)", () => {
    const broken = { ...buildValidChannelElement(), state: "deleted" };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  // --------------------------------------------------------------------
  // participantCount — int + non-negative + NaN/Infinity/string rejection
  // --------------------------------------------------------------------
  //
  // `participantCount` is a count (cardinality of a set), so it must be a
  // non-negative integer. Pin every drift mode: negative int, float,
  // NaN, Infinity, string. The canonical wire-form gloss `number` is
  // imprecise; `.int().nonnegative()` is the contract-layer enforcement.

  it("accepts participantCount of 0 (empty channel — no active participants)", () => {
    const payload = { ...buildValidChannelElement(), participantCount: 0 };
    expect(ChannelListResponseChannelSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts participantCount of large positive integer", () => {
    const payload = { ...buildValidChannelElement(), participantCount: 10_000 };
    expect(ChannelListResponseChannelSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects negative participantCount: -1 (counts cannot be negative)", () => {
    const broken = { ...buildValidChannelElement(), participantCount: -1 };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects float participantCount: 1.5 (counts must be integers; JSON's number type is imprecise)", () => {
    const broken = { ...buildValidChannelElement(), participantCount: 1.5 };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects NaN participantCount (z.number() guard excludes NaN)", () => {
    const broken = { ...buildValidChannelElement(), participantCount: Number.NaN };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  // ±Infinity rejection — in Zod v4, `z.number()` validates FINITE numbers
  // only and rejects both `+Infinity` and `-Infinity` by default (NOT
  // `.int()`, which is a common Zod v3 mental-model trap — see channels.ts
  // file header for the full attribution rationale).
  it.each([
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])(
    "rejects %s participantCount (z.number() rejects non-finite numbers)",
    (_label, infinityValue) => {
      const broken = { ...buildValidChannelElement(), participantCount: infinityValue };
      expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("rejects string participantCount: '5' (no implicit coercion at the wire layer)", () => {
    const broken = { ...buildValidChannelElement(), participantCount: "5" };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  // --------------------------------------------------------------------
  // name — length boundary + wireFreeFormString trust-boundary guards
  // --------------------------------------------------------------------
  //
  // Pin both the inclusive accept (= CHANNEL_NAME_MAX_LEN) and the strict
  // reject (= CHANNEL_NAME_MAX_LEN + 1). Mirrors the convention in
  // presence.test.ts:434-462 and invites.test.ts:216-219. Guards against
  // silent widening — a future PR that bumps the constant without intent
  // will fail these tests.

  it("accepts element with `name` at CHANNEL_NAME_MAX_LEN (boundary)", () => {
    const ok = { ...buildValidChannelElement(), name: "x".repeat(CHANNEL_NAME_MAX_LEN) };
    expect(ChannelListResponseChannelSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects element with `name` at CHANNEL_NAME_MAX_LEN + 1 (boundary)", () => {
    const broken = { ...buildValidChannelElement(), name: "x".repeat(CHANNEL_NAME_MAX_LEN + 1) };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects element with empty `name` (wireFreeFormString .min(1) guard)", () => {
    const broken = { ...buildValidChannelElement(), name: "" };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects element with whitespace-only `name` (wireFreeFormString /\\S/ guard)", () => {
    const broken = { ...buildValidChannelElement(), name: "   " };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects element with NUL byte in `name` (wireFreeFormString log-injection guard)", () => {
    // NUL bytes corrupt OpenTelemetry log lines / structured trace output
    // (NUL terminates string serialization at the observability layer).
    // The wire layer is exactly where this trust boundary lives.
    const broken = { ...buildValidChannelElement(), name: "chan\0nel" };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  // --------------------------------------------------------------------
  // .strict() per-element anti-leakage
  // --------------------------------------------------------------------

  it("rejects element with arbitrary unknown key (.strict() per-element guard)", () => {
    const broken = { ...buildValidChannelElement(), unexpected: "leaked" };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects element with `description` key (anti-spec-drift — description is not in the wire shape)", () => {
    const broken = { ...buildValidChannelElement(), description: "general chat" };
    expect(ChannelListResponseChannelSchema.safeParse(broken).success).toBe(false);
  });
});

// =============================================================================
// C5 — ChannelListResponseSchema (outer envelope)
// =============================================================================
//
// Spec-002 line 87 verbatim: "Response: `{channels: Array<...>}`". Outer
// envelope: single `channels` field (array). Empty list is valid (the
// service may return zero visible channels per authorization). `.strict()`
// rejects unknown top-level keys.

describe("ChannelListResponseSchema (C5: outer envelope per Spec-002 line 87)", () => {
  it("accepts an empty channels list (zero visible channels)", () => {
    const parsed = ChannelListResponseSchema.parse({ channels: [] });
    expect(parsed.channels).toEqual([]);
  });

  it("accepts a response with a single channel element", () => {
    const payload = { channels: [buildValidChannelElement()] };
    const parsed = ChannelListResponseSchema.parse(payload);
    expect(parsed.channels).toHaveLength(1);
    expect(parsed.channels[0]?.id).toBe(CHANNEL_ID);
  });

  it("accepts a response with multiple channels in different states (with and without `name`)", () => {
    const payload = {
      channels: [
        { id: CHANNEL_ID, name: "general", state: "active" as ChannelState, participantCount: 3 },
        // Bootstrap default channel — no `name` key.
        { id: SECOND_CHANNEL_ID, state: "muted" as ChannelState, participantCount: 0 },
        {
          id: THIRD_CHANNEL_ID,
          name: "design-review",
          state: "archived" as ChannelState,
          participantCount: 7,
        },
      ],
    };
    const parsed = ChannelListResponseSchema.parse(payload);
    expect(parsed.channels).toHaveLength(3);
    expect(parsed.channels[0]?.name).toBe("general");
    expect(parsed.channels[1]?.name).toBeUndefined();
    expect(parsed.channels[2]?.state).toBe("archived");
  });

  it("rejects response missing the `channels` field", () => {
    const result = ChannelListResponseSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("channels");
    }
  });

  it("rejects response with non-array `channels` (object instead of array)", () => {
    const broken = { channels: { id: CHANNEL_ID } };
    expect(ChannelListResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects response with non-array `channels` (string instead of array)", () => {
    const broken = { channels: "general,design-review" };
    expect(ChannelListResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects extraneous top-level keys (.strict() outer guard)", () => {
    const broken = { channels: [], unexpected: "field" };
    expect(ChannelListResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a response whose channel element is malformed (per-element guards compose)", () => {
    // Sanity check that per-element guards compose under the array — a
    // negative `participantCount` in any element fails the whole response.
    const broken = {
      channels: [{ id: CHANNEL_ID, state: "active", participantCount: -1 }],
    };
    expect(ChannelListResponseSchema.safeParse(broken).success).toBe(false);
  });
});
