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
//
// Plan-006 T1.2 extends coverage with the SessionEventType census +
// SESSION_EVENT_CATEGORY_BY_TYPE registry suite at the end of this file:
// Spec-006 §Event Type Summary at the pre-B18 baseline (141 types / 19
// categories), invariants I-006-1-01 (category/type bijection) and
// I-006-1-02 (event-type-string immutability). Plan-006 T1.3 adds the
// EventEnvelopeSchema canonical-carrier suite after it: the 11-member
// canonical-set pin (I-006-1-03), envelope-vs-strict layering,
// producer-set `version` semantics (I-006-1-04), and the payload
// own-`__proto__` reject-loud carve-out (record parser cannot preserve
// that key; silent stripping is forbidden). Plan-006 T1.4 appends the
// `CapabilityDetailsSchema` suite last: the canonical capability snapshot
// for the `runtime_node.capability_*` payload binding (exhaustive
// enum-keyed flags; non-normalizing strict tools).
import { describe, expect, it } from "vitest";

import {
  APPROVAL_FLOW_EVENT_TYPES,
  ARTIFACT_PUBLICATION_EVENT_TYPES,
  ASSISTANT_OUTPUT_EVENT_TYPES,
  AUDIT_INTEGRITY_EVENT_TYPES,
  CAPABILITY_CONTRACT_VERSION_MAX_LEN,
  CapabilityDetailsSchema,
  CHANNEL_ARBITRATION_EVENT_TYPES,
  compareEventEnvelopeVersion,
  CROSS_NODE_DISPATCH_EVENT_TYPES,
  EVENT_ENVELOPE_VERSION_MAX_LEN,
  EVENT_ENVELOPE_VERSION_PATTERN,
  EVENT_FIELD_MAX_LEN,
  EVENT_MAINTENANCE_EVENT_TYPES,
  EventCategorySchema,
  EventEnvelopeSchema,
  EventEnvelopeVersionSchema,
  INTERACTIVE_REQUEST_EVENT_TYPES,
  MEMBERSHIP_CHANGE_EVENT_TYPES,
  ONBOARDING_LIFECYCLE_EVENT_TYPES,
  PARTICIPANT_LIFECYCLE_EVENT_TYPES,
  POLICY_EVENTS_EVENT_TYPES,
  RECOVERY_EVENTS_EVENT_TYPES,
  RUN_LIFECYCLE_EVENT_TYPES,
  RUNTIME_NODE_LIFECYCLE_EVENT_TYPES,
  SECURITY_EVENTS_EVENT_TYPES,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  SESSION_LIFECYCLE_EVENT_TYPES,
  SessionEventSchema,
  TOOL_ACTIVITY_EVENT_TYPES,
  USAGE_TELEMETRY_EVENT_TYPES,
  type CapabilityDetails,
  type EventCategory,
  type EventEnvelope,
  type SessionEvent,
  type SessionEventType,
} from "../event.js";
import {
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_TOOL_DESCRIPTION_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
  type DriverCapabilityFlag,
} from "../provider-driver.js";
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

// --------------------------------------------------------------------------
// Plan-006 T1.2 — SessionEventType census + category registry.
// --------------------------------------------------------------------------
//
// Backstops Spec-006 §Event Type Summary at the pre-B18 baseline (141 types
// across 19 categories; the census table's post-B18 total is 156/20, and the
// missing fifteen literals land with T1.10) plus the two Phase-1 invariants:
//   • I-006-1-01 — category/type bijection: SESSION_EVENT_CATEGORY_BY_TYPE
//     covers every registered type exactly once, its values span exactly
//     the 19 canonical categories (every category non-empty), and the 19
//     per-category arrays partition the census.
//   • I-006-1-02 — event-type-string immutability: the three Plan-001 wire
//     literals are unrenamed with unchanged categories, and the SCHEMA-
//     registered payload subset stays exactly those three variants.
// Assertions are exact-set style wherever set equality is feasible (the
// hardened idiom of the EventCategorySchema pin above), with the
// AC-verbatim size assertions (size === 141, 19 distinct categories)
// alongside.

