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
// Spec-006 §Event Type Summary at the post-B18 census (156 types across 20
// categories — T1.2 registered 141/19 and T1.10 closed the B18 delta),
// invariants I-006-1-01 (category/type bijection) and
// I-006-1-02 (event-type-string immutability). Plan-006 T1.3 adds the
// EventEnvelopeSchema canonical-carrier suite after it: the 11-member
// canonical-set pin (I-006-1-03), envelope-vs-strict layering,
// producer-set `version` semantics (I-006-1-04), and the payload
// own-`__proto__` reject-loud carve-out (record parser cannot preserve
// that key; silent stripping is forbidden), which T1.10 extends with the
// daemon-scope sentinel pin (Spec-006 §Daemon-Scope Event Binding And
// Node-Scope Anchoring — the B18 `mcp_governance` binding costs the
// carrier no carve-out). Plan-006 T1.4 appends the
// `CapabilityDetailsSchema` suite last: the canonical capability snapshot
// for the `runtime_node.capability_*` payload binding (exhaustive
// enum-keyed flags; non-normalizing strict tools). Plan-006 T1.11 extends
// coverage with the six-variant acceptance/rejection suite for the
// `audit_integrity` + `event_maintenance` payload variants Plan-006 emits
// itself — including the `failureMode`-discriminated `audit_integrity_failed`
// arms and the daemon-scope sentinel binding — and ends with the
// standalone-vs-union parity block for the six `*EventSchema` exports, on the
// worktree.test.ts precedent (outer `.strict()` has no compile-time backstop).
//
// Plan-006 T1.12 appends the LAST block: the five `runtime_node.*` variants
// (CP-003-1 leg (a)) whose payload schemas Plan-003 authors in runtime-node.ts
// — acceptance / rejection, the five-of-seven registration boundary
// (`degraded` / `revoked` stay census-only), the T1.4 tolerant-union arms
// registered exactly as shipped, real-`sessionId` binding (NOT the
// daemon-scope sentinel), the payload-narrows-the-envelope compile pins, the
// standalone-vs-union parity block for the five `RuntimeNode*EventSchema`
// exports, and the module-cycle TRIPWIRE that pins clean init from BOTH entry
// orders plus the `event-core.ts` leaf's import set.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  APPROVAL_FLOW_EVENT_TYPES,
  ARTIFACT_PUBLICATION_EVENT_TYPES,
  ASSISTANT_OUTPUT_EVENT_TYPES,
  AUDIT_INTEGRITY_DETAIL_MAX_LEN,
  AUDIT_INTEGRITY_EVENT_TYPES,
  AuditIntegrityFailedEventSchema,
  AuditIntegrityVerifiedEventSchema,
  CAPABILITY_CONTRACT_VERSION_MAX_LEN,
  CapabilityDetailsSchema,
  CHANNEL_ARBITRATION_EVENT_TYPES,
  compareEventEnvelopeVersion,
  CROSS_NODE_DISPATCH_EVENT_TYPES,
  EVENT_ENVELOPE_SEQUENCE_MAX,
  EVENT_ENVELOPE_VERSION_MAX_LEN,
  EVENT_ENVELOPE_VERSION_PATTERN,
  EVENT_FIELD_MAX_LEN,
  EVENT_MAINTENANCE_EVENT_TYPES,
  EventCategorySchema,
  EventCompactedEventSchema,
  EventEnvelopeSchema,
  EventEnvelopeVersionSchema,
  EventShreddedEventSchema,
  INTERACTIVE_REQUEST_EVENT_TYPES,
  KeyReuseDetectedEventSchema,
  MCP_GOVERNANCE_EVENT_TYPES,
  MEMBERSHIP_CHANGE_EVENT_TYPES,
  ONBOARDING_LIFECYCLE_EVENT_TYPES,
  PARTICIPANT_LIFECYCLE_EVENT_TYPES,
  POLICY_EVENTS_EVENT_TYPES,
  RECOVERY_EVENTS_EVENT_TYPES,
  RUN_LIFECYCLE_EVENT_TYPES,
  RUNTIME_NODE_LIFECYCLE_EVENT_TYPES,
  RuntimeNodeCapabilityDeclaredEventSchema,
  RuntimeNodeCapabilityUpdatedEventSchema,
  RuntimeNodeOfflineEventSchema,
  RuntimeNodeOnlineEventSchema,
  RuntimeNodeRegisteredEventSchema,
  SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN,
  SchemaMigratedEventSchema,
  SECURITY_EVENTS_EVENT_TYPES,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  SESSION_LIFECYCLE_EVENT_TYPES,
  SessionEventSchema,
  TOOL_ACTIVITY_EVENT_TYPES,
  USAGE_TELEMETRY_EVENT_TYPES,
  VerifierFailureModeSchema,
  VerifierFailurePathSchema,
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
// The Plan-003-authored payload surface the T1.12 arms register. Imported here
// (not restated) for the same single-sourcing reason event.ts imports it: a
// fixture built against a local copy would keep passing after the real shape
// moved.
import {
  RuntimeNodeCapabilityDeclaredPayloadSchema,
  RuntimeNodeCapabilityUpdatedPayloadSchema,
  RuntimeNodeOfflinePayloadSchema,
  RuntimeNodeOnlinePayloadSchema,
  RuntimeNodeRegisteredPayloadSchema,
  type RuntimeNodeCapabilityDeclaredPayload,
  type RuntimeNodeCapabilityUpdatedPayload,
  type RuntimeNodeOfflinePayload,
  type RuntimeNodeOnlinePayload,
  type RuntimeNodeRegisteredPayload,
} from "../runtime-node.js";
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
  it("registers exactly the payload-variant roster (Plan-001 three + Plan-009 six + Plan-010 five + Plan-006 six + Plan-003 five)", () => {
    // The SCHEMA-registered subset (25), not the 156-type census. It grew by
    // the six Plan-009 repo/workspace variants (CP-009-4), the five Plan-010
    // worktree variants (CP-010-5), the six Plan-006 audit-integrity /
    // event-maintenance variants (T1.11), and the five Plan-003
    // `runtime_node.*` variants (T1.12 — CP-003-1 leg (a)); each group's
    // round-trip and payload coverage lives in the suite that owns its
    // contract (repo.test.ts / worktree.test.ts / runtime-node.test.ts for the
    // payload shapes, and the T1.11 + T1.12 suites at the end of this file,
    // Plan-006 owning this module and the union registration).
    expect(SESSION_EVENT_TYPES).toEqual([
      "session.created",
      "membership.created",
      "channel.created",
      "repo.attached",
      "repo.detached",
      "workspace.provisioning",
      "workspace.ready",
      "workspace.stale",
      "workspace.archived",
      "worktree.created",
      "worktree.ready",
      "worktree.dirty",
      "worktree.merged",
      "worktree.retired",
      "audit_integrity_verified",
      "audit_integrity_failed",
      "key_reuse_detected",
      "schema.migrated",
      "event.compacted",
      "event.shredded",
      "runtime_node.registered",
      "runtime_node.online",
      "runtime_node.offline",
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
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

  it("EventCategorySchema enumerates exactly the 20 canonical categories (no more, no less)", () => {
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
      "mcp_governance",
    ];
    // Read `.options` from the underlying enum construct. The schema is
    // typed as the abstract `z.ZodType<EventCategory>` so we cast via
    // `unknown` to read the construct-specific `.options` property; the
    // assertions below check both length AND exact set membership.
    const schemaInternals = EventCategorySchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toHaveLength(20);
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
// Backstops Spec-006 §Event Type Summary at its full post-B18 census (156
// types across 20 categories — T1.2 registered the 141/19 baseline, T1.10
// closed the 2026-07-22 B18 delta of fifteen literals and the
// `mcp_governance` category) plus the two Phase-1 invariants:
//   • I-006-1-01 — category/type bijection: SESSION_EVENT_CATEGORY_BY_TYPE
//     covers every registered type exactly once, its values span exactly
//     the 20 canonical categories (every category non-empty), and the 20
//     per-category arrays partition the census.
//   • I-006-1-02 — event-type-string immutability: the three Plan-001 wire
//     literals are unrenamed with unchanged categories, and the SCHEMA-
//     registered payload subset grows only ADDITIVELY (those three; the six
//     Plan-009 repo/workspace variants of CP-009-4 and the five Plan-010
//     worktree variants of CP-010-5, which reach the union through the
//     cross-plan registration seam; and the six Plan-006 `audit_integrity` /
//     `event_maintenance` variants T1.11 authors in event.ts itself, Plan-006
//     emitting them — whose literals the census already carried, so
//     registering their payloads moved no census row).
//     The B18 widening is likewise additive-only: it renamed nothing, and
//     every pre-B18 census row keeps its literal and category (pinned by
//     the per-category counts below, which move ONLY on the five B18 rows).
// Assertions are exact-set style wherever set equality is feasible (the
// hardened idiom of the EventCategorySchema pin above), with the
// AC-verbatim size assertions (size === 156, 20 distinct categories)
// alongside.

// Expected census, transcribed from Spec-006 §Event Type Summary aggregated
// per category. Exactly five rows carry the 2026-07-22 B18 delta T1.10
// landed: session_lifecycle 28→31 (session 9→12, channel/agent 7,
// repo/workspace/worktree 11, pty 1); run_lifecycle 10→13;
// interactive_request 15→16 (queue 5, intervention 6, driver ask 4, user
// message 0→1); usage_telemetry 5→8; mcp_governance 0→5 (the category is
// B18's own). Every OTHER row is B18-untouched at its T1.2 value — that
// invariance is what makes the widening auditable as additive rather than a
// reshuffle. Rows sum to 156 (asserted below), mirroring the census table's
// Total row.
const CENSUS_BASELINE: ReadonlyArray<
  readonly [EventCategory, readonly SessionEventType[], number]
> = [
  ["run_lifecycle", RUN_LIFECYCLE_EVENT_TYPES, 13],
  ["assistant_output", ASSISTANT_OUTPUT_EVENT_TYPES, 2],
  ["tool_activity", TOOL_ACTIVITY_EVENT_TYPES, 7],
  ["interactive_request", INTERACTIVE_REQUEST_EVENT_TYPES, 16],
  ["artifact_publication", ARTIFACT_PUBLICATION_EVENT_TYPES, 6],
  ["membership_change", MEMBERSHIP_CHANGE_EVENT_TYPES, 13],
  ["session_lifecycle", SESSION_LIFECYCLE_EVENT_TYPES, 31],
  ["approval_flow", APPROVAL_FLOW_EVENT_TYPES, 8],
  ["usage_telemetry", USAGE_TELEMETRY_EVENT_TYPES, 8],
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
  ["mcp_governance", MCP_GOVERNANCE_EVENT_TYPES, 5],
];

// The fifteen literals the 2026-07-22 Spec-006 B18 amendment minted, each
// with the category it registered under. T1.10 INVERTED what this fixture
// pins, exactly as its predecessor comment required: it held plain strings
// asserted ABSENT from the census (the 141/19 baseline's forward boundary);
// it now holds census members asserted PRESENT under a named category.
//
// The element type is load-bearing, not decoration. `SessionEventType` is
// the census union itself, so a literal that failed to register — or that a
// later edit renames, which I-006-1-02 forbids — is a COMPILE error under
// `tsc -p tsconfig.test.json` (the package's `typecheck` leg; vitest strips
// types and would not catch it). The runtime assertions below pin the
// category half and the 141 + 15 = 156 arithmetic.
const B18_MINTED_TYPES: ReadonlyArray<readonly [SessionEventType, EventCategory]> = [
  ["session.provider_status", "session_lifecycle"],
  ["session.notice", "session_lifecycle"],
  ["session.renamed", "session_lifecycle"],
  ["run.provider_initialized", "run_lifecycle"],
  ["run.turn_started", "run_lifecycle"],
  ["run.worker_shutdown", "run_lifecycle"],
  ["usage.api_retry", "usage_telemetry"],
  ["usage.context_compacted", "usage_telemetry"],
  ["usage.model_rerouted", "usage_telemetry"],
  ["user.message", "interactive_request"],
  ["mcp.server_status_changed", "mcp_governance"],
  ["mcp.server_config_changed", "mcp_governance"],
  ["mcp.server_trust_changed", "mcp_governance"],
  ["mcp.tool_override_changed", "mcp_governance"],
  ["mcp.server_oauth_completed", "mcp_governance"],
];

describe("SessionEventType census + SESSION_EVENT_CATEGORY_BY_TYPE registry (T1.2)", () => {
  it("registers exactly 156 types across exactly 20 distinct categories (I-006-1-01 sizes)", () => {
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.size).toBe(156);
    expect(new Set(SESSION_EVENT_CATEGORY_BY_TYPE.values()).size).toBe(20);
  });

  it("registry categories span exactly the canonical EventCategory set (no empty category)", () => {
    // Exact-set against the T1.1 schema surface (same `.options` cast idiom
    // as the EventCategorySchema pin above): the surjective side of the
    // bijection — every canonical category has at least one registered type.
    const schemaInternals = EventCategorySchema as unknown as { options: readonly string[] };
    const registryCategories = [...new Set(SESSION_EVENT_CATEGORY_BY_TYPE.values())].sort();
    expect(registryCategories).toEqual([...schemaInternals.options].sort());
  });

  it("census table is complete: 20 rows, one per category, counts summing to 156", () => {
    const tableCategories = CENSUS_BASELINE.map(([category]) => category);
    expect(tableCategories).toHaveLength(20);
    expect(new Set(tableCategories).size).toBe(20);
    const total = CENSUS_BASELINE.reduce((sum, [, , expectedCount]) => sum + expectedCount, 0);
    expect(total).toBe(156);
  });

  it.each(CENSUS_BASELINE)(
    "%s: per-category array equals the registry partition, count pinned to the Spec-006 census",
    (category, categoryTypes, expectedCount) => {
      // Census-row pin (Spec-006 §Event Type Summary, aggregated per
      // category at the post-B18 census).
      expect(categoryTypes).toHaveLength(expectedCount);
      // No intra-array duplicates: distinct-member count equals length.
      expect(new Set(categoryTypes).size).toBe(expectedCount);
      // Exact set equality vs the registry's keys filtered to this category
      // — the I-006-1-01 anti-drift bind between arrays and registry. This
      // also forces pairwise-disjoint arrays: each registry key carries
      // exactly one category, so the 20 filtered key sets are disjoint.
      const registryKeysInCategory = [...SESSION_EVENT_CATEGORY_BY_TYPE.entries()]
        .filter(([, registeredCategory]) => registeredCategory === category)
        .map(([eventType]) => eventType)
        .sort();
      expect([...categoryTypes].sort()).toEqual(registryKeysInCategory);
    },
  );

  it("the 20 per-category arrays partition the registry key set exactly", () => {
    const aggregated = CENSUS_BASELINE.flatMap(([, categoryTypes]) => [...categoryTypes]);
    expect(aggregated).toHaveLength(156);
    expect(new Set(aggregated).size).toBe(156);
    expect([...aggregated].sort()).toEqual([...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].sort());
  });

  it("keeps the three Plan-001 wire literals unrenamed with unchanged categories (I-006-1-02)", () => {
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get("session.created")).toBe("session_lifecycle");
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get("membership.created")).toBe("membership_change");
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get("channel.created")).toBe("session_lifecycle");
    // The census widening is additive-only, and the SCHEMA-registered
    // payload subset grows ONLY through each emitting plan's
    // union-registration seam — the three Plan-001 variants, the six
    // Plan-009 repo/workspace variants (CP-009-4), the five Plan-010
    // worktree variants (CP-010-5), the six Plan-006 audit-integrity /
    // event-maintenance variants (T1.11, emitted by the plan that owns
    // event.ts), and the five Plan-003 `runtime_node.*` variants (T1.12 —
    // CP-003-1 leg (a), the payload shapes authored in runtime-node.ts) —
    // whose type strings were all already census-registered by
    // T1.2 before their payloads landed. The loop below
    // is the bind that matters: every registered variant must be a census
    // member, so a variant registered under an unregistered literal fails
    // here.
    expect(SESSION_EVENT_TYPES).toEqual([
      "session.created",
      "membership.created",
      "channel.created",
      "repo.attached",
      "repo.detached",
      "workspace.provisioning",
      "workspace.ready",
      "workspace.stale",
      "workspace.archived",
      "worktree.created",
      "worktree.ready",
      "worktree.dirty",
      "worktree.merged",
      "worktree.retired",
      "audit_integrity_verified",
      "audit_integrity_failed",
      "key_reuse_detected",
      "schema.migrated",
      "event.compacted",
      "event.shredded",
      "runtime_node.registered",
      "runtime_node.online",
      "runtime_node.offline",
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
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

  it("the census minus the B18 fifteen is exactly the 141-type T1.2 baseline", () => {
    // Completeness self-check for the B18_MINTED_TYPES fixture (the same
    // row-sum bind CENSUS_BASELINE gets above), re-formed for the post-flip
    // state: the pre-B18 arithmetic was `141 registered + 15 absent = 156`;
    // now that all fifteen ARE registered it runs the other way, `156 − 15
    // = 141`, pinning the delta's SIZE so the widening cannot be over- or
    // under-counted. A dropped or duplicated fixture entry fails here
    // instead of leaving 14 passing per-literal pins.
    expect(B18_MINTED_TYPES).toHaveLength(15);
    expect(new Set(B18_MINTED_TYPES.map(([eventType]) => eventType)).size).toBe(15);
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.size - B18_MINTED_TYPES.length).toBe(141);
    // Removing the fifteen leaves exactly 141 keys — the T1.2 baseline
    // SIZE. This is a cardinality bind, not an identity one: a rename
    // edited in both the record and its per-category array would still
    // land on 141. Additive-only (I-006-1-02) is pinned by name elsewhere
    // — the three Plan-001 literals and the ten prefix-mismatch rows below,
    // plus CENSUS_BASELINE's per-category counts, where only the five
    // B18-touched rows moved.
    const minted = new Set<string>(B18_MINTED_TYPES.map(([eventType]) => eventType));
    const remaining = [...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].filter(
      (eventType) => !minted.has(eventType),
    );
    expect(remaining).toHaveLength(141);
  });

  it.each([...B18_MINTED_TYPES])(
    "B18-minted literal %s is registered under %s (T1.10 census closure)",
    (mintedType, expectedCategory) => {
      // The inversion of this suite's pre-flip pins: each of the fifteen
      // was asserted ABSENT from the 141-type baseline; each is now
      // asserted PRESENT under the category Spec-006 §Event Type Summary
      // assigns it. One `.get()` proves both halves — an unregistered
      // literal returns `undefined`, and a literal registered under the
      // wrong category returns the wrong value. (The element type already
      // proved registration at COMPILE time; this adds the category.)
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(mintedType)).toBe(expectedCategory);
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

  // ------------------------------------------------------------------------
  // `sequence` ceiling — an injectivity requirement, not a capacity estimate.
  // ------------------------------------------------------------------------
  //
  // WHAT THESE TWO PIN, AND WHAT THEY DELIBERATELY DO NOT. `.int()` already
  // bounds `sequence` to the safe-integer range on its own, so `success` alone
  // is NOT a discriminating assertion here — it reads identically with and
  // without `EVENT_ENVELOPE_SEQUENCE_MAX`. What the named bound adds is the
  // DIAGNOSIS, so the reject test asserts on the message; that is the assertion
  // that fails if the `.max()` is ever dropped.
  //
  // Neither test covers the path the bound actually exists for: `sequence`
  // above 2^53 − 1 collapses onto a shared IEEE-754 double, so two different
  // events would canonicalize to identical bytes and collide on `row_hash`, and
  // a caller reaches the hash chain WITHOUT parsing. That enforcement lives at
  // `canonicalizeEvent` in the daemon, and its tests live beside it.

  it("accepts a sequence at exactly EVENT_ENVELOPE_SEQUENCE_MAX (boundary)", () => {
    expect(EVENT_ENVELOPE_SEQUENCE_MAX).toBe(Number.MAX_SAFE_INTEGER);
    const atCeiling = EventEnvelopeSchema.safeParse({
      ...buildBareEnvelope(),
      sequence: EVENT_ENVELOPE_SEQUENCE_MAX,
    });
    expect(atCeiling.success).toBe(true);
  });

  it("rejects a sequence one above the ceiling, naming the collision hazard", () => {
    const overCeiling = EventEnvelopeSchema.safeParse({
      ...buildBareEnvelope(),
      sequence: EVENT_ENVELOPE_SEQUENCE_MAX + 1,
    });
    expect(overCeiling.success).toBe(false);
    // The discriminating half. `.int()`'s own bound would already have failed
    // the parse with a bare "too big"; only the named `.max()` explains that
    // the ceiling protects hash-chain injectivity. Issue COUNT is deliberately
    // not asserted — both checks firing is correct and informative, but pinning
    // the count would couple this test to Zod's internals.
    const issueMessages = overCeiling.error?.issues.map((issue) => issue.message) ?? [];
    expect(issueMessages.some((message) => /collide in the row_hash chain/.test(message))).toBe(
      true,
    );
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
    // A reader must be able to parse the ENVELOPE (to persist it as a
    // version stub) for a type from a NEWER producer that this build's
    // census does not know at all — rejecting here would drop exactly the
    // events the stub path exists to preserve.
    //
    // The literal is deliberately fictional (the `session.exploded` idiom
    // used by the unknown-discriminator pin above), and its absence from
    // the census is asserted MECHANICALLY rather than asserted in prose.
    // That guard is the point: this test previously used `session.renamed`
    // — then a B18-pending literal — and T1.10's census closure registered
    // it, which would have left the test green while its stated premise
    // ("outside today's census union entirely") had quietly become false.
    // A census-registered literal exercises the layering pin above, not
    // this one.
    const forwardType = "session.teleported";
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(forwardType as never)).toBeUndefined();
    const forward = {
      ...buildBareEnvelope(),
      category: "session_lifecycle" as const,
      type: forwardType,
      payload: { sessionId: SESSION_ID, destination: "elsewhere" },
    };
    expect(EventEnvelopeSchema.safeParse(forward).success).toBe(true);
    expect(SessionEventSchema.safeParse(forward).success).toBe(false);
  });

  it("carries the daemon-scope sentinel with no schema carve-out (B18 mcp_governance)", () => {
    // Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring binds
    // the four node-scope `mcp_governance` types to the RFC 9562 §5.10 Max
    // UUID sentinel, with a session-scoped initiator living in the payload
    // as `initiatingSessionId` — never in the row's own `sessionId`.
    // Choosing the sentinel is a producer obligation; what makes it FREE at
    // this layer is that the `sessionId` UUID check already admits the Max
    // UUID IN ITS CANONICAL LOWERCASE FORM, so no sentinel branch and no
    // widened field type are needed. The case qualifier is load-bearing:
    // Zod's unversioned uuid regex reaches the Max UUID only through a
    // lowercase string-literal alternative carrying no `i` flag, and the
    // general alternative demands a `[1-8]` version nibble that `f` fails —
    // so `FFFFFFFF-…` is REJECTED even though RFC 9562 §4 makes UUID text
    // case-insensitive. The producer obligation for Plan-028 is therefore
    // "emit the sentinel lowercase," not merely "emit the sentinel." No
    // uppercase-rejection assertion is pinned here on purpose: that would
    // freeze a Zod regex quirk, and a future Zod case-handling fix would
    // turn the pin red for a fix rather than a regression.
    // Pinning the Max-UUID acceptance means a future tightening of that
    // check (a v4-only constraint, say) fails HERE rather than silently
    // making every node-scope governance event unrepresentable on the wire.
    // The sentinel is deliberately disjoint from the `gen_random_uuid()` v4
    // space real sessions draw from, so a sentinel-partitioned chain cannot
    // collide with a real session's. The payload carries only
    // `initiatingSessionId` — Spec-028 owns the rest of the governance
    // payload shape, and the carrier treats `payload` as opaque anyway.
    const DAEMON_SCOPE_SENTINEL = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const nodeScopeGovernanceEvent = {
      ...buildBareEnvelope(),
      sessionId: DAEMON_SCOPE_SENTINEL,
      category: "mcp_governance" as const,
      type: "mcp.server_config_changed",
      payload: { initiatingSessionId: SESSION_ID },
    };
    const parsed = EventEnvelopeSchema.safeParse(nodeScopeGovernanceEvent);
    expect(parsed.success).toBe(true);
    // The sentinel survives the parse verbatim: it lands in the canonical
    // bytes like any other `sessionId`, never normalized or nulled away.
    expect(parsed.success && parsed.data.sessionId).toBe(DAEMON_SCOPE_SENTINEL);
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

// --------------------------------------------------------------------------
// The six Plan-006 payload variants (T1.11).
// --------------------------------------------------------------------------
//
// `audit_integrity` (3) + `event_maintenance` (3) — the only registered
// variants Plan-006 emits itself, so their payload schemas are authored in
// event.ts rather than imported from an emitting plan's module. Coverage is
// deliberately variant-level (through `SessionEventSchema`) rather than
// payload-level: registration into the union is half of what T1.11 ships, and
// a payload-only suite would stay green if an arm were never registered.

const NODE_ID = "node-7f3a2c";
// RFC 9562 §5.10 Max UUID, LOWERCASE — the daemon-scope sentinel of Spec-006
// §Daemon-Scope Event Binding And Node-Scope Anchoring. The case matters (see
// the carrier-level sentinel pin above); no uppercase-rejection assertion is
// added here, on the same reasoning that declines one there.
const SENTINEL_SESSION_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
// A SECOND real session id. `observedIdentities[].sessionId` and
// `affectedSessionIds[]` are session ids; the file's `CHANNEL_ID` fixture
// would parse there (both are `SessionId`-shaped UUIDs) but would misdocument
// which identity space the member lives in.
const OTHER_SESSION_ID = "990e8400-e29b-41d4-a716-446655440004";
// 64-char lowercase hex — the house digest spelling. The schema accepts any
// bounded free-form string here (no authority pins the member's wire form),
// so this fixture documents the emitter's convention, it does not pin it.
const ROOT_HASH = "0f".repeat(32);
// Built at runtime rather than spelled as a unicode escape, so the control
// character never lands in these source bytes.
const NUL_BEARING_ALGORITHM = `ed25519${String.fromCharCode(0)}x`;
const OTHER_ROOT_HASH = "1a".repeat(32);

const buildAuditIntegrityVerified = () => ({
  id: "evt-0100",
  sessionId: SESSION_ID,
  sequence: 100,
  occurredAt: "2026-01-22T19:14:35.000Z",
  category: "audit_integrity" as const,
  type: "audit_integrity_verified" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    anchorId: "anchor-0007",
    verifierNodeId: NODE_ID,
    treeSize: 4096,
    rootHash: ROOT_HASH,
    fromSeq: 1,
    toSeq: 4096,
    verifiedAt: "2026-01-22T19:14:35.000Z",
    signatureAlgorithm: "ed25519",
  },
});

const buildAuditIntegrityFailedVerifierArm = () => ({
  id: "evt-0101",
  sessionId: SESSION_ID,
  sequence: 101,
  occurredAt: "2026-01-22T19:14:36.000Z",
  category: "audit_integrity" as const,
  type: "audit_integrity_failed" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    verifierNodeId: NODE_ID,
    treeSize: 4096,
    expectedRootHash: ROOT_HASH,
    observedRootHash: OTHER_ROOT_HASH,
    failureMode: "hash_mismatch",
    failurePath: "inclusion",
    offendingSeq: 2048,
    detail: "row 2048 hashes to a different row_hash than its successor's prev_hash",
  },
});

const buildAuditIntegrityFailedRegistrarArm = () => ({
  id: "evt-0102",
  sessionId: SESSION_ID,
  sequence: 102,
  occurredAt: "2026-01-22T19:14:37.000Z",
  category: "audit_integrity" as const,
  type: "audit_integrity_failed" as const,
  actor: null,
  version: VERSION,
  payload: {
    // The refused registration's REAL session id, never the sentinel.
    sessionId: SESSION_ID,
    verifierNodeId: NODE_ID,
    failureMode: "signing_key_slot_conflict",
    failurePath: "signature",
    detail: `slot (${SESSION_ID}, ${NODE_ID}) holds a key this daemon never minted`,
  },
});

const buildKeyReuseDetected = () => ({
  id: "evt-0103",
  sessionId: SENTINEL_SESSION_ID,
  sequence: 103,
  occurredAt: "2026-01-22T19:14:38.000Z",
  category: "audit_integrity" as const,
  type: "key_reuse_detected" as const,
  actor: null,
  version: VERSION,
  payload: {
    offendingKeyFingerprint: ROOT_HASH,
    observedIdentities: [
      { sessionId: SESSION_ID, nodeId: NODE_ID },
      { sessionId: OTHER_SESSION_ID, nodeId: "node-b41d" },
    ],
    firstSeenAt: "2026-01-22T18:00:00.000Z",
    rotationInvariantViolated: "refuse_on_rotation",
    detectorNodeId: NODE_ID,
  },
});

const buildSchemaMigrated = () => ({
  id: "evt-0104",
  sessionId: SENTINEL_SESSION_ID,
  sequence: 104,
  occurredAt: "2026-01-22T19:14:39.000Z",
  category: "event_maintenance" as const,
  type: "schema.migrated" as const,
  actor: null,
  version: VERSION,
  payload: {
    nodeId: NODE_ID,
    operationId: "migrate-2026-01-22-01",
    occurredAt: "2026-01-22T19:14:39.000Z",
    fromVersion: "0007",
    toVersion: "0009",
    migrationId: "0009-session-events-retention-class",
    description: "add retention_class + audit stub projection columns",
    checksum: ROOT_HASH,
    appliedBy: "sidekicks db migrate",
    executionMs: 412,
    success: true,
  },
});

const buildEventCompacted = () => ({
  id: "evt-0105",
  sessionId: SENTINEL_SESSION_ID,
  sequence: 105,
  occurredAt: "2026-01-22T19:14:40.000Z",
  category: "event_maintenance" as const,
  type: "event.compacted" as const,
  actor: null,
  version: VERSION,
  payload: {
    nodeId: NODE_ID,
    operationId: "compact-2026-01-22-01",
    occurredAt: "2026-01-22T19:14:40.000Z",
    fromSeq: 1,
    toSeq: 4096,
    eventsBefore: 4096,
    eventsAfter: 512,
    bytesReclaimed: 8_388_608,
    tombstoneCount: 3584,
    compactionReason: "age_threshold",
  },
});

const buildEventShredded = () => ({
  id: "evt-0106",
  sessionId: SENTINEL_SESSION_ID,
  sequence: 106,
  occurredAt: "2026-01-22T19:14:41.000Z",
  category: "event_maintenance" as const,
  type: "event.shredded" as const,
  actor: null,
  version: VERSION,
  payload: {
    nodeId: NODE_ID,
    operationId: "shred-2026-01-22-01",
    occurredAt: "2026-01-22T19:14:41.000Z",
    participantId: PARTICIPANT_ID,
    affectedSessionIds: [SESSION_ID, OTHER_SESSION_ID],
    piiPayloadsCleared: 27,
    shredReason: "gdpr_article_17",
  },
});

const REGISTRAR_FAILURE_MODE = "signing_key_slot_conflict";

// The registered modes READ OFF THE ENUM rather than re-spelled. The cast is
// the file's established idiom for reaching a construct-specific property
// through an erased `z.ZodType` annotation (the `EventCategorySchema` pin
// above). Exact membership is pinned once, against a hand-transcribed list, in
// the vocabulary test below — the tables here only DRIVE, so a seventeenth mode
// joins the per-mode coverage automatically instead of being silently skipped.
const VERIFIER_FAILURE_MODE_OPTIONS = (
  VerifierFailureModeSchema as unknown as { options: readonly string[] }
).options;

// The read-side verifier modes — every registered mode except the registrar's,
// which belongs to the other payload arm and is exercised separately. That
// split is the whole point of the discrimination, so the table derives it
// rather than restating it.
const VERIFIER_FAILURE_MODES = VERIFIER_FAILURE_MODE_OPTIONS.filter(
  (mode) => mode !== REGISTRAR_FAILURE_MODE,
);

const PLAN_006_VARIANTS = [
  ["audit_integrity_verified", buildAuditIntegrityVerified],
  ["audit_integrity_failed", buildAuditIntegrityFailedVerifierArm],
  ["audit_integrity_failed (registrar arm)", buildAuditIntegrityFailedRegistrarArm],
  ["key_reuse_detected", buildKeyReuseDetected],
  ["schema.migrated", buildSchemaMigrated],
  ["event.compacted", buildEventCompacted],
  ["event.shredded", buildEventShredded],
] as const;

// The four daemon-scope variants of Spec-006 §Daemon-Scope Event Binding And
// Node-Scope Anchoring. `audit_integrity_verified` / `audit_integrity_failed`
// are deliberately ABSENT: they carry the verified range's real session id.
const SENTINEL_BOUND_VARIANTS = [
  ["key_reuse_detected", buildKeyReuseDetected],
  ["schema.migrated", buildSchemaMigrated],
  ["event.compacted", buildEventCompacted],
  ["event.shredded", buildEventShredded],
] as const;

describe("audit_integrity + event_maintenance payload variants (T1.11)", () => {
  it.each(PLAN_006_VARIANTS)("round-trips %s through JSON without loss", (_label, build) => {
    const original = build();
    const firstPass = SessionEventSchema.parse(original);
    const offWire = JSON.parse(JSON.stringify(firstPass)) as unknown;
    expect(SessionEventSchema.parse(offWire)).toStrictEqual(firstPass);
    // No key added (no `.default()`), none dropped (`.strict()`, no stripping)
    // — parse output ≡ wire bytes, the canonical-bytes precondition.
    expect(firstPass).toStrictEqual(original);
  });

  it.each(PLAN_006_VARIANTS)(
    "%s carries the census category and rejects a mismatched one",
    (_label, build) => {
      const event = build();
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(event.type)).toBe(event.category);
      // `category` is in the BLAKE3-hashed canonical bytes, so a type/category
      // mismatch must die at parse time, never be coerced.
      expect(
        SessionEventSchema.safeParse({ ...event, category: "session_lifecycle" }).success,
      ).toBe(false);
    },
  );

  it.each(PLAN_006_VARIANTS)("%s rejects an unknown payload key (.strict)", (_label, build) => {
    const event = build();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, vendorExtension: "drift" },
      }).success,
    ).toBe(false);
  });

  it.each(PLAN_006_VARIANTS)(
    "%s rejects a sourceEpoch/sourcePosition stamp (non-admitting family)",
    (_label, build) => {
      // None of the six is run-scoped, so none is `withEpochStamp`-wrapped and
      // the strict payload refuses the stamp. The admission RULE is walked
      // over the live union in event-source-epoch.test.ts; this is the
      // wire-level consequence for these six branches.
      const event = build();
      expect(
        SessionEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, sourceEpoch: 1, sourcePosition: 5 },
        }).success,
      ).toBe(false);
    },
  );

  it.each(SENTINEL_BOUND_VARIANTS)(
    "%s accepts the lowercase Max-UUID daemon-scope sentinel as its sessionId",
    (_label, build) => {
      const event = build();
      expect(event.sessionId).toBe(SENTINEL_SESSION_ID);
      const parsed = SessionEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
      // The sentinel survives verbatim — never normalized, never nulled away.
      expect(parsed.success && parsed.data.sessionId).toBe(SENTINEL_SESSION_ID);
    },
  );

  it("registers EXACTLY the sixteen failure modes and the three failure paths", () => {
    // The exported vocabulary T4.1 and T4.10 consume, transcribed from
    // `Spec-006 §Audit Integrity (audit_integrity)` in the enum's own order.
    // Sixteen, not fifteen: the registrar's `signing_key_slot_conflict` is a
    // member of the enum even though it routes to the other payload arm.
    //
    // Set equality, not just acceptance — acceptance alone passes a
    // seventeenth mode, a dropped one, and a renamed one alike, and every
    // per-mode table below is DERIVED from `.options`, so this is the single
    // place where enum drift can be caught rather than absorbed.
    const expectedModes = [
      "hash_mismatch",
      "signature_mismatch",
      "anchor_mismatch",
      "inclusion_proof_failed",
      "consistency_proof_failed",
      "log_file_missing",
      "log_file_moved",
      "anchor_missing_for_compacted_range",
      "anchor_signature_invalid",
      "stub_signature_invalid",
      "stub_scalar_mismatch",
      "signature_placeholder",
      "occurred_at_not_canonical",
      "pii_ciphertext_digest_unbound",
      "pii_owner_stamp_unbound",
      REGISTRAR_FAILURE_MODE,
    ];
    expect(VERIFIER_FAILURE_MODE_OPTIONS).toHaveLength(16);
    expect([...VERIFIER_FAILURE_MODE_OPTIONS].sort()).toEqual([...expectedModes].sort());
    // The derivation the arm split rests on: fifteen read-side modes, the
    // registrar's excluded.
    expect(VERIFIER_FAILURE_MODES).toHaveLength(15);
    expect(VERIFIER_FAILURE_MODES).not.toContain(REGISTRAR_FAILURE_MODE);
    for (const mode of expectedModes) {
      expect(VerifierFailureModeSchema.safeParse(mode).success).toBe(true);
    }
    expect(VerifierFailureModeSchema.safeParse("not_a_registered_mode").success).toBe(false);

    const expectedPaths = ["inclusion", "consistency", "signature"];
    const pathOptions = (VerifierFailurePathSchema as unknown as { options: readonly string[] })
      .options;
    expect(pathOptions).toHaveLength(3);
    expect([...pathOptions].sort()).toEqual([...expectedPaths].sort());
    for (const path of expectedPaths) {
      expect(VerifierFailurePathSchema.safeParse(path).success).toBe(true);
    }
    expect(VerifierFailurePathSchema.safeParse("anchor").success).toBe(false);
  });

  it.each(VERIFIER_FAILURE_MODES)(
    "the verifier arm accepts failureMode %s carrying the Merkle triple",
    (failureMode) => {
      const event = buildAuditIntegrityFailedVerifierArm();
      expect(
        SessionEventSchema.safeParse({ ...event, payload: { ...event.payload, failureMode } })
          .success,
      ).toBe(true);
    },
  );

  it.each([["treeSize"], ["expectedRootHash"], ["observedRootHash"], ["detail"]] as const)(
    "the verifier arm REQUIRES %s",
    (member) => {
      const event = buildAuditIntegrityFailedVerifierArm();
      const { [member]: _omitted, ...payload } = event.payload;
      expect(SessionEventSchema.safeParse({ ...event, payload }).success).toBe(false);
    },
  );

  it("the verifier arm rejects failureMode signing_key_slot_conflict", () => {
    // The fifteen-mode discriminator EXCLUDES it, so a payload carrying the
    // triple under that mode dispatches to the registrar arm and dies there on
    // the triple's unknown keys. Either way it must not parse: a registrar
    // event can never claim roots.
    const event = buildAuditIntegrityFailedVerifierArm();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, failureMode: "signing_key_slot_conflict" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["treeSize", 4096],
    ["expectedRootHash", ROOT_HASH],
    ["offendingSeq", 12],
  ] as const)("the registrar arm rejects the verifier-only member %s", (member, value) => {
    // The arm split exists so the registrar — which walked no tree — cannot
    // fabricate roots. `.strict()` on the arm is what enforces it.
    const event = buildAuditIntegrityFailedRegistrarArm();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, [member]: value },
      }).success,
    ).toBe(false);
  });

  it("the registrar arm pins failurePath to signature", () => {
    const event = buildAuditIntegrityFailedRegistrarArm();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, failurePath: "inclusion" },
      }).success,
    ).toBe(false);
  });

  it("audit_integrity payloads take anchorId both ways (optional)", () => {
    const event = buildAuditIntegrityVerified();
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    const { anchorId: _absent, ...withoutAnchor } = event.payload;
    expect(SessionEventSchema.safeParse({ ...event, payload: withoutAnchor }).success).toBe(true);
  });

  it("the verifier arm takes offendingSeq both ways (optional)", () => {
    // Optional by design: a whole-range failure (`log_file_missing`,
    // `anchor_missing_for_compacted_range`) implicates no single row, so
    // requiring the member would force the verifier to invent a pointer. Every
    // other verifier-arm fixture in this suite carries it, so without this
    // assertion the `.optional()` is never exercised.
    const event = buildAuditIntegrityFailedVerifierArm();
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    const { offendingSeq: _absent, ...withoutOffendingSeq } = event.payload;
    expect(SessionEventSchema.safeParse({ ...event, payload: withoutOffendingSeq }).success).toBe(
      true,
    );
  });

  it("event.compacted takes its payload sessionId both ways (single-session pass)", () => {
    const event = buildEventCompacted();
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, sessionId: SESSION_ID },
      }).success,
    ).toBe(true);
  });

  it("key_reuse_detected requires at least two observed identities", () => {
    // Spec-006: a key "registered under MORE THAN ONE identity". One identity
    // holding its own key is the compliant register-once state, not an alarm.
    const event = buildKeyReuseDetected();
    const [firstIdentity] = event.payload.observedIdentities;
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, observedIdentities: [firstIdentity] },
      }).success,
    ).toBe(false);
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
  });

  it("key_reuse_detected rejects ONE identity spelled twice (pairwise distinct)", () => {
    // Cardinality is not the condition — DISTINCTNESS is. Spec-006 states the
    // finding as the same key material under two DISTINCT `(session_id,
    // node_id)` pairs, so a repeated pair is one identity holding its own key,
    // listed twice: the compliant register-once posture. With `.min(2)` alone
    // this row parses green and mints a false key-reuse alarm on a row that is
    // never compacted and never shredded, so the false alarm is permanent.
    //
    // The duplicate is a fresh object, not the same reference — the check has
    // to compare identity VALUES, not array slots.
    const event = buildKeyReuseDetected();
    const identity = { sessionId: SESSION_ID, nodeId: NODE_ID };
    const duplicated = SessionEventSchema.safeParse({
      ...event,
      payload: { ...event.payload, observedIdentities: [identity, { ...identity }] },
    });
    expect(duplicated.success).toBe(false);
    // `.min(2)` is satisfied by this input, so the refinement is the only check
    // that can have fired — asserting on its message is what makes the test
    // fail if the refinement is ever dropped.
    const issueMessages = duplicated.error?.issues.map((issue) => issue.message) ?? [];
    expect(
      issueMessages.some((message) => /must not name one .* identity twice/.test(message)),
    ).toBe(true);
  });

  it("key_reuse_detected pins rotationInvariantViolated to refuse_on_rotation", () => {
    const event = buildKeyReuseDetected();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, rotationInvariantViolated: "rotate_on_conflict" },
      }).success,
    ).toBe(false);
  });

  it("event.shredded accepts an empty affectedSessionIds (idempotent re-run)", () => {
    // Deliberately NO `.min(1)`: a purge that touched no PII-bearing session
    // is still an operation worth an audit row.
    const event = buildEventShredded();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, affectedSessionIds: [] },
      }).success,
    ).toBe(true);
  });

  it.each([["age_threshold"], ["count_threshold"], ["storage_threshold"]] as const)(
    "event.compacted accepts compactionReason %s",
    (compactionReason) => {
      const event = buildEventCompacted();
      expect(
        SessionEventSchema.safeParse({ ...event, payload: { ...event.payload, compactionReason } })
          .success,
      ).toBe(true);
    },
  );

  it.each([["gdpr_article_17"], ["retention_policy"], ["admin_action"]] as const)(
    "event.shredded accepts shredReason %s",
    (shredReason) => {
      const event = buildEventShredded();
      expect(
        SessionEventSchema.safeParse({ ...event, payload: { ...event.payload, shredReason } })
          .success,
      ).toBe(true);
    },
  );

  it.each([
    ["compactionReason", buildEventCompacted, "disk_pressure"],
    ["shredReason", buildEventShredded, "because_i_said_so"],
  ] as const)("rejects an out-of-vocabulary %s", (member, build, bad) => {
    const event = build();
    expect(
      SessionEventSchema.safeParse({ ...event, payload: { ...event.payload, [member]: bad } })
        .success,
    ).toBe(false);
  });

  it("caps audit_integrity_failed.detail at its boundary", () => {
    const event = buildAuditIntegrityFailedRegistrarArm();
    const atCap = { ...event.payload, detail: "x".repeat(AUDIT_INTEGRITY_DETAIL_MAX_LEN) };
    const overCap = { ...event.payload, detail: "x".repeat(AUDIT_INTEGRITY_DETAIL_MAX_LEN + 1) };
    expect(SessionEventSchema.safeParse({ ...event, payload: atCap }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...event, payload: overCap }).success).toBe(false);
  });

  it("caps schema.migrated.description at its boundary", () => {
    const event = buildSchemaMigrated();
    const atCap = {
      ...event.payload,
      description: "x".repeat(SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN),
    };
    const overCap = {
      ...event.payload,
      description: "x".repeat(SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN + 1),
    };
    expect(SessionEventSchema.safeParse({ ...event, payload: atCap }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...event, payload: overCap }).success).toBe(false);
  });

  it.each([
    ["whitespace-only", "   "],
    ["NUL-byte", NUL_BEARING_ALGORITHM],
    ["oversized", "x".repeat(EVENT_FIELD_MAX_LEN + 1)],
  ] as const)(
    "rejects a %s signatureAlgorithm (wireFreeFormString guards)",
    (_label, badAlgorithm) => {
      const event = buildAuditIntegrityVerified();
      expect(
        SessionEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, signatureAlgorithm: badAlgorithm },
        }).success,
      ).toBe(false);
    },
  );

  it("bounds payload sequence endpoints by the envelope's own ceiling", () => {
    // A range endpoint above MAX_SAFE_INTEGER cannot name the row it points
    // at — the same injectivity argument the envelope `sequence` makes. Pinned
    // as a BOUNDARY PAIR with a message assertion, exactly as the envelope
    // `sequence` ceiling is pinned above: `.int()` already refuses anything
    // past the safe-integer range, so a lone `success === false` reads
    // identically with `payloadSequenceSchema`'s `.max()` deleted. The at-cap
    // accept plus the named message are the discriminating halves.
    const event = buildEventCompacted();
    const atCeiling = SessionEventSchema.safeParse({
      ...event,
      payload: { ...event.payload, toSeq: EVENT_ENVELOPE_SEQUENCE_MAX },
    });
    expect(atCeiling.success).toBe(true);

    const overCeiling = SessionEventSchema.safeParse({
      ...event,
      payload: { ...event.payload, toSeq: EVENT_ENVELOPE_SEQUENCE_MAX + 1 },
    });
    expect(overCeiling.success).toBe(false);
    // Issue COUNT is deliberately not asserted (the envelope pin's reasoning):
    // both checks firing is correct, and pinning the count would couple this
    // test to Zod's internals.
    const issueMessages = overCeiling.error?.issues.map((issue) => issue.message) ?? [];
    expect(
      issueMessages.some((message) =>
        /the same injectivity ceiling EventEnvelope\.sequence takes/.test(message),
      ),
    ).toBe(true);
  });

  it("rejects a non-integer count", () => {
    const event = buildEventCompacted();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, tombstoneCount: 3.5 },
      }).success,
    ).toBe(false);
  });

  it("stays interpretable at the tolerant carrier as well as the strict layer", () => {
    // The layering pin: every one of the six parses through
    // `EventEnvelopeSchema` too, so a reader that has not yet learned the
    // variant still persists the row rather than dropping it (ADR-018
    // §Decision #5/#9 accept-and-stub).
    for (const [, build] of PLAN_006_VARIANTS) {
      expect(EventEnvelopeSchema.safeParse(build()).success).toBe(true);
    }
  });
});

