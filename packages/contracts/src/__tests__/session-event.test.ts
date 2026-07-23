// Plan-001 PR #2 — Test C3: `SessionEvent discriminated union round-trips
// through JSON`.
//
// Backstops Spec-001 AC1 (initial projection from session.created) and AC6
// (snapshot/replay deterministic — events MUST survive JSON serialization
// unchanged so the projector applied at replay time computes the same
// projection as the projector applied at append time).
//
// Coverage shape:
//   • For each V1 variant (session.created, membership.created, channel.created):
//       - parse a wire-shaped fixture, JSON-serialize it, JSON-parse it,
//         re-parse through the schema — assert deep equality with the input
//   • Discriminator dispatch is correct (parsed.type narrows the payload)
//   • Unknown `type` discriminator value is rejected
//   • Known type with a payload from a sibling variant is rejected (the
//     `.strict()` modifier prevents cross-variant payload smuggling)
//   • Each variant carries the canonical `category` literal per
//     `SESSION_EVENT_CATEGORY_BY_TYPE`, AND a category/type mismatch is
//     rejected at parse time (Spec-006 §Canonical Serialization Rules
//     §523 — `category` participates in the BLAKE3-hashed canonical bytes)
//   • `SESSION_EVENT_CATEGORY_BY_TYPE` is a `ReadonlyMap`, so prototype-
//     chain walks (`__proto__`, `constructor`, etc.) resolve to `undefined`
//     instead of returning truthy non-EventCategory values (Round 3 R2-2)
//   • EventEnvelopeVersion accepts canonical "MAJOR.MINOR" forms and rejects
//     numeric / three-segment / leading-zero variants per ADR-018 §Decision #1
//   • `occurredAt` accepts numeric RFC 3339 §5.6 offsets (Z + +HH:MM)
//   • Empty-string `actor` and oversized fields are rejected (defense-in-depth)
//   • Round 3 R2-1 staff-bar consistency: `wireFreeFormString` helper
//     applied to every free-form string in the EventEnvelope (`id`,
//     `actor`, `correlationId`, `causationId`) — whitespace-only and
//     NUL-byte rejection now uniform across all wire fields
//   • Round 3 R2-5: channel.created.name length cap + whitespace + NUL
//     guards (defense in depth, mirrors `IDENTITY_HANDLE_MAX_LEN`)
import { describe, expect, it } from "vitest";

import {
  compareEventEnvelopeVersion,
  EVENT_ENVELOPE_VERSION_MAX_LEN,
  EVENT_ENVELOPE_VERSION_PATTERN,
  EVENT_FIELD_MAX_LEN,
  EventCategorySchema,
  EventEnvelopeVersionSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
  type SessionEvent,
} from "../event.js";
import { CHANNEL_NAME_MAX_LEN } from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001";
const MEMBERSHIP_ID = "770e8400-e29b-41d4-a716-446655440002";
const CHANNEL_ID = "880e8400-e29b-41d4-a716-446655440003";
const VERSION = "1.0";

const buildSessionCreated = () => ({
  id: "evt-0001",
  sessionId: SESSION_ID,
  sequence: 0,
  occurredAt: "2026-01-22T19:14:35.000Z",
  category: "session_lifecycle" as const,
  type: "session.created" as const,
  actor: PARTICIPANT_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    config: { resourceLimits: { sessions: 10 } },
    metadata: { source: "cli" },
  },
});

const buildMembershipCreated = () => ({
  id: "evt-0002",
  sessionId: SESSION_ID,
  sequence: 1,
  occurredAt: "2026-01-22T19:14:36.000Z",
  category: "membership_change" as const,
  type: "membership.created" as const,
  actor: PARTICIPANT_ID,
  correlationId: "req-001",
  version: VERSION,
  payload: {
    membershipId: MEMBERSHIP_ID,
    participantId: PARTICIPANT_ID,
    role: "owner",
    identityHandle: "alice",
  },
});

const buildChannelCreated = () => ({
  id: "evt-0003",
  sessionId: SESSION_ID,
  sequence: 2,
  occurredAt: "2026-01-22T19:14:37.000Z",
  category: "session_lifecycle" as const,
  type: "channel.created" as const,
  actor: null,
  version: VERSION,
  payload: {
    channelId: CHANNEL_ID,
    name: "main",
  },
});