// Expected census, transcribed from Spec-006 §Event Type Summary aggregated
// per category at the pre-B18 baseline. Post-B18 census rows minus the B18
// deltas: session_lifecycle 31−3=28 (session 12−3=9, channel/agent 7,
// repo/workspace/worktree 11, pty 1); run_lifecycle 13−3=10;
// interactive_request 16−1=15 (queue 5, intervention 6, driver ask 4, user
// message 1−1=0); usage_telemetry 8−3=5; mcp_governance 5−5=0 (the category
// itself is T1.10's). Every other census row is B18-untouched. Rows sum to
// 141 (asserted below), mirroring the census table's Total row.
const CENSUS_BASELINE: ReadonlyArray<
  readonly [EventCategory, readonly SessionEventType[], number]
> = [
  ["run_lifecycle", RUN_LIFECYCLE_EVENT_TYPES, 10],
  ["assistant_output", ASSISTANT_OUTPUT_EVENT_TYPES, 2],
  ["tool_activity", TOOL_ACTIVITY_EVENT_TYPES, 7],
  ["interactive_request", INTERACTIVE_REQUEST_EVENT_TYPES, 15],
  ["artifact_publication", ARTIFACT_PUBLICATION_EVENT_TYPES, 6],
  ["membership_change", MEMBERSHIP_CHANGE_EVENT_TYPES, 13],
  ["session_lifecycle", SESSION_LIFECYCLE_EVENT_TYPES, 28],
  ["approval_flow", APPROVAL_FLOW_EVENT_TYPES, 8],
  ["usage_telemetry", USAGE_TELEMETRY_EVENT_TYPES, 5],
  ["runtime_node_lifecycle", RUNTIME_NODE_LIFECYCLE_EVENT_TYPES, 9],
  ["recovery_events", RECOVERY_EVENTS_EVENT_TYPES, 3],
  ["participant_lifecycle", PARTICIPANT_LIFECYCLE_EVENT_TYPES, 5],
  ["audit_integrity", AUDIT_INTEGRITY_EVENT_TYPES, 3],
  ["security_events", SECURITY_EVENTS_EVENT_TYPES, 4],
  ["event_maintenance", EVENT_MAINTENANCE_EVENT_TYPES, 3],
  ["policy_events", POLICY_EVENTS_EVENT_TYPES, 2],
  ["channel_arbitration", CHANNEL_ARBITRATION_EVENT_TYPES, 3],
  ["onboarding_lifecycle", ONBOARDING_LIFECYCLE_EVENT_TYPES, 2],
  ["cross_node_dispatch", CROSS_NODE_DISPATCH_EVENT_TYPES, 13],
];

// The fifteen 2026-07-22 B18 literals excluded from the baseline census.
// They register in Plan-006 T1.10, which must invert these pins when it
// lands the 141 → 156 / 19 → 20 widening. Deliberately typed as plain
// strings — they are NOT SessionEventType members yet.
const B18_PENDING_TYPES: readonly string[] = [
  "session.provider_status",
  "session.notice",
  "session.renamed",
  "run.provider_initialized",
  "run.turn_started",
  "run.worker_shutdown",
  "usage.api_retry",
  "usage.context_compacted",
  "usage.model_rerouted",
  "user.message",
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
];