// The standalone exports are the surface the six emission seams validate
// against before append — T3.1's shred callback, T3.2, T3.4, T4.1, T4.2 and
// T4.10 all `.parse()` a candidate row through one of them rather than through
// the whole union. They must therefore agree with the independently-spelled
// union arms (the repo.test.ts / worktree.test.ts standalone-vs-union stance).
// The two spellings are NOT deduplicated: independent spelling is the design,
// and this block is what makes it safe.
//
// Structural `safeParse` typing sidesteps `z.ZodType` variance; the fixture
// view is the two members every row is probed on.
type Plan006EventFixture = {
  readonly category: string;
  readonly payload: Record<string, unknown>;
};

const STANDALONE_PLAN_006_EVENT_SCHEMAS: ReadonlyArray<
  readonly [
    string,
    () => Plan006EventFixture,
    { safeParse: (candidate: unknown) => { success: boolean } },
  ]
> = [
  ["audit_integrity_verified", buildAuditIntegrityVerified, AuditIntegrityVerifiedEventSchema],
  [
    "audit_integrity_failed (verifier arm)",
    buildAuditIntegrityFailedVerifierArm,
    AuditIntegrityFailedEventSchema,
  ],
  [
    "audit_integrity_failed (registrar arm)",
    buildAuditIntegrityFailedRegistrarArm,
    AuditIntegrityFailedEventSchema,
  ],
  ["key_reuse_detected", buildKeyReuseDetected, KeyReuseDetectedEventSchema],
  ["schema.migrated", buildSchemaMigrated, SchemaMigratedEventSchema],
  ["event.compacted", buildEventCompacted, EventCompactedEventSchema],
  ["event.shredded", buildEventShredded, EventShreddedEventSchema],
];