describe("SessionEventSchema (C3: discriminated-union JSON round-trip)", () => {
  it("registers exactly the V1 subset (session.created, membership.created, channel.created)", () => {
    expect(SESSION_EVENT_TYPES).toEqual([
      "session.created",
      "membership.created",
      "channel.created",
    ]);
  });

  it.each([
    ["session.created", buildSessionCreated],
    ["membership.created", buildMembershipCreated],
    ["channel.created", buildChannelCreated],
  ] as const)("round-trips %s through JSON without loss", (label, build) => {
    const original = build();

    // Wire path: parse → JSON encode → JSON decode → parse again. The schema
    // must be JSON-stable: same shape in, same shape out, same parsed value.
    const firstPass = SessionEventSchema.parse(original);
    const onWire = JSON.stringify(firstPass);
    const offWire = JSON.parse(onWire) as unknown;
    const secondPass = SessionEventSchema.parse(offWire);

    expect(secondPass).toStrictEqual(firstPass);
    expect(secondPass.type).toBe(label);
  });

  it("narrows payload by `type` discriminator (compile-time + runtime)", () => {
    const ev: SessionEvent = SessionEventSchema.parse(buildSessionCreated());

    if (ev.type === "session.created") {
      // TypeScript narrows: `ev.payload.config` is typed as
      // `Record<string, unknown>` here — not `unknown` from the union.
      expect(ev.payload.config).toEqual({ resourceLimits: { sessions: 10 } });
    } else {
      throw new Error(`expected session.created branch, got ${ev.type}`);
    }
  });

  it("rejects an unknown `type` discriminator value", () => {
    const broken = { ...buildSessionCreated(), type: "session.exploded" };
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects payload smuggling across discriminator branches", () => {
    // session.created envelope but with a membership.created payload shape.
    // Because each variant uses `.strict()` the wrong-shape payload must
    // be rejected (no silent reinterpretation).
    const sessionCreated = buildSessionCreated();
    const membershipCreated = buildMembershipCreated();
    const broken = { ...sessionCreated, payload: membershipCreated.payload };
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an envelope missing required common field `sequence`", () => {
    const valid = buildSessionCreated();
    const broken = { ...valid } as Record<string, unknown>;
    // Bracket access required by `noPropertyAccessFromIndexSignature` (we
    // intentionally widened to `Record<string, unknown>` so we can `delete`
    // a typed-required field for the negative test).
    delete broken["sequence"];
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it.each([
    ["1.0", true],
    ["2.5", true],
    ["10.20", true],
    ["0.0", true],
    ["1", false], // not two-segment
    ["1.0.0", false], // three-segment
    ["1.01", false], // leading zero on MINOR
    ["01.0", false], // leading zero on MAJOR
    ["1.x", false], // non-numeric MINOR
    ["", false], // empty
  ])("EventEnvelopeVersion regex accepts %s -> %s", (candidate, shouldPass) => {
    expect(EVENT_ENVELOPE_VERSION_PATTERN.test(candidate)).toBe(shouldPass);
  });

  // Length cap at the schema boundary, independent of the format regex. Both
  // inputs are regex-valid (a single all-nines MAJOR + ".0"), so each exercises
  // the `.max(EVENT_ENVELOPE_VERSION_MAX_LEN)` gate specifically — not the
  // format gate. The cap bounds the super-linear BigInt parse cost in
  // `compareEventEnvelopeVersion`, so it must reject through the schema rather
  // than the regex.
  it("rejects an EventEnvelopeVersion longer than the length cap", () => {
    const overCap = "9".repeat(EVENT_ENVELOPE_VERSION_MAX_LEN - 1) + ".0";
    expect(overCap.length).toBe(EVENT_ENVELOPE_VERSION_MAX_LEN + 1);
    expect(EVENT_ENVELOPE_VERSION_PATTERN.test(overCap)).toBe(true);
    expect(EventEnvelopeVersionSchema.safeParse(overCap).success).toBe(false);
  });

  it("accepts an EventEnvelopeVersion at exactly the length cap (boundary)", () => {
    const atCap = "9".repeat(EVENT_ENVELOPE_VERSION_MAX_LEN - 2) + ".0";
    expect(atCap.length).toBe(EVENT_ENVELOPE_VERSION_MAX_LEN);
    expect(EventEnvelopeVersionSchema.safeParse(atCap).success).toBe(true);
  });

  it.each([
    ["session.created", buildSessionCreated, "session_lifecycle"],
    ["membership.created", buildMembershipCreated, "membership_change"],
    ["channel.created", buildChannelCreated, "session_lifecycle"],
  ] as const)("emits the canonical category %s -> %s", (label, build, expected) => {
    // Round-trip parse pin: each variant carries its declared canonical
    // category. This is wire-load-bearing because `Spec-006 §Canonical Serialization Rules` puts
    // `category` inside the canonical bytes that back the BLAKE3 hash chain
    // and Ed25519 signature; the parsed value must equal the per-type
    // category defined in `SESSION_EVENT_CATEGORY_BY_TYPE`.
    const parsed = SessionEventSchema.parse(build());
    expect(parsed.category).toBe(expected);
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(label)).toBe(expected);
  });

  it.each([["__proto__"], ["constructor"], ["toString"], ["hasOwnProperty"], ["unknown.event"]])(
    "SESSION_EVENT_CATEGORY_BY_TYPE.get rejects prototype-chain walks: %s",
    (untrusted) => {
      // Map (NOT object-literal) lookup is load-bearing: a Plan-006
      // integrity verifier that calls `.get(evt.type)` on a not-yet-parsed
      // string MUST resolve to `undefined` for every key that isn't in
      // the explicit table, including built-in object prototype keys. With
      // an object literal `lookup['__proto__']` resolves to a truthy
      // `[Object: null prototype] {}` value.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(untrusted as never)).toBeUndefined();
    },
  );

  it("rejects a category/type mismatch (membership_change on session.created)", () => {
    // Wire-integrity check: the per-variant `category: z.literal(...)`
    // forbids cross-namespace smuggling. If this ever silently accepted,
    // the integrity protocol would hash the event under the wrong
    // category byte and replay would diverge.
    const broken = { ...buildSessionCreated(), category: "membership_change" as const };
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an envelope missing required field `category`", () => {
    const valid = buildSessionCreated();
    const broken = { ...valid } as Record<string, unknown>;
    delete broken["category"];
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("EventCategorySchema enumerates exactly the 19 canonical categories (no more, no less)", () => {
    // Pinning the enum values prevents accidental drift from the canonical
    // EventCategory definition. If api-payload-contracts.md adds a category,
    // the spec edit must land before this list; the test will fail until
    // both sides agree.
    const expected = [
      "run_lifecycle",
      "assistant_output",
      "tool_activity",
      "interactive_request",
      "artifact_publication",
      "membership_change",
      "session_lifecycle",
      "approval_flow",
      "usage_telemetry",
      "runtime_node_lifecycle",
      "recovery_events",
      "participant_lifecycle",
      "audit_integrity",
      "security_events",
      "event_maintenance",
      "policy_events",
      "channel_arbitration",
      "onboarding_lifecycle",
      "cross_node_dispatch",
    ];
    // Read `.options` from the underlying enum construct. The schema is
    // typed as the abstract `z.ZodType<EventCategory>` so we cast via
    // `unknown` to read the construct-specific `.options` property; the
    // assertions below check both length AND exact set membership.
    const schemaInternals = EventCategorySchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toHaveLength(19);
    expect([...schemaInternals.options].sort()).toEqual([...expected].sort());
    for (const cat of expected) {
      expect(EventCategorySchema.safeParse(cat).success).toBe(true);
    }
    expect(EventCategorySchema.safeParse("not_a_category").success).toBe(false);
  });

  it.each([
    ["Z-suffixed UTC", "2026-01-22T19:14:35.000Z", true],
    ["positive numeric offset", "2026-01-22T19:14:35.000+05:00", true],
    ["negative numeric offset", "2026-01-22T19:14:35.000-08:00", true],
    ["zero numeric offset", "2026-01-22T19:14:35.000+00:00", true],
    ["bare local datetime (no Z, no offset)", "2026-01-22T19:14:35.000", false],
    ["plain date", "2026-01-22", false],
  ])(
    "occurredAt: %s parses -> %s (RFC 3339 §5.6 offsets honored, local rejected)",
    (_label, candidate, shouldPass) => {
      const fixture = { ...buildSessionCreated(), occurredAt: candidate };
      const result = SessionEventSchema.safeParse(fixture);
      expect(result.success).toBe(shouldPass);
    },
  );

  it("rejects empty-string `actor` (system events MUST send `null` or omit the key)", () => {
    const broken = { ...buildSessionCreated(), actor: "" };
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("accepts `actor: null` (system-emitted event)", () => {
    const valid = { ...buildSessionCreated(), actor: null };
    const result = SessionEventSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects oversized `id` (defense-in-depth length cap)", () => {
    const broken = { ...buildSessionCreated(), id: "x".repeat(EVENT_FIELD_MAX_LEN + 1) };
    const result = SessionEventSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("accepts `id` at exactly the length cap (boundary)", () => {
    const valid = { ...buildSessionCreated(), id: "x".repeat(EVENT_FIELD_MAX_LEN) };
    const result = SessionEventSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  // --------------------------------------------------------------------
  // Round 3: wireFreeFormString helper applied to all free-form fields.
  // --------------------------------------------------------------------
  // R2-1 (medium, staff-bar consistency): the same wire-layer guards
  // (whitespace-only rejection + NUL-byte rejection) that protect
  // `identityHandle` are now applied to every free-form string in the
  // EventEnvelope: `id`, `actor`, `correlationId`, `causationId`. Plus
  // R2-5 (LOW, consistency): channel.created `name` gets the same.
  // The trust boundary is the wire layer, not producer trust.

  it.each([
    ["id", "   "],
    ["id", "\t\t\t"],
    ["actor", "   "],
    ["actor", "\t \n"],
    ["correlationId", "   "],
    ["correlationId", "\t\n\t"],
    ["causationId", "   "],
    ["causationId", "\n\n"],
  ])("rejects whitespace-only %s value: %j", (field, value) => {
    const broken = { ...buildSessionCreated(), [field]: value };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    ["id", "evt-\u0000-001"],
    ["actor", "alice\u0000bob"],
    ["correlationId", "req\u0000001"],
    ["causationId", "cause\u0000id"],
  ])("rejects NUL-byte %s value: %j", (field, value) => {
    const broken = { ...buildSessionCreated(), [field]: value };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts `actor: null` (system-emitted event) — helper composes after .nullable()", () => {
    // Regression pin: composing the helper with `.nullable().optional()`
    // must NOT cause `null` to fall into the inner `.regex(/\S/)` /
    // `.refine(NUL)` checks. Zod evaluates the wrapped schema only on
    // string values; `null` short-circuits past the chain.
    const valid = { ...buildSessionCreated(), actor: null };
    expect(SessionEventSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts `actor` omitted entirely (helper composes after .optional())", () => {
    const valid = { ...buildSessionCreated() } as Record<string, unknown>;
    delete valid["actor"];
    expect(SessionEventSchema.safeParse(valid).success).toBe(true);
  });

  it.each([["correlationId"], ["causationId"]])("accepts %s omitted entirely", (field) => {
    const valid = { ...buildSessionCreated() } as Record<string, unknown>;
    delete valid[field];
    expect(SessionEventSchema.safeParse(valid).success).toBe(true);
  });

  // R2-5: channel.created.name boundary tests
  it("accepts a normal channel name", () => {
    const valid = buildChannelCreated();
    expect(SessionEventSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an absent channel name (the implicit `main` channel)", () => {
    const valid = { ...buildChannelCreated() };
    const payload = { ...valid.payload } as Record<string, unknown>;
    delete payload["name"];
    expect(SessionEventSchema.safeParse({ ...valid, payload }).success).toBe(true);
  });

  it("rejects an empty-string channel name", () => {
    const broken = {
      ...buildChannelCreated(),
      payload: { ...buildChannelCreated().payload, name: "" },
    };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a whitespace-only channel name", () => {
    const broken = {
      ...buildChannelCreated(),
      payload: { ...buildChannelCreated().payload, name: "   " },
    };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a NUL-byte channel name", () => {
    const broken = {
      ...buildChannelCreated(),
      payload: { ...buildChannelCreated().payload, name: "main\u0000extra" },
    };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized channel name (defense-in-depth length cap)", () => {
    const broken = {
      ...buildChannelCreated(),
      payload: {
        ...buildChannelCreated().payload,
        name: "x".repeat(CHANNEL_NAME_MAX_LEN + 1),
      },
    };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a channel name at exactly the length cap (boundary)", () => {
    const valid = {
      ...buildChannelCreated(),
      payload: {
        ...buildChannelCreated().payload,
        name: "x".repeat(CHANNEL_NAME_MAX_LEN),
      },
    };
    expect(SessionEventSchema.safeParse(valid).success).toBe(true);
  });
});

// --------------------------------------------------------------------------
// compareEventEnvelopeVersion — total ordering of the branded version type.
// --------------------------------------------------------------------------
//
// Co-located with the EventEnvelopeVersion regex table above (the comparator
// orders the same value type). Inputs go through `EventEnvelopeVersionSchema.parse`
// so each case exercises the real brand path, not an `as`-cast.
//
// The multi-digit cases are the load-bearing guards: a NUMERIC compare yields
// `"10" > "9"` and `"1.10" > "1.9"`, whereas the lexical string compare the
// hand-rolled tuple comparator exists to avoid would yield the opposite. They
// are why the comparator parses MAJOR/MINOR as integers instead of comparing
// strings (event.ts §compareEventEnvelopeVersion; ADR-018 §Decision #1).
//
// The precision cases below are the second load-bearing guard: the SCHEMA caps
// input length (EVENT_ENVELOPE_VERSION_MAX_LEN), but well within that bound a
// `Number` parse still collapses two distinct versions above
// `Number.MAX_SAFE_INTEGER` to one float. The comparator parses with `BigInt`,
// so the ordering stays EXACT across that range. This matters at the
// version-floor gate (attach-service.ts): a below-floor client whose version
// collapsed to the floor's float would be mis-read as at-floor and wrongly
// granted read-write.
describe("compareEventEnvelopeVersion", () => {
  const parseVersion = (raw: string) => EventEnvelopeVersionSchema.parse(raw);

  it.each([
    ["1.0", "1.0"],
    ["2.5", "2.5"],
  ])("returns 0 for equal versions: compare(%s, %s)", (left, right) => {
    expect(compareEventEnvelopeVersion(parseVersion(left), parseVersion(right))).toBe(0);
  });

  it.each([
    // [a, b, expected] — major equal, minor decides.
    ["1.2", "1.5", -1],
    ["1.5", "1.2", 1],
  ] as const)(
    "orders by MINOR when MAJOR is equal: compare(%s, %s) === %d",
    (left, right, want) => {
      expect(compareEventEnvelopeVersion(parseVersion(left), parseVersion(right))).toBe(want);
    },
  );

  it.each([
    // MAJOR dominates MINOR — 2.0 outranks 1.9 despite minor 0 < 9.
    ["2.0", "1.9", 1],
    ["1.9", "2.0", -1],
  ] as const)("MAJOR dominates MINOR: compare(%s, %s) === %d", (left, right, want) => {
    expect(compareEventEnvelopeVersion(parseVersion(left), parseVersion(right))).toBe(want);
  });

  it("multi-digit MAJOR is compared numerically, not lexically: compare(10.0, 9.0) === 1", () => {
    // Lexical string compare would give `"10" < "9"` (-> -1); numeric major
    // 10 > 9 gives 1. This is the bug the hand-rolled comparator forecloses.
    expect(compareEventEnvelopeVersion(parseVersion("10.0"), parseVersion("9.0"))).toBe(1);
  });

  it("multi-digit MINOR is compared numerically, not lexically: compare(1.10, 1.9) === 1", () => {
    // Lexical compare would give `"1.10" < "1.9"` (-> -1); numeric minor
    // 10 > 9 gives 1.
    expect(compareEventEnvelopeVersion(parseVersion("1.10"), parseVersion("1.9"))).toBe(1);
  });

  // ------------------------------------------------------------------
  // Precision: BigInt compare is EXACT above Number.MAX_SAFE_INTEGER.
  // ------------------------------------------------------------------
  // A `Number` parse collapses adjacent integers past 9007199254740991 to one
  // float, so a below-floor client could be mis-read as at-floor and granted
  // read-write at the version-floor gate. These cases pin the exactness.

  it("orders adjacent MAJORs above Number.MAX_SAFE_INTEGER (Number collapses both to one float)", () => {
    // Number("9007199254740993") === Number("9007199254740992") === 9007199254740992,
    // so a numeric compare returns 0; BigInt keeps them distinct -> 1 / -1.
    expect(
      compareEventEnvelopeVersion(
        parseVersion("9007199254740993.0"),
        parseVersion("9007199254740992.0"),
      ),
    ).toBe(1);
    expect(
      compareEventEnvelopeVersion(
        parseVersion("9007199254740992.0"),
        parseVersion("9007199254740993.0"),
      ),
    ).toBe(-1);
  });

  it("orders adjacent MINORs above Number.MAX_SAFE_INTEGER (same float-collapse, minor segment)", () => {
    expect(
      compareEventEnvelopeVersion(
        parseVersion("1.9007199254740993"),
        parseVersion("1.9007199254740992"),
      ),
    ).toBe(1);
  });

  it.each([
    ["1.2", "1.5"],
    ["2.0", "1.9"],
    ["10.0", "9.0"],
    ["1.10", "1.9"],
  ])("is antisymmetric: compare(%s, %s) === -compare(reverse)", (left, right) => {
    const forward = compareEventEnvelopeVersion(parseVersion(left), parseVersion(right));
    const reverse = compareEventEnvelopeVersion(parseVersion(right), parseVersion(left));
    expect(forward + reverse).toBe(0);
  });
});