describe("SessionEventType census + SESSION_EVENT_CATEGORY_BY_TYPE registry (T1.2)", () => {
  it("registers exactly 141 types across exactly 19 distinct categories (I-006-1-01 sizes)", () => {
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.size).toBe(141);
    expect(new Set(SESSION_EVENT_CATEGORY_BY_TYPE.values()).size).toBe(19);
  });

  it("registry categories span exactly the canonical EventCategory set (no empty category)", () => {
    // Exact-set against the T1.1 schema surface (same `.options` cast idiom
    // as the EventCategorySchema pin above): the surjective side of the
    // bijection — every canonical category has at least one registered type.
    const schemaInternals = EventCategorySchema as unknown as { options: readonly string[] };
    const registryCategories = [...new Set(SESSION_EVENT_CATEGORY_BY_TYPE.values())].sort();
    expect(registryCategories).toEqual([...schemaInternals.options].sort());
  });

  it("census table is complete: 19 rows, one per category, counts summing to 141", () => {
    const tableCategories = CENSUS_BASELINE.map(([category]) => category);
    expect(tableCategories).toHaveLength(19);
    expect(new Set(tableCategories).size).toBe(19);
    const total = CENSUS_BASELINE.reduce((sum, [, , expectedCount]) => sum + expectedCount, 0);
    expect(total).toBe(141);
  });

  it.each(CENSUS_BASELINE)(
    "%s: per-category array equals the registry partition, count pinned to the Spec-006 census",
    (category, categoryTypes, expectedCount) => {
      // Census-row pin (Spec-006 §Event Type Summary, aggregated per
      // category at the pre-B18 baseline).
      expect(categoryTypes).toHaveLength(expectedCount);
      // No intra-array duplicates: distinct-member count equals length.
      expect(new Set(categoryTypes).size).toBe(expectedCount);
      // Exact set equality vs the registry's keys filtered to this category
      // — the I-006-1-01 anti-drift bind between arrays and registry. This
      // also forces pairwise-disjoint arrays: each registry key carries
      // exactly one category, so the 19 filtered key sets are disjoint.
      const registryKeysInCategory = [...SESSION_EVENT_CATEGORY_BY_TYPE.entries()]
        .filter(([, registeredCategory]) => registeredCategory === category)
        .map(([eventType]) => eventType)
        .sort();
      expect([...categoryTypes].sort()).toEqual(registryKeysInCategory);
    },
  );

  it("the 19 per-category arrays partition the registry key set exactly", () => {
    const aggregated = CENSUS_BASELINE.flatMap(([, categoryTypes]) => [...categoryTypes]);
    expect(aggregated).toHaveLength(141);
    expect(new Set(aggregated).size).toBe(141);
    expect([...aggregated].sort()).toEqual([...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].sort());
  });

  it("keeps the three Plan-001 wire literals unrenamed with unchanged categories (I-006-1-02)", () => {
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get("session.created")).toBe("session_lifecycle");
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get("membership.created")).toBe("membership_change");
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get("channel.created")).toBe("session_lifecycle");
    // The census widening is additive-only: the SCHEMA-registered payload
    // subset is untouched (exactly the three Plan-001 variants — the
    // discriminated union grows only through the emitting plans'
    // union-registration seam), and each subset member is census-registered.
    expect(SESSION_EVENT_TYPES).toEqual([
      "session.created",
      "membership.created",
      "channel.created",
    ]);
    for (const registered of SESSION_EVENT_TYPES) {
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.has(registered)).toBe(true);
    }
  });

  it.each([
    // Rows whose namespace prefix does NOT name their category — pinned
    // against the spec sections so a future "cleanup" by namespace
    // heuristic fails loud. The registry, never the prefix, is the
    // category authority (name preservation for the `session.clock_*`
    // pair per Spec-006 §Runtime Node Lifecycle; `key_reuse_detected`
    // is a flat name with no namespace at all).
    ["session.clock_unsynced", "runtime_node_lifecycle"],
    ["session.clock_corrected", "runtime_node_lifecycle"],
    ["daemon.master_key_source", "security_events"],
    ["daemon.pii_split_ambiguous", "security_events"],
    ["schema.migrated", "event_maintenance"],
    ["moderation.review_flagged", "approval_flow"],
    ["orchestration.rejected", "channel_arbitration"],
    ["subagent.started", "tool_activity"],
    ["pty.control_changed", "session_lifecycle"],
    ["key_reuse_detected", "audit_integrity"],
  ] as const)(
    "category authority is the registry, not the namespace prefix: %s -> %s",
    (eventType, expectedCategory) => {
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe(expectedCategory);
    },
  );

  it("baseline census + pending B18 literals equal the Spec-006 post-B18 total of 156", () => {
    // Completeness self-check for the B18_PENDING_TYPES fixture (the same
    // row-sum bind CENSUS_BASELINE gets above): 141 registered + 15 distinct
    // pending === 156, the Spec-006 §Event Type Summary post-B18 total — a
    // silently dropped (or duplicated) pending entry fails here instead of
    // leaving 14 passing pins.
    expect(B18_PENDING_TYPES).toHaveLength(15);
    expect(new Set(B18_PENDING_TYPES).size).toBe(15);
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.size + B18_PENDING_TYPES.length).toBe(156);
  });

  it.each([...B18_PENDING_TYPES])(
    "pre-B18 baseline: %s is not yet registered (T1.10 lands the B18 fifteen)",
    (pendingType) => {
      // Same `as never` idiom as the prototype-walk pins above: the literal
      // is deliberately outside today's SessionEventType union, so this
      // both documents the T1.10 boundary and proves no B18 literal leaked
      // into the baseline census.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(pendingType as never)).toBeUndefined();
    },
  );
});