describe("standalone Plan-006 event schemas agree with the union arms (T1.11)", () => {
  it.each(STANDALONE_PLAN_006_EVENT_SCHEMAS)(
    "%s standalone accepts what the union accepts",
    (_label, build, standaloneSchema) => {
      const fixture = build();
      expect(standaloneSchema.safeParse(fixture).success).toBe(true);
      expect(SessionEventSchema.safeParse(fixture).success).toBe(true);
    },
  );

  it.each(STANDALONE_PLAN_006_EVENT_SCHEMAS)(
    "%s standalone rejects what the union rejects (unknown payload key)",
    (_label, build, standaloneSchema) => {
      const fixture = build();
      const broken = { ...fixture, payload: { ...fixture.payload, vendorExtension: "drift" } };
      expect(standaloneSchema.safeParse(broken).success).toBe(false);
      expect(SessionEventSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each(STANDALONE_PLAN_006_EVENT_SCHEMAS)(
    "%s standalone refuses a spurious ENVELOPE key and a category mismatch",
    (_label, build, standaloneSchema) => {
      // Outer `.strict()` is the one axis of this parity with NO compile-time
      // backstop. A widened `type` or `category` literal fails against the
      // `z.ZodType<*Event>` annotation, and payload strictness cannot diverge
      // because both surfaces reference the same payload schema object — but a
      // schema's inferred output type does not reflect outer `.strict()`, so a
      // copy-paste slip that dropped it from one of the six exports would
      // typecheck green and STRIP the spurious key instead of rejecting. The
      // emission seam validating through that surface would then append
      // canonical bytes it never built, surfacing much later as a strict-union
      // rejection at replay — and on these six rows, which are never compacted
      // and never shredded, the divergence is permanent. The union control on
      // each row is what makes the verdict a parity statement rather than a
      // lone rejection.
      const fixture = build();
      const withSpuriousEnvelopeKey = { ...fixture, spuriousEnvelopeKey: "x" };
      expect(standaloneSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      expect(SessionEventSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      // `category` sits in the RFC 8785 canonical bytes backing the hash
      // chain — pinned on the union above, pinned here on the standalone
      // surface.
      const withMismatchedCategory = { ...fixture, category: "session_lifecycle" };
      expect(standaloneSchema.safeParse(withMismatchedCategory).success).toBe(false);
      expect(SessionEventSchema.safeParse(withMismatchedCategory).success).toBe(false);
    },
  );
});

// --------------------------------------------------------------------------
// Plan-006 T1.12 — the five `runtime_node.*` payload variants (CP-003-1 (a)).
// --------------------------------------------------------------------------
//
// Backstops the five DAEMON-REACHABLE rows of Spec-006 §Runtime Node Lifecycle
// (runtime_node_lifecycle). Division of labour: runtime-node.test.ts owns the
// PAYLOAD shapes (Plan-003 authors them); this block owns what REGISTRATION
// adds — that each payload reaches the strict layer inside a full envelope
// under its census category, that the boundary of the registered set is five
// of seven, that the T1.4 tolerant-union arms were composed and not tightened,
// and that the hoist which made the registration acyclic actually holds.
//
// Fixtures carry the REAL attachment `sessionId`, never the daemon-scope
// sentinel the T1.11 rows anchor on (Spec-006 §Runtime Node Lifecycle
// (runtime_node_lifecycle) — these rows describe an attachment to a specific
// session), so there is no `SENTINEL_BOUND_VARIANTS` counterpart here.

const RUNTIME_NODE_ID = "node-7f3a91c2";

const buildRuntimeNodeRegistered = () => ({
  id: "evt-0301",
  sessionId: SESSION_ID,
  sequence: 30,
  occurredAt: "2026-02-01T10:00:00.000Z",
  category: "runtime_node_lifecycle" as const,
  type: "runtime_node.registered" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    nodeId: RUNTIME_NODE_ID,
    newState: "registering",
    actor: null,
    capabilities: { "provider-driver": { contractVersion: "1.0" } },
    nodeVersion: "1.4.2",
    platform: "darwin-arm64",
  },
});

const buildRuntimeNodeOnline = () => ({
  id: "evt-0302",
  sessionId: SESSION_ID,
  sequence: 31,
  occurredAt: "2026-02-01T10:00:01.000Z",
  category: "runtime_node_lifecycle" as const,
  type: "runtime_node.online" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    nodeId: RUNTIME_NODE_ID,
    previousState: "registering",
    newState: "online",
    actor: null,
  },
});

const buildRuntimeNodeOffline = () => ({
  id: "evt-0303",
  sessionId: SESSION_ID,
  sequence: 32,
  occurredAt: "2026-02-01T10:05:00.000Z",
  category: "runtime_node_lifecycle" as const,
  type: "runtime_node.offline" as const,
  actor: PARTICIPANT_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    nodeId: RUNTIME_NODE_ID,
    previousState: "online",
    newState: "offline",
    actor: PARTICIPANT_ID,
    lastHeartbeatAt: "2026-02-01T10:04:59.000Z",
    reason: "explicit_shutdown",
  },
});

const buildRuntimeNodeCapabilityDeclared = () => ({
  id: "evt-0304",
  sessionId: SESSION_ID,
  sequence: 33,
  occurredAt: "2026-02-01T10:00:02.000Z",
  category: "runtime_node_lifecycle" as const,
  type: "runtime_node.capability_declared" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    nodeId: RUNTIME_NODE_ID,
    actor: null,
    capability: "provider-driver",
    capabilityDetails: buildCapabilityDetails(),
  },
});

const buildRuntimeNodeCapabilityUpdated = () => ({
  id: "evt-0305",
  sessionId: SESSION_ID,
  sequence: 34,
  occurredAt: "2026-02-01T10:03:00.000Z",
  category: "runtime_node_lifecycle" as const,
  type: "runtime_node.capability_updated" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    nodeId: RUNTIME_NODE_ID,
    actor: null,
    capability: "provider-driver",
    previousState: buildCapabilityDetails(),
    newState: { ...buildCapabilityDetails(), contractVersion: "1.1" },
  },
});

const PLAN_003_VARIANTS = [
  ["runtime_node.registered", buildRuntimeNodeRegistered],
  ["runtime_node.online", buildRuntimeNodeOnline],
  ["runtime_node.offline", buildRuntimeNodeOffline],
  ["runtime_node.capability_declared", buildRuntimeNodeCapabilityDeclared],
  ["runtime_node.capability_updated", buildRuntimeNodeCapabilityUpdated],
] as const;

// The two capability rows — the only ones carrying T1.4's canonical-first
// tolerant unions, so the tolerance assertions are keyed to the exact fields.
// Field before builder: `it.each`'s `%s` placeholders bind positionally, and a
// function in a title prints as source text.
const CAPABILITY_UNION_FIELDS = [
  ["runtime_node.capability_declared", "capabilityDetails", buildRuntimeNodeCapabilityDeclared],
  ["runtime_node.capability_updated", "previousState", buildRuntimeNodeCapabilityUpdated],
  ["runtime_node.capability_updated", "newState", buildRuntimeNodeCapabilityUpdated],
] as const;

// Key-omission helper. The variant fixtures reach the `it.each` callbacks as a
// UNION of five object types, and rest-destructuring a union is not expressible
// — this takes the widened record view instead, which every fixture satisfies
// (inferred object-literal types carry an implicit index signature).
const withoutKey = (source: Record<string, unknown>, key: string): Record<string, unknown> => {
  const clone = { ...source };
  delete clone[key];
  return clone;
};