// --------------------------------------------------------------------------
// Plan-006 T1.3 — EventEnvelopeSchema: the canonical event carrier.
// --------------------------------------------------------------------------
//
// Backstops Spec-006 §Canonical Serialization Rules (fields included — the
// canonical set) and the two Phase-1 invariants the named envelope export
// underwrites:
//   • I-006-1-03 — the envelope FIELD SET is fixed at the canonical eleven
//     members; serialized ORDER is RFC 8785 §3.2.3 UTF-16 code-unit
//     lex-sort, produced by Phase 2's canonicalizer (golden vectors in
//     T2.3) — so this layer pins membership mechanically, not byte order.
//   • I-006-1-04 — `version` is producer-set and never rewritten: the
//     parse path must hand back the producer's string verbatim. The
//     read-side never-rewrite half (upcaster chain, ADR-018 §Decision #6)
//     is daemon behavior, out of contract-layer reach — asserted by the
//     consuming plans, not here.
// Layering (ADR-018 §Decision #5/#8/#9): the envelope is the version-
// TOLERANT carrier — `type` is a bounded free-form string, NOT the census
// union — while `SessionEventSchema` stays the strict interpretation layer.

// The canonical 11-member set, transcribed from Spec-006 §Canonical
// Serialization Rules ("Fields included"). Listed in wire-authority
// declaration order; every assertion sorts before comparing because only
// MEMBERSHIP is canonical.
const CANONICAL_ENVELOPE_FIELDS = [
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
] as const;

// A census-registered type with NO SessionEventSchema payload variant —
// exercises the carrier accepting what the strict layer cannot interpret.
// All eleven canonical members present (actor deliberately present-null).
const buildBareEnvelope = () => ({
  id: "evt-0100",
  sessionId: SESSION_ID,
  sequence: 41,
  occurredAt: "2026-01-22T19:14:38.000Z",
  category: "usage_telemetry" as const,
  type: "usage.token_count",
  actor: null,
  payload: { runId: "run-001", totalTokens: 1234, providerExtra: { nested: true } },
  correlationId: "req-042",
  causationId: "evt-0099",
  version: VERSION,
});