// Widened view of the registered roster. `SESSION_EVENT_TYPES` is typed
// `readonly SessionEvent["type"][]`, so asserting that a NON-member string is
// absent needs the string view — the narrow element type would reject the
// argument at compile time and the absence claim could never be written.
const REGISTERED_TYPE_STRINGS: readonly string[] = SESSION_EVENT_TYPES;

describe("runtime_node.* payload variants (T1.12)", () => {
  it.each(PLAN_003_VARIANTS)("round-trips %s through JSON without loss", (_label, build) => {
    const original = build();
    const firstPass = SessionEventSchema.parse(original);
    const offWire = JSON.parse(JSON.stringify(firstPass)) as unknown;
    expect(SessionEventSchema.parse(offWire)).toStrictEqual(firstPass);
    // No key added (no `.default()`), none dropped (`.strict()`, no stripping)
    // — parse output ≡ wire bytes, the canonical-bytes precondition.
    expect(firstPass).toStrictEqual(original);
  });

  it.each(PLAN_003_VARIANTS)(
    "%s carries the census category and rejects a mismatched one",
    (_label, build) => {
      const event = build();
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(event.type)).toBe("runtime_node_lifecycle");
      expect(event.category).toBe("runtime_node_lifecycle");
      // `category` is in the BLAKE3-hashed canonical bytes, so a type/category
      // mismatch must die at parse time, never be coerced.
      expect(
        SessionEventSchema.safeParse({ ...event, category: "session_lifecycle" }).success,
      ).toBe(false);
    },
  );

  it.each(PLAN_003_VARIANTS)("%s rejects an unknown payload key (.strict)", (_label, build) => {
    const event = build();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, vendorExtension: "drift" },
      }).success,
    ).toBe(false);
  });

  it.each(PLAN_003_VARIANTS)(
    "%s rejects a sourceEpoch/sourcePosition stamp (non-admitting family)",
    (_label, build) => {
      // None of the five is run-scoped — the payloads carry `nodeId` and no
      // `runId` — so none is `withEpochStamp`-wrapped and the strict payload
      // refuses the stamp. The admission RULE is walked over the live union in
      // event-source-epoch.test.ts; this is the wire-level consequence.
      const event = build();
      expect(
        SessionEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, sourceEpoch: 1, sourcePosition: 5 },
        }).success,
      ).toBe(false);
    },
  );

  it.each(PLAN_003_VARIANTS)(
    "%s binds the REAL attachment sessionId, not the daemon-scope sentinel",
    (_label, build) => {
      const event = build();
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.sessionId).not.toBe(SENTINEL_SESSION_ID);
      expect(event.payload.sessionId).toBe(SESSION_ID);
      expect(SessionEventSchema.safeParse(event).success).toBe(true);
    },
  );

  it.each(PLAN_003_VARIANTS)(
    "%s keeps the payload's own sessionId OPTIONAL (Spec-006 base spells it sessionId?)",
    (_label, build) => {
      // The ENVELOPE member stays required; only the payload mirror is
      // optional, and the daemon populates it in practice.
      const event = build();
      const withoutPayloadSessionId = {
        ...event,
        payload: withoutKey(event.payload, "sessionId"),
      };
      expect(SessionEventSchema.safeParse(withoutPayloadSessionId).success).toBe(true);
      expect(SessionEventSchema.safeParse(withoutKey(event, "sessionId")).success).toBe(false);
    },
  );

  it.each(PLAN_003_VARIANTS)("%s parses through the tolerant carrier too", (_label, build) => {
    // Registration adds the STRICT reading; the version-tolerant carrier
    // accepted these rows already and must keep doing so.
    expect(EventEnvelopeSchema.safeParse(build()).success).toBe(true);
  });

  it("registers FIVE of the seven census names — degraded / revoked stay payload-less", () => {
    // Both are census members with no V1 producer (server-derived; ADR-017
    // §Server-Derived Runtime-Node Lifecycle Events), so Plan-003 authors no
    // payload shape and the STRICT layer must keep rejecting them. The
    // tolerant carrier still accepts them, which is the whole point of the
    // two-layer split.
    for (const unregistered of ["runtime_node.degraded", "runtime_node.revoked"] as const) {
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(unregistered)).toBe("runtime_node_lifecycle");
      expect(RUNTIME_NODE_LIFECYCLE_EVENT_TYPES).toContain(unregistered);
      expect(REGISTERED_TYPE_STRINGS).not.toContain(unregistered);
      const event = { ...buildRuntimeNodeOnline(), type: unregistered };
      expect(SessionEventSchema.safeParse(event).success).toBe(false);
      expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
    }
    // The `session.clock_*` pair shares the category but keeps its `session.`
    // prefix by name preservation and is likewise unregistered.
    expect(REGISTERED_TYPE_STRINGS).not.toContain("session.clock_unsynced");
    expect(REGISTERED_TYPE_STRINGS).not.toContain("session.clock_corrected");
  });

  it.each(CAPABILITY_UNION_FIELDS)(
    "%s composes T1.4's canonical-first tolerant union on %s unchanged",
    (_label, field, build) => {
      const event = build();
      const withField = (value: unknown) => ({
        ...event,
        payload: { ...event.payload, [field]: value },
      });

      // ARM 1 — a canonical snapshot parses (and `CapabilityDetailsSchema`
      // independently agrees it is canonical).
      expect(CapabilityDetailsSchema.safeParse(buildCapabilityDetails()).success).toBe(true);
      expect(SessionEventSchema.safeParse(event).success).toBe(true);

      // ARM 2 — an arbitrary record still parses. This is the assertion that
      // registration did NOT tighten the field to canonical-only: doing so
      // would reject previously-valid wire payloads, a MAJOR narrowing under
      // ADR-018 §Decision #8. A flags-short snapshot is the concrete case —
      // the canonical arm refuses it, the record arm carries it.
      const { flags: _droppedFlags, ...flagsShortSnapshot } = buildCapabilityDetails();
      expect(CapabilityDetailsSchema.safeParse(flagsShortSnapshot).success).toBe(false);
      expect(SessionEventSchema.safeParse(withField(flagsShortSnapshot)).success).toBe(true);
      expect(SessionEventSchema.safeParse(withField({ opaque: "vendor-record" })).success).toBe(
        true,
      );

      // The union is over OBJECTS both ways — a scalar is refused by both arms.
      expect(SessionEventSchema.safeParse(withField("provider-driver")).success).toBe(false);
      expect(SessionEventSchema.safeParse(withField(null)).success).toBe(false);
    },
  );
});

// The payloads MUST stay assignable to `Record<string, unknown>` — that is what
// lets the five variant interfaces in event.ts narrow `EventEnvelope.payload`.
// It holds because each payload type is a TYPE ALIAS: TypeScript grants an
// object type alias an implicit index signature but grants an interface none.
// Re-declaring any of them as an interface would fail HERE with a clear
// message, ahead of the more obscure failure at the `extends EventEnvelope`
// site (the repo.test.ts / worktree.test.ts precedent).
//
// Each right-hand side is a PARSE RESULT, not an object literal: a literal
// would carry its own implicit index signature and satisfy the annotation
// whatever the alias is declared as, making the pin vacuous.
const parsedRegisteredPayload: RuntimeNodeRegisteredPayload =
  RuntimeNodeRegisteredPayloadSchema.parse(buildRuntimeNodeRegistered().payload);
const parsedOnlinePayload: RuntimeNodeOnlinePayload = RuntimeNodeOnlinePayloadSchema.parse(
  buildRuntimeNodeOnline().payload,
);
const parsedOfflinePayload: RuntimeNodeOfflinePayload = RuntimeNodeOfflinePayloadSchema.parse(
  buildRuntimeNodeOffline().payload,
);
const parsedCapabilityDeclaredPayload: RuntimeNodeCapabilityDeclaredPayload =
  RuntimeNodeCapabilityDeclaredPayloadSchema.parse(buildRuntimeNodeCapabilityDeclared().payload);