describe("EventEnvelopeSchema — canonical carrier (T1.3)", () => {
  it("declares exactly the canonical 11-field set (I-006-1-03 membership pin)", () => {
    // Mechanical guard on the DECLARED set, independent of any fixture:
    // read the ZodObject shape keys through the same internals-cast idiom
    // as the EventCategorySchema `.options` pin above.
    const schemaInternals = EventEnvelopeSchema as unknown as {
      shape: Record<string, unknown>;
    };
    const declared = Object.keys(schemaInternals.shape);
    expect(declared).toHaveLength(11);
    expect([...declared].sort()).toEqual([...CANONICAL_ENVELOPE_FIELDS].sort());
  });

  it("round-trips a fully-populated envelope through JSON with the exact member set", () => {
    const firstPass = EventEnvelopeSchema.parse(buildBareEnvelope());
    const secondPass = EventEnvelopeSchema.parse(JSON.parse(JSON.stringify(firstPass)) as unknown);
    expect(secondPass).toStrictEqual(firstPass);
    expect(Object.keys(secondPass).sort()).toEqual([...CANONICAL_ENVELOPE_FIELDS].sort());
    // Unknown payload keys from a newer producer are preserved verbatim,
    // never stripped (Spec-006 §EventEnvelope Version Semantics).
    expect(secondPass.payload).toStrictEqual(buildBareEnvelope().payload);
  });

  it("hands back the producer-set `version` verbatim (I-006-1-04 — parse never rewrites)", () => {
    const parsed = EventEnvelopeSchema.parse(buildBareEnvelope());
    expect(parsed.version).toBe(VERSION);
  });

  it.each([
    ["numeric version (ADR-018 §Decision #1 — never numeric on the wire)", { version: 1 }],
    ["three-segment version", { version: "1.0.0" }],
  ] as const)("rejects a %s", (_label, patch) => {
    expect(EventEnvelopeSchema.safeParse({ ...buildBareEnvelope(), ...patch }).success).toBe(false);
  });

  it("rejects an envelope missing `version` (producer-set, required)", () => {
    const broken = { ...buildBareEnvelope() } as Record<string, unknown>;
    delete broken["version"];
    expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a census type with no payload variant; SessionEventSchema rejects it", () => {
    // Layering pin: `usage.token_count` is census-registered (T1.2) but has
    // no discriminated-union payload variant — the tolerant carrier parses
    // it, the strict layer refuses to interpret it.
    const fixture = buildBareEnvelope();
    expect(EventEnvelopeSchema.safeParse(fixture).success).toBe(true);
    expect(SessionEventSchema.safeParse(fixture).success).toBe(false);
  });

  it("accepts a census-UNKNOWN forward type (ADR-018 §Decision #5/#8/#9 accept-and-stub)", () => {
    // `session.renamed` is a B18-pending literal — outside today's census
    // union entirely. A reader must be able to parse the ENVELOPE (to
    // persist it as a version stub) even though no layer above can
    // interpret it yet; rejecting here would drop exactly the events the
    // stub path exists to preserve.
    const forward = {
      ...buildBareEnvelope(),
      category: "session_lifecycle" as const,
      type: "session.renamed",
      payload: { sessionId: SESSION_ID, name: "renamed", origin: "provider" },
    };
    expect(EventEnvelopeSchema.safeParse(forward).success).toBe(true);
    expect(SessionEventSchema.safeParse(forward).success).toBe(false);
  });

  it.each([
    ["whitespace-only", "   "],
    ["NUL-byte", "usage.token\u0000count"],
    ["oversized", "x".repeat(EVENT_FIELD_MAX_LEN + 1)],
  ] as const)("rejects a %s `type` (wireFreeFormString guards)", (_label, badType) => {
    expect(EventEnvelopeSchema.safeParse({ ...buildBareEnvelope(), type: badType }).success).toBe(
      false,
    );
  });

  it("rejects a `category` outside the canonical enum (tolerance axis is `type`)", () => {
    const broken = { ...buildBareEnvelope(), category: "not_a_category" };
    expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
  });

  it.each([["pii_payload"], ["extraField"], ["__proto__"]])(
    "rejects a top-level member outside the canonical set: %s (I-006-1-03 — the set is fixed)",
    (extraKey) => {
      // `pii_payload` foremost: it is a storage COLUMN, deliberately NOT in
      // the canonical form (Spec-006 §Canonical Serialization Rules) — an
      // envelope smuggling it as a top-level member is malformed, and
      // silently stripping it would desync the parse output from the
      // hashed canonical bytes. The `__proto__` row pins that Zod's OBJECT
      // parser (unlike its record parser — see the payload pre-guard pins
      // below) surfaces an own `__proto__` as an unrecognized key, so
      // `.strict()` rejects it. The computed-key spread creates an OWN
      // property (only a non-computed literal `__proto__:` key in an
      // object literal would set the prototype instead).
      const broken = { ...buildBareEnvelope(), [extraKey]: { smuggled: true } };
      expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("keeps `actor: null` and absent `actor` wire-distinguishable", () => {
    // Spec-006 §Canonical Serialization Rules: fields with value `null`
    // MUST be included in serialization, so present-null and absent stay
    // distinguishable — `actor` is the canonical set's only nullable
    // member. JSON keeps `null` values and drops absent keys.
    const withNull = EventEnvelopeSchema.parse({ ...buildBareEnvelope(), actor: null });
    expect("actor" in withNull).toBe(true);
    const rehydrated = JSON.parse(JSON.stringify(withNull)) as Record<string, unknown>;
    expect("actor" in rehydrated).toBe(true);

    const absentFixture = { ...buildBareEnvelope() } as Record<string, unknown>;
    delete absentFixture["actor"];
    const withAbsent = EventEnvelopeSchema.parse(absentFixture);
    expect("actor" in withAbsent).toBe(false);
  });

  it.each([["correlationId"], ["causationId"]])(
    "rejects `%s: null` (optional-only — absent is the sole no-value wire state)",
    (field) => {
      // The wire authority types the correlation pair `field?: string` —
      // optional, NOT nullable, matching `buildCommonShape()`'s modeling
      // (unchanged by the T1.3 refactor): `actor` alone carries the
      // null-for-system convention. Pinned so any widening to nullable is
      // a deliberate, loud contract change.
      const broken = { ...buildBareEnvelope(), [field]: null };
      expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("rejects an envelope missing `payload` (required canonical member)", () => {
    const broken = { ...buildBareEnvelope() } as Record<string, unknown>;
    delete broken["payload"];
    expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "not-an-object"],
  ] as const)("rejects a non-object `payload` (%s)", (_label, badPayload) => {
    expect(
      EventEnvelopeSchema.safeParse({ ...buildBareEnvelope(), payload: badPayload }).success,
    ).toBe(false);
  });

  it("rejects an own `__proto__` payload key (JSON.parse-built wire member)", () => {
    // JSON.parse defines `__proto__` as an OWN data property (no prototype
    // semantics), so the wire genuinely carries the member — a TS object
    // literal `{ __proto__: ... }` would set the prototype instead and
    // never reach the parser with an own key. Zod's record parser
    // unconditionally SKIPS own `__proto__` keys, so preserve-verbatim is
    // impossible for this one key and the default outcome is a silent
    // drop — two distinct wire byte-strings collapsing to one parse
    // output, the I-006-1-03 no-collapse hazard. The payload pre-guard
    // (raw pre-record superRefine; a refine on the record's OUTPUT could
    // never see the already-dropped key) rejects it loud instead.
    const protoPayload = JSON.parse('{"__proto__":{"smuggled":true},"totalTokens":1}') as unknown;
    // Fixture self-check: the parsed JSON really carries an OWN key (an
    // `in` check would be satisfied by the prototype chain and prove
    // nothing).
    expect(Object.hasOwn(protoPayload as object, "__proto__")).toBe(true);
    const broken = { ...buildBareEnvelope(), payload: protoPayload };
    expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
  });

  it.each([["unknownForwardField"], ["constructor"], ["prototype"]])(
    "preserves unknown payload key %s verbatim (guard positive control)",
    (unknownKey) => {
      // The carve-out is exactly one key wide: every other unknown payload
      // key — including the proto-ADJACENT `constructor` / `prototype`,
      // which are preservable own data keys (computed-key creation shadows
      // the prototype members) — still round-trips untouched (Spec-006
      // §EventEnvelope Version Semantics higher-MINOR preservation).
      // Forward-regression pin: Zod's record-parser skip-list is
      // verifiably `__proto__`-only today, making the pre-guard exactly
      // co-extensive with the drop behavior; a future Zod upgrade that
      // widens that skip-list would silently reintroduce the drop-collapse
      // hazard for keys the guard does not cover — it must fail loud HERE
      // first (same forward-pin idiom as the `.options` / `.shape`
      // internals casts). Assertions are per-key rather than a whole-
      // payload toStrictEqual: an own `constructor` key shadows the
      // prototype member, which jest-style type-equality reads for class
      // comparison — Object.keys set equality pins no-drop AND no-add
      // without tripping that.
      const parsed = EventEnvelopeSchema.parse({
        ...buildBareEnvelope(),
        payload: { [unknownKey]: { marker: unknownKey } },
      });
      expect(Object.keys(parsed.payload)).toEqual([unknownKey]);
      expect(parsed.payload[unknownKey]).toStrictEqual({ marker: unknownKey });
    },
  );

  it.each([
    ["session.created", buildSessionCreated],
    ["membership.created", buildMembershipCreated],
    ["channel.created", buildChannelCreated],
  ] as const)(
    "every SessionEvent is an EventEnvelope: %s parses through the carrier",
    (_label, build) => {
      // The strict layer emits within the carrier contract: each registered
      // variant fixture re-parses through EventEnvelopeSchema, and the
      // subtype relation holds at compile time — the `EventEnvelope`
      // annotation below is the static leg (the variants extend the
      // envelope interface since the T1.3 refactor).
      const parsed: EventEnvelope = SessionEventSchema.parse(build());
      expect(EventEnvelopeSchema.safeParse(parsed).success).toBe(true);
    },
  );
});

// --------------------------------------------------------------------------
// Plan-006 T1.4 — CapabilityDetailsSchema: canonical capability snapshot.
// --------------------------------------------------------------------------
//
// Backstops the two capability rows of Spec-006 §Runtime Node Lifecycle
// (runtime_node_lifecycle) — `runtime_node.capability_declared` /
// `runtime_node.capability_updated`, whose payload snapshot shape this schema
// is — per the canonical wire shape in api-payload-contracts.md §Plan-006
// (CP-006-5, closes Plan-005 CP-005-5). The load-bearing pins:
//   • NON-NORMALIZING: parse output is structurally identical to accepted
//     input (the daemon emitter persists the PARSED output, so any
//     default-filling or stripping arm would rewrite stored payloads). The
//     discriminator vs the ingress `ProviderToolMetadataSchema`: a tool
//     entry MISSING `idempotency_class` REJECTS here, where the ingress
//     normalizer would default-fill `manual_reconcile_only`.
//   • EXHAUSTIVE flags: enum-keyed record over the live
//     `DRIVER_CAPABILITY_FLAGS` const — a missing member, an unknown key,
//     and a non-boolean value all reject. Fixtures DERIVE from the const
//     (no hardcoded flag names or counts), so Plan-005 T1.7's scheduled
//     flag widening flows through this suite without edits.

// Cast justified: `Object.fromEntries` widens keys to `string`, but the map
// runs over the exhaustive `DRIVER_CAPABILITY_FLAGS` const, so every member
// is present exactly once.
const buildAllCapabilityFlags = (): Record<DriverCapabilityFlag, boolean> =>
  Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, true])) as Record<
    DriverCapabilityFlag,
    boolean
  >;