const parsedCapabilityUpdatedPayload: RuntimeNodeCapabilityUpdatedPayload =
  RuntimeNodeCapabilityUpdatedPayloadSchema.parse(buildRuntimeNodeCapabilityUpdated().payload);

const runtimeNodePayloadsNarrowTheEnvelope: readonly Record<string, unknown>[] = [
  parsedRegisteredPayload,
  parsedOnlinePayload,
  parsedOfflinePayload,
  parsedCapabilityDeclaredPayload,
  parsedCapabilityUpdatedPayload,
];
void runtimeNodePayloadsNarrowTheEnvelope;

// Each of the five arms is spelled TWICE in event.ts — once as a standalone
// `RuntimeNode*EventSchema` export, once inside the discriminated union — and
// the two spellings are deliberately NOT deduplicated (the stance the T1.11
// block above states, and the repo.test.ts / worktree.test.ts precedent). This
// block is what makes that safe for T1.12's five.
//
// Structural `safeParse` typing sidesteps `z.ZodType` variance; the fixture
// view is the two members every row is probed on. Declared locally rather than
// shared with the T1.11 table, which is how repo.test.ts spells its own.
type Plan003EventFixture = {
  readonly category: string;
  readonly payload: Record<string, unknown>;
};

const STANDALONE_PLAN_003_EVENT_SCHEMAS: ReadonlyArray<
  readonly [
    string,
    () => Plan003EventFixture,
    { safeParse: (candidate: unknown) => { success: boolean } },
  ]