// Typed `(): CapabilityDetails` return — the static leg: a fixture that
// drifts from the exported interface is a compile error, not a runtime
// surprise (same annotation idiom as the C5 consumer anchor in
// runtime-node.test.ts).
const buildCapabilityDetails = (): CapabilityDetails => ({
  flags: buildAllCapabilityFlags(),
  contractVersion: "1.0",
  tools: [
    { name: "read_file", idempotency_class: "idempotent" },
    {
      name: "apply_patch",
      idempotency_class: "compensable",
      description: "Applies a unified diff to the session worktree.",
    },
  ],
});

describe("CapabilityDetailsSchema (T1.4: canonical capability snapshot)", () => {
  it("accepts a canonical snapshot and round-trips it verbatim (non-normalizing)", () => {
    const input = buildCapabilityDetails();
    const result = CapabilityDetailsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      // toStrictEqual: no key added (no `.default()`), none dropped (no
      // stripping) — output ≡ input, the persisted-parse-output invariant.
      expect(result.data).toStrictEqual(input);
    }
  });

  it.each([...DRIVER_CAPABILITY_FLAGS])(
    "rejects a flags map missing the %s member (enum-keyed record is exhaustive)",
    (flag) => {
      const { [flag]: _omitted, ...partialFlags } = buildAllCapabilityFlags();
      expect(
        CapabilityDetailsSchema.safeParse({ ...buildCapabilityDetails(), flags: partialFlags })
          .success,
      ).toBe(false);
    },
  );

  it("rejects an unknown flag key (enum keys reject out-of-census additions)", () => {
    const broken = {
      ...buildCapabilityDetails(),
      flags: { ...buildAllCapabilityFlags(), not_a_registered_flag: true },
    };
    expect(CapabilityDetailsSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a non-boolean flag value", () => {
    const [firstFlag] = DRIVER_CAPABILITY_FLAGS;
    const broken = {
      ...buildCapabilityDetails(),
      flags: { ...buildAllCapabilityFlags(), [firstFlag]: "true" },
    };
    expect(CapabilityDetailsSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    ["whitespace-only", "   "],
    ["NUL-byte", "1.0\u0000x"],
    ["oversized", "x".repeat(CAPABILITY_CONTRACT_VERSION_MAX_LEN + 1)],
  ] as const)("rejects a %s contractVersion (wireFreeFormString guards)", (_label, bad) => {
    const broken = { ...buildCapabilityDetails(), contractVersion: bad };
    expect(CapabilityDetailsSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a contractVersion at exactly the length cap (boundary)", () => {
    const ok = {
      ...buildCapabilityDetails(),
      contractVersion: "x".repeat(CAPABILITY_CONTRACT_VERSION_MAX_LEN),
    };
    expect(CapabilityDetailsSchema.safeParse(ok).success).toBe(true);
  });

  it("REJECTS a tool entry missing idempotency_class (non-normalizing pin vs ingress normalizer)", () => {
    // The ingress `ProviderToolMetadataSchema` would default-fill
    // `manual_reconcile_only` here; the event-snapshot schema must NOT — a
    // default-filling arm would make persisted parse output diverge from the
    // wire bytes. Rejection is the discriminator between the two schemas.
    const broken = { ...buildCapabilityDetails(), tools: [{ name: "read_file" }] };
    expect(CapabilityDetailsSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown key inside a tool entry (.strict at the element level)", () => {
    const broken = {
      ...buildCapabilityDetails(),
      tools: [{ name: "read_file", idempotency_class: "idempotent", vendorExtra: true }],
    };
    expect(CapabilityDetailsSchema.safeParse(broken).success).toBe(false);
  });

  // tools.name / tools.description compose `wireFreeFormString` — labeled
  // negatives proving the tool-entry strings are NOT bare `z.string()`s
  // (mirrors the contractVersion guard table above; the caps are the
  // provider-driver.ts per-field constants).
  it.each([
    ["NUL-byte tools.name", { name: "read_file\u0000x", idempotency_class: "idempotent" }],
    [
      "oversized tools.name",
      { name: "x".repeat(DRIVER_TOOL_NAME_MAX_LEN + 1), idempotency_class: "idempotent" },
    ],
    [
      "oversized tools.description",
      {
        name: "read_file",
        idempotency_class: "idempotent",
        description: "x".repeat(DRIVER_TOOL_DESCRIPTION_MAX_LEN + 1),
      },
    ],
  ] as const)("rejects a %s (wireFreeFormString guards on tool entries)", (_label, badTool) => {
    const broken = { ...buildCapabilityDetails(), tools: [badTool] };
    expect(CapabilityDetailsSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts description present and absent on tool entries (optional both ways)", () => {
    // The canonical fixture already carries one tool WITH `description` and
    // one WITHOUT — this pin makes the both-ways acceptance explicit.
    const bothWays = buildCapabilityDetails();
    expect(bothWays.tools.some((tool) => "description" in tool)).toBe(true);
    expect(bothWays.tools.some((tool) => !("description" in tool))).toBe(true);
    expect(CapabilityDetailsSchema.safeParse(bothWays).success).toBe(true);
  });

  it("accepts an empty tools array (a capability may declare zero tools)", () => {
    const ok = { ...buildCapabilityDetails(), tools: [] };
    expect(CapabilityDetailsSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects a top-level unknown member (.strict drift guard)", () => {
    const broken = { ...buildCapabilityDetails(), vendorExtension: {} };
    expect(CapabilityDetailsSchema.safeParse(broken).success).toBe(false);
  });

  it.each([["flags"], ["contractVersion"], ["tools"]] as const)(
    "rejects a snapshot missing the required %s member",
    (member) => {
      const { [member]: _omitted, ...withoutMember } = buildCapabilityDetails();
      expect(CapabilityDetailsSchema.safeParse(withoutMember).success).toBe(false);
    },
  );
});