> = [
  ["runtime_node.registered", buildRuntimeNodeRegistered, RuntimeNodeRegisteredEventSchema],
  ["runtime_node.online", buildRuntimeNodeOnline, RuntimeNodeOnlineEventSchema],
  ["runtime_node.offline", buildRuntimeNodeOffline, RuntimeNodeOfflineEventSchema],
  [
    "runtime_node.capability_declared",
    buildRuntimeNodeCapabilityDeclared,
    RuntimeNodeCapabilityDeclaredEventSchema,
  ],
  [
    "runtime_node.capability_updated",
    buildRuntimeNodeCapabilityUpdated,
    RuntimeNodeCapabilityUpdatedEventSchema,
  ],
];

describe("standalone runtime_node.* event schemas agree with the union arms (T1.12)", () => {
  it.each(STANDALONE_PLAN_003_EVENT_SCHEMAS)(
    "%s standalone accepts what the union accepts",
    (_label, build, standaloneSchema) => {
      const fixture = build();
      expect(standaloneSchema.safeParse(fixture).success).toBe(true);
      expect(SessionEventSchema.safeParse(fixture).success).toBe(true);
    },
  );

  it.each(STANDALONE_PLAN_003_EVENT_SCHEMAS)(
    "%s standalone rejects what the union rejects (unknown payload key)",
    (_label, build, standaloneSchema) => {
      const fixture = build();
      const broken = { ...fixture, payload: { ...fixture.payload, vendorExtension: "drift" } };
      expect(standaloneSchema.safeParse(broken).success).toBe(false);
      expect(SessionEventSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each(STANDALONE_PLAN_003_EVENT_SCHEMAS)(
    "%s standalone refuses a spurious ENVELOPE key and a category mismatch",
    (_label, build, standaloneSchema) => {
      // Outer `.strict()` is the one axis of this parity with NO compile-time
      // backstop — the T1.11 block above carries the full argument and it
      // applies unchanged: a schema's inferred output type does not reflect
      // outer `.strict()`, so a copy-paste slip that dropped it from one of
      // these five exports would typecheck green against the
      // `z.ZodType<*Event>` annotation and STRIP the spurious key instead of
      // rejecting it. What is different on these five is the OWNERSHIP SPLIT:
      // the payload schemas are Plan-003's and the envelope wrapper is
      // Plan-006's, so the two spellings can drift without either plan editing
      // the other's file. The union control on each row is what makes the
      // verdict a parity statement rather than a lone rejection.
      const fixture = build();
      const withSpuriousEnvelopeKey = { ...fixture, spuriousEnvelopeKey: "x" };
      expect(standaloneSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      expect(SessionEventSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      // `category` sits in the RFC 8785 canonical bytes backing the hash
      // chain — pinned on the union above, pinned here on the standalone
      // surface.
      const withMismatchedCategory = { ...fixture, category: "session_lifecycle" };
      expect(standaloneSchema.safeParse(withMismatchedCategory).success).toBe(false);
      expect(SessionEventSchema.safeParse(withMismatchedCategory).success).toBe(false);
    },
  );
});

// --------------------------------------------------------------------------
// Module-cycle tripwire (T1.12) — the hoist that makes the registration safe.
// --------------------------------------------------------------------------
//
// Registering the arms above made `event.ts` import `runtime-node.ts` at
// module scope, and `runtime-node.ts` reads three Plan-006 values at module
// scope of its own. Had those stayed in `event.ts`, the pair would form an
// eager Zod cycle: whichever module the runtime enters FIRST, the other reads
// a binding still in temporal dead zone and throws `ReferenceError: Cannot
// access '<binding>' before initialization`. TypeScript compiles cycles
// silently, so nothing else in this repo's toolchain catches it — and because
// every test loads the barrel, the symptom is a total package failure. The fix
// is `event-core.ts`, a leaf both files import.
//
// TWO LEGS, symptom and cause:
//   • SYMPTOM — a from-scratch module graph is evaluated once per ENTRY ORDER
//     (`../event.js` first, then `../runtime-node.js` first) and asserted to
//     initialize cleanly. A cycle fails only from one direction, so pinning a
//     single order would half-cover it.
//   • CAUSE — `event-core.ts`'s own import set, read from source text. The
//     symptom leg goes green again the moment someone re-adds a `./event.js`
//     import ONLY IF the resulting cycle happens to be benign under the
//     current evaluation order; the cause leg fails immediately and names the
//     rule.
//
// ISOLATION MECHANISM — `vi.resetModules()` + dynamic `import()`, which clears
// the module registry so the graph is re-evaluated from scratch, on top of
// vitest's per-file worker isolation. A fresh-PROCESS leg would be the stronger
// boundary; both spawn forms were examined and both are weaker TESTS here:
//   • Against `packages/contracts/dist/` — those bytes are not what the suite
//     loads, and nothing guarantees what they are. `dist/` is gitignored
//     (.gitignore:56), so it is absent entirely on a clean clone; it is not
//     rebuilt by `pnpm --filter contracts test` (contracts has no workspace
//     dependencies, so turbo's `test` → `^build` edge is empty), so when
//     present it is whatever the last unrelated `tsc -b` left — a tree that
//     need not even correspond to the current source SET, since outputs of
//     deleted modules survive until someone clears it (`runtimeNode.js` is one
//     such leftover of the pre-rename file). And package.json resolves `.`
//     through the `@ai-sidekicks/source` condition to `./src/index.ts` FIRST,
//     so vitest reads TS source: a dist leg would test a build artifact this
//     suite never touches.
//   • Against `src/*.ts` under `node --experimental-strip-types` — Node's type
//     stripping does not remap a `./foo.js` specifier onto `foo.ts`; it wants
//     the real `.ts` extension (which is why the repo's one strip-types tree
//     turns `allowImportingTsExtensions` ON and imports `"../foo.ts"` — see
//     tools/docs-corpus/tsconfig.json). This package emits `dist/`, so its
//     source is written in `.js` specifiers, and a spawned import of
//     `src/event.ts` dies on the first `./session.js` with ERR_MODULE_NOT_FOUND
//     BEFORE any module-scope initializer runs — no cycle is exercised either
//     way.
// So these legs read the SOURCE graph, which is what the hoist changed.
//
// HONEST RESIDUAL of staying in-process: vitest evaluates the graph through
// Vite's SSR transform, whose circular-import semantics are not byte-identical
// to native Node ESM — a module-scope read of an uninitialized binding can
// surface as `undefined` rather than `ReferenceError`. That is why each leg
// asserts a real PARSE and not merely the absence of a throw: an `undefined`
// payload-schema binding cannot construct its union branch or accept the
// fixture below, so the quiet `undefined` shape of the failure lands red too.
describe("event-core.ts leaf keeps the contracts module graph acyclic (T1.12)", () => {
  it("initializes cleanly when ../event.js is the entry point", async () => {
    vi.resetModules();
    const eventModule = await import("../event.js");
    // A module-scope TDZ read would have thrown during evaluation above; this
    // also proves the arms' payload schemas were initialized, not `undefined`.
    expect(eventModule.SESSION_EVENT_TYPES).toContain("runtime_node.registered");
    expect(eventModule.SessionEventSchema.safeParse(buildRuntimeNodeRegistered()).success).toBe(
      true,
    );
  });

  it("initializes cleanly when ../runtime-node.js is the entry point", async () => {
    vi.resetModules();
    const runtimeNodeModule = await import("../runtime-node.js");
    expect(
      runtimeNodeModule.RuntimeNodeRegisteredPayloadSchema.safeParse(
        buildRuntimeNodeRegistered().payload,
      ).success,
    ).toBe(true);
    // ...and event.ts loads clean on top of that already-evaluated graph.
    const eventModule = await import("../event.js");
    expect(eventModule.SessionEventSchema.safeParse(buildRuntimeNodeRegistered()).success).toBe(
      true,
    );
  });

  it("imports zod, ./session.js and ./provider-driver.js — and nothing else", () => {
    // Comments are stripped first so a specifier NAMED in prose (that file's
    // own header names `./event.js` repeatedly) cannot register as an edge.
    // Line comments are cut from `//` to end-of-line, never whole lines: a
    // trailing comment must not be able to carry its statement away with it.
    const leafPath = fileURLToPath(new URL("../event-core.ts", import.meta.url));
    const source = readFileSync(leafPath, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // TWO scans, unioned. The `from` scan covers `import … from` AND
    // `export … from`; the second covers the BARE side-effect form
    // `import "./event.js"`, which carries no `from` and is precisely the
    // shape that would re-close the cycle while leaving a `from`-only
    // assertion green. Additive on purpose — replacing the first with an
    // `import`-anchored pattern would silently drop the re-export class.
    const specifiers = [
      ...[...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1] ?? ""),
      ...[...source.matchAll(/(?:^|\n)\s*import\s+"([^"]+)"/g)].map((match) => match[1] ?? ""),
    ];
    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers)).toEqual(new Set(["zod", "./provider-driver.js", "./session.js"]));
    // Named explicitly: this is the edge whose absence the hoist exists for.
    expect(specifiers).not.toContain("./event.js");
  });
});
