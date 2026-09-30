// Tests for `SessionEventSchema` (the strict discriminated union), `EventEnvelopeSchema` (the
// version-tolerant carrier), `CapabilityDetailsSchema` and the `event_maintenance` variant. The
// union must round-trip through JSON, refuse an unknown `type` or a payload from a sibling
// variant (each arm is `.strict()`), and refuse a `category` that does not match the type.
// `SESSION_EVENT_CATEGORY_BY_TYPE` is a `ReadonlyMap`, so prototype-chain keys such as
// `__proto__` resolve to `undefined`. Every free-form envelope string (`id`, `actor`,
// `correlationId`, `causationId`) refuses whitespace-only and NUL-byte values.
import { describe, expect, it } from "vitest";

import {
  APPROVAL_FLOW_EVENT_TYPES,
  ARTIFACT_PUBLICATION_EVENT_TYPES,
  ASSISTANT_OUTPUT_EVENT_TYPES,
  CAPABILITY_CONTRACT_VERSION_MAX_LEN,
  CapabilityDetailsSchema,
  compareEventEnvelopeVersion,
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EVENT_ENVELOPE_SEQUENCE_MAX,
  EVENT_ENVELOPE_VERSION_MAX_LEN,
  EVENT_ENVELOPE_VERSION_PATTERN,
  EVENT_FIELD_MAX_LEN,
  EVENT_MAINTENANCE_EVENT_TYPES,
  EventCategorySchema,
  EventCompactedEventSchema,
  EventEnvelopeSchema,
  EventEnvelopeVersionSchema,
  INTERACTIVE_REQUEST_EVENT_TYPES,
  MCP_GOVERNANCE_EVENT_TYPES,
  ORCHESTRATION_ADMISSION_EVENT_TYPES,
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
  WORKFLOW_GATE_RESOLUTION_EVENT_TYPES,
  WORKFLOW_LIFECYCLE_EVENT_TYPES,
  WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES,
  WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES,
  type CapabilityDetails,
  type EventCategory,
  type EventEnvelope,
  type SessionEvent,
  type SessionEventType,
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_PAYLOAD_PLAINTEXT_MAX,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
} from "../event.js";
import {
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_TOOL_DESCRIPTION_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
  type DriverCapabilityFlag,
} from "../provider-driver.js";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION = "1.0";

const buildSessionCreated = () => ({
  id: "evt-0001",
  sessionId: SESSION_ID,
  sequence: 0,
  occurredAt: "2026-01-22T19:14:35.000Z",
  category: "session_lifecycle" as const,
  type: "session.created" as const,
  actor: USER_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    shape: "chat",
    mainAgent: {
      agentId: AGENT_ID,
      name: "Implementer",
      binding: {
        driverName: "claude",
        modelId: "claude-sonnet-5",
        providerAccountId: null,
        effort: null,
      },
      ancestry: [],
      createdAt: "2026-01-22T19:14:35.000Z",
    },
  },
});

describe("SessionEventSchema (C3: discriminated-union JSON round-trip)", () => {
  it("round-trips session.created through JSON without loss", () => {
    const label = "session.created";
    const original = buildSessionCreated();

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
      // TypeScript narrows: `ev.payload.mainAgent` is typed as the live
      // agent entry here — not `unknown` from the union.
      expect(ev.payload.mainAgent.binding.driverName).toBe("claude");
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
    // session.created envelope but with a repo.attached payload shape.
    // Because each variant uses `.strict()` the wrong-shape payload must
    // be rejected (no silent reinterpretation).
    const sessionCreated = buildSessionCreated();
    const repoAttachedPayload = { sessionId: SESSION_ID, state: "attached" };
    const broken = { ...sessionCreated, payload: repoAttachedPayload };
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

  it.each([["session.created", buildSessionCreated, "session_lifecycle"]] as const)(
    "emits the canonical category %s -> %s",
    (label, build, expected) => {
      // Round-trip parse pin: each variant carries its declared canonical category.
      // This is wire-load-bearing because `category` sits inside the canonical bytes;
      // the parsed value must equal the per-type category defined in
      // `SESSION_EVENT_CATEGORY_BY_TYPE`.
      const parsed = SessionEventSchema.parse(build());
      expect(parsed.category).toBe(expected);
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(label)).toBe(expected);
    },
  );

  it.each([["__proto__"], ["constructor"], ["toString"], ["hasOwnProperty"], ["unknown.event"]])(
    "SESSION_EVENT_CATEGORY_BY_TYPE.get rejects prototype-chain walks: %s",
    (untrusted) => {
      // Map (NOT object-literal) lookup is load-bearing: a reader that
      // calls `.get(evt.type)` on a not-yet-parsed string
      // MUST resolve to `undefined` for every key that isn't in the
      // explicit table, including built-in object prototype keys. With an
      // object literal `lookup['__proto__']` resolves to a truthy
      // `[Object: null prototype] {}` value.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(untrusted as never)).toBeUndefined();
    },
  );

  it("rejects a category/type mismatch (usage_telemetry on session.created)", () => {
    // Wire-integrity check: the per-variant `category: z.literal(...)`
    // forbids cross-namespace smuggling. If this ever silently accepted,
    // the log would store the event under the wrong category and replay
    // would diverge.
    const broken = { ...buildSessionCreated(), category: "usage_telemetry" as const };
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

  it("EventCategorySchema enumerates exactly the 19 canonical categories", () => {
    // Pinning the enum values catches drift from the canonical EventCategory definition: a
    // category added on one side fails this test until both sides agree.
    const expected = [
      "run_lifecycle",
      "assistant_output",
      "tool_activity",
      "interactive_request",
      "artifact_publication",
      "session_lifecycle",
      "approval_flow",
      "usage_telemetry",
      "runtime_node_lifecycle",
      "recovery_events",
      "security_events",
      "event_maintenance",
      "policy_events",
      "orchestration_admission",
      "mcp_governance",
      "workflow_lifecycle",
      "workflow_phase_lifecycle",
      "workflow_parallel_coordination",
      "workflow_gate_resolution",
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
    "occurredAt: %s parses -> %s (RFC 3339 section 5.6 offsets honored, local rejected)",
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

  // The free-form envelope strings (`id`, `actor`, `correlationId`, `causationId`) carry the same
  // guards (whitespace-only and NUL-byte rejection) as `identityHandle`: the trust boundary is
  // the wire layer, not producer trust.

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
    // Composing the helper with `.nullable().optional()` must not push `null` into the inner
    // `.regex(/\S/)` / `.refine(NUL)` checks: Zod runs the wrapped schema only on string values,
    // so `null` short-circuits past the chain.
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
});

// compareEventEnvelopeVersion is a total ordering of the branded version type. Inputs go
// through `EventEnvelopeVersionSchema.parse` so each case exercises the real brand path, not an
// `as` cast.
//
// The multi-digit cases guard against a lexical compare: numeric ordering gives "10" > "9" and
// "1.10" > "1.9", lexical gives the opposite, which is why the comparator parses MAJOR and MINOR
// as integers. The precision cases guard against `Number`: within the schema's length cap, two
// distinct versions above `Number.MAX_SAFE_INTEGER` still collapse to one float, so the
// comparator parses with `BigInt` to keep the ordering exact.
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

  // Precision: BigInt compare is exact above Number.MAX_SAFE_INTEGER. A `Number` parse collapses
  // adjacent integers past 9007199254740991 to one float, so a below-floor client could be
  // mis-read as at-floor and granted read-write at the version-floor gate.

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

// The category registry and the per-category arrays are checked as a bijection: every
// registered type appears exactly once, every category is non-empty, and the arrays partition
// the census.

// One row per category and its exported array.
const CENSUS_BASELINE: ReadonlyArray<readonly [EventCategory, readonly SessionEventType[]]> = [
  ["run_lifecycle", RUN_LIFECYCLE_EVENT_TYPES],
  ["assistant_output", ASSISTANT_OUTPUT_EVENT_TYPES],
  ["tool_activity", TOOL_ACTIVITY_EVENT_TYPES],
  ["interactive_request", INTERACTIVE_REQUEST_EVENT_TYPES],
  ["artifact_publication", ARTIFACT_PUBLICATION_EVENT_TYPES],
  ["session_lifecycle", SESSION_LIFECYCLE_EVENT_TYPES],
  ["approval_flow", APPROVAL_FLOW_EVENT_TYPES],
  ["usage_telemetry", USAGE_TELEMETRY_EVENT_TYPES],
  ["runtime_node_lifecycle", RUNTIME_NODE_LIFECYCLE_EVENT_TYPES],
  ["recovery_events", RECOVERY_EVENTS_EVENT_TYPES],
  ["security_events", SECURITY_EVENTS_EVENT_TYPES],
  ["event_maintenance", EVENT_MAINTENANCE_EVENT_TYPES],
  ["policy_events", POLICY_EVENTS_EVENT_TYPES],
  ["orchestration_admission", ORCHESTRATION_ADMISSION_EVENT_TYPES],
  ["mcp_governance", MCP_GOVERNANCE_EVENT_TYPES],
  ["workflow_lifecycle", WORKFLOW_LIFECYCLE_EVENT_TYPES],
  ["workflow_phase_lifecycle", WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES],
  ["workflow_parallel_coordination", WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES],
  ["workflow_gate_resolution", WORKFLOW_GATE_RESOLUTION_EVENT_TYPES],
];

// Literals asserted present under a named category. The element type is load-bearing:
// `SessionEventType` is the census union itself, so a literal that failed to register (or was
// renamed) is a compile error under `tsc -p tsconfig.test.json`, the package's typecheck leg;
// vitest strips types and would not catch it. The runtime assertions pin the category half.
const LATE_MINTED_TYPES: ReadonlyArray<readonly [SessionEventType, EventCategory]> = [
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

describe("SessionEventType census + SESSION_EVENT_CATEGORY_BY_TYPE registry", () => {
  it("registry categories span exactly the canonical EventCategory set (no empty category)", () => {
    // Exact-set schema surface, using the same `.options` cast as the EventCategorySchema pin
    // above: every canonical category has at least one registered type.
    const schemaInternals = EventCategorySchema as unknown as { options: readonly string[] };
    const registryCategories = [...new Set(SESSION_EVENT_CATEGORY_BY_TYPE.values())].sort();
    expect(registryCategories).toEqual([...schemaInternals.options].sort());
  });

  it.each(CENSUS_BASELINE)(
    "%s: per-category array equals the registry partition",
    (category, categoryTypes) => {
      // No intra-array duplicates: distinct-member count equals length.
      expect(new Set(categoryTypes).size).toBe(categoryTypes.length);
      // Exact set equality against the registry keys filtered to this category. Each registry
      // key carries one category, so this also forces the arrays to be pairwise disjoint.
      const registryKeysInCategory = [...SESSION_EVENT_CATEGORY_BY_TYPE.entries()]
        .filter(([, registeredCategory]) => registeredCategory === category)
        .map(([eventType]) => eventType)
        .sort();
      expect([...categoryTypes].sort()).toEqual(registryKeysInCategory);
    },
  );

  it("the per-category arrays partition the registry key set exactly", () => {
    const aggregated = CENSUS_BASELINE.flatMap(([, categoryTypes]) => [...categoryTypes]);
    expect(new Set(aggregated).size).toBe(aggregated.length);
    expect([...aggregated].sort()).toEqual([...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].sort());
  });

  it("keeps the founding wire literal unrenamed with an unchanged category", () => {
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get("session.created")).toBe("session_lifecycle");
    // The schema-registered payload subset grows only through the union-registration seam, and
    // each of its type strings must already be a census member.
    for (const registered of SESSION_EVENT_TYPES) {
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.has(registered)).toBe(true);
    }
  });

  it.each([
    // The namespace prefix of these rows does not name their category. The registry, not the
    // prefix, is the category authority, so a cleanup by namespace heuristic must fail loudly
    // (for example the `session.clock_*` pair).
    ["session.clock_unsynced", "runtime_node_lifecycle"],
    ["session.clock_corrected", "runtime_node_lifecycle"],
    ["daemon.master_key_source", "security_events"],
    ["daemon.pii_split_ambiguous", "security_events"],
    ["relay.pin_refused", "security_events"],
    ["moderation.review_flagged", "approval_flow"],
    ["plan.proposed", "approval_flow"],
    ["plan.accepted", "approval_flow"],
    ["plan.handed_off", "approval_flow"],
    ["orchestration.rejected", "orchestration_admission"],
    ["subagent.started", "tool_activity"],
    ["pty.control_changed", "session_lifecycle"],
  ] as const)(
    "category authority is the registry, not the namespace prefix: %s -> %s",
    (eventType, expectedCategory) => {
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe(expectedCategory);
    },
  );

  it.each([...LATE_MINTED_TYPES])(
    "late-minted literal %s is registered under %s",
    (mintedType, expectedCategory) => {
      // One `.get()` proves both halves: an unregistered literal returns `undefined`, and a
      // wrong category returns the wrong value. The element type already proved registration at
      // compile time.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(mintedType)).toBe(expectedCategory);
    },
  );
});

// EventEnvelopeSchema is the canonical event carrier. Its field set is fixed at the canonical
// eleven members; serialized order (RFC 8785 UTF-16 code-unit sort) belongs to the
// canonicalizer, so this suite pins membership, not byte order. `version` is producer-set and
// must come back from the parse verbatim. The envelope is the version-tolerant carrier: `type`
// is a bounded free-form string, not the census union, while `SessionEventSchema` stays the
// strict layer.

// The canonical eleven members, in wire declaration order; assertions sort before comparing
// because only membership is canonical.
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

// A census-registered type with no SessionEventSchema payload variant, so it exercises the
// carrier accepting what the strict layer cannot interpret. All eleven members are present
// (`actor` is present as null).
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

describe("EventEnvelopeSchema — canonical carrier", () => {
  it("declares exactly the canonical 11-field set (membership pin)", () => {
    // Mechanical guard on the declared set, independent of any fixture: reads the ZodObject
    // shape keys with the same cast as the EventCategorySchema `.options` pin above.
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
    // never stripped.
    expect(secondPass.payload).toStrictEqual(buildBareEnvelope().payload);
  });

  it("hands back the producer-set `version` verbatim (parse never rewrites)", () => {
    const parsed = EventEnvelopeSchema.parse(buildBareEnvelope());
    expect(parsed.version).toBe(VERSION);
  });

  it.each([
    ["numeric version (never numeric on the wire)", { version: 1 }],
    ["three-segment version", { version: "1.0.0" }],
  ] as const)("rejects a %s", (_label, patch) => {
    expect(EventEnvelopeSchema.safeParse({ ...buildBareEnvelope(), ...patch }).success).toBe(false);
  });

  it("rejects an envelope missing `version` (producer-set, required)", () => {
    const broken = { ...buildBareEnvelope() } as Record<string, unknown>;
    delete broken["version"];
    expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
  });

  // `sequence` ceiling: an injectivity requirement, not a capacity estimate. `.int()` already
  // bounds `sequence` to the safe-integer range, so `success` alone cannot tell whether
  // `EVENT_ENVELOPE_SEQUENCE_MAX` exists; the reject test asserts on the message, which fails if
  // the `.max()` is dropped. Neither test covers the path the bound exists for: a `sequence`
  // above 2^53 - 1 collapses onto a shared double, so two events would share a replay key, and a
  // caller can reach the log without parsing. That enforcement lives at `canonicalizeEvent` in
  // the daemon, with its own tests.

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
    // The discriminating half: `.int()`'s own bound would fail with a bare "too big", and only
    // the named `.max()` explains that the ceiling protects replay-key injectivity. Issue count
    // is not asserted, since pinning it would couple the test to Zod's internals.
    const issueMessages = overCeiling.error?.issues.map((issue) => issue.message) ?? [];
    expect(issueMessages.some((message) => /carry the same replay key/.test(message))).toBe(true);
  });

  it("accepts a census type with no payload variant; SessionEventSchema rejects it", () => {
    // Layering pin: `usage.token_count` is census-registered but has no
    // discriminated-union payload variant — the tolerant carrier parses it,
    // the strict layer refuses to interpret it.
    const fixture = buildBareEnvelope();
    expect(EventEnvelopeSchema.safeParse(fixture).success).toBe(true);
    expect(SessionEventSchema.safeParse(fixture).success).toBe(false);
  });

  it("accepts a census-UNKNOWN forward type", () => {
    // A reader must be able to parse the envelope of a type from a newer producer that this
    // build's census does not know, so it can persist a version stub; rejecting it would drop
    // the events the stub path exists to preserve. The literal is fictional, and its absence
    // from the census is asserted mechanically. A census-registered literal would exercise the
    // layering pin above instead.
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
    // `mcp_governance` events use the RFC 9562 section 5.10 Max UUID as the row's `sessionId`,
    // with the session-scoped initiator in the payload as `initiatingSessionId`. The `sessionId`
    // check already admits the Max UUID, so this layer needs no sentinel branch or widened field
    // type. The sentinel is the production constant, not a local respelling, so a drift in the
    // shipped value fails here; pinning its acceptance also makes a later tightening of the check
    // (a v4-only constraint, say) fail here rather than make node-scope governance events
    // unrepresentable. It is disjoint from the random v4 space real sessions draw from, so a
    // chain partitioned by the sentinel cannot collide with a real session's. The carrier treats
    // `payload` as opaque.
    const nodeScopeGovernanceEvent = {
      ...buildBareEnvelope(),
      sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
      category: "mcp_governance" as const,
      type: "mcp.server_config_changed",
      payload: { initiatingSessionId: SESSION_ID },
    };
    const parsed = EventEnvelopeSchema.safeParse(nodeScopeGovernanceEvent);
    expect(parsed.success).toBe(true);
    // The sentinel survives the parse verbatim: it lands in the canonical
    // bytes like any other `sessionId`, never normalized or nulled away.
    expect(parsed.success && parsed.data.sessionId).toBe(DAEMON_SCOPE_SENTINEL_SESSION_ID);
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
    "rejects a top-level member outside the canonical set: %s (the set is fixed)",
    (extraKey) => {
      // `pii_payload` is a storage column, deliberately not in the canonical form: an envelope
      // carrying it as a top-level member is malformed, and stripping it silently would desync
      // the parse output from the hashed canonical bytes. The `__proto__` row pins that Zod's
      // object parser (unlike its record parser) surfaces an own `__proto__` as an unrecognized
      // key, so `.strict()` rejects it. The computed-key spread creates an own property; a
      // literal `__proto__:` key would set the prototype instead.
      const broken = { ...buildBareEnvelope(), [extraKey]: { smuggled: true } };
      expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("keeps `actor: null` and absent `actor` wire-distinguishable", () => {
    // `null` MUST be included in serialization, so present-null and
    // absent stay distinguishable — `actor` is the canonical set's only
    // nullable member. JSON keeps `null` values and drops absent keys.
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
      // The correlation pair is optional, not nullable (matching `buildCommonShape()`); `actor`
      // alone carries the null-for-system convention. Pinned so a widening to nullable is a loud
      // change.
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
    // JSON.parse defines `__proto__` as an own data property, so the wire really carries the
    // member (an object literal `{ __proto__: ... }` would set the prototype and never reach the
    // parser with an own key). Zod's record parser skips own `__proto__` keys, so preserving it
    // is impossible and the default outcome is a silent drop: two distinct wire byte-strings
    // would collapse to one parse output. The payload pre-guard (a raw check before the record
    // parser; a refine on the record's output could never see the dropped key) rejects it
    // loudly.
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
      // The carve-out is exactly one key wide: every other unknown payload key, including the
      // proto-adjacent `constructor` and `prototype` (preservable own data keys), still
      // round-trips untouched. Zod's record-parser skip-list is `__proto__`-only today, so the
      // pre-guard is co-extensive with the drop; if an upgrade widens that list, this must fail
      // first.
      const parsed = EventEnvelopeSchema.parse({
        ...buildBareEnvelope(),
        payload: { [unknownKey]: { marker: unknownKey } },
      });
      expect(Object.keys(parsed.payload)).toEqual([unknownKey]);
      expect(parsed.payload[unknownKey]).toStrictEqual({ marker: unknownKey });
    },
  );

  it.each([["session.created", buildSessionCreated]] as const)(
    "every SessionEvent is an EventEnvelope: %s parses through the carrier",
    (_label, build) => {
      // The strict layer emits within the carrier contract: each registered variant fixture
      // re-parses through EventEnvelopeSchema, and the `EventEnvelope` annotation below is the
      // static leg of the subtype relation.
      const parsed: EventEnvelope = SessionEventSchema.parse(build());
      expect(EventEnvelopeSchema.safeParse(parsed).success).toBe(true);
    },
  );
});

// CapabilityDetailsSchema is the canonical capability snapshot. It is non-normalizing: parse
// output is structurally identical to accepted input (the daemon persists the parsed output, so
// default-filling or stripping would rewrite stored payloads), so a tool entry missing
// `idempotency_class` rejects here where the ingress `ProviderToolMetadataSchema` would fill
// `manual_reconcile_only`. Flags are exhaustive: an enum-keyed record over
// `DRIVER_CAPABILITY_FLAGS`, so a missing member, an unknown key or a non-boolean value
// rejects. Fixtures derive from that const, so widening the flag set needs no edit here.

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
// surprise.
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

describe("CapabilityDetailsSchema (canonical capability snapshot)", () => {
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

  // tools.name / tools.description compose `wireFreeFormString`; these labeled negatives prove
  // the tool-entry strings are not bare `z.string()`s (the caps are the per-field constants in
  // provider-driver.ts).
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

// The event_maintenance payload variant (`event.compacted`). The daemon emits it itself, so its
// payload schema is authored in event.ts rather than imported from an emitting contract.
// Coverage is at the variant level (through `SessionEventSchema`): a payload-only suite would
// stay green if an arm were never registered in the union.

const NODE_ID = "node-7f3a2c";
// The daemon-scope sentinel (the lowercase Max UUID) is referenced by its production name,
// `DAEMON_SCOPE_SENTINEL_SESSION_ID`, with no local literal or alias that a later edit could
// re-point at a respelled value.

const buildEventCompacted = () => ({
  id: "evt-0105",
  sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
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
    removedSessions: [{ sessionId: SESSION_ID, fromSeq: 1, toSeq: 4096 }],
  },
});

const SESSION_EVENT_VARIANTS = [["event.compacted", buildEventCompacted]] as const;

const SENTINEL_BOUND_VARIANTS = [["event.compacted", buildEventCompacted]] as const;

describe("event_maintenance payload variant", () => {
  it.each(SESSION_EVENT_VARIANTS)("round-trips %s through JSON without loss", (_label, build) => {
    const original = build();
    const firstPass = SessionEventSchema.parse(original);
    const offWire = JSON.parse(JSON.stringify(firstPass)) as unknown;
    expect(SessionEventSchema.parse(offWire)).toStrictEqual(firstPass);
    // No key added (no `.default()`), none dropped (`.strict()`, no stripping)
    // — parse output ≡ wire bytes, the canonical-bytes precondition.
    expect(firstPass).toStrictEqual(original);
  });

  it.each(SESSION_EVENT_VARIANTS)(
    "%s carries the census category and rejects a mismatched one",
    (_label, build) => {
      const event = build();
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(event.type)).toBe(event.category);
      // `category` is in the canonical bytes, so a type/category mismatch
      // must die at parse time, never be coerced.
      expect(
        SessionEventSchema.safeParse({ ...event, category: "session_lifecycle" }).success,
      ).toBe(false);
    },
  );

  it.each(SESSION_EVENT_VARIANTS)(
    "%s rejects an unknown payload key (.strict)",
    (_label, build) => {
      const event = build();
      expect(
        SessionEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, vendorExtension: "drift" },
        }).success,
      ).toBe(false);
    },
  );

  it.each(SESSION_EVENT_VARIANTS)(
    "%s rejects a sourceEpoch/sourcePosition stamp (non-admitting family)",
    (_label, build) => {
      // It is not run-scoped, so it is not `withEpochStamp`-wrapped and the
      // strict payload refuses the stamp. The admission RULE is walked over
      // the live union in event-source-epoch.test.ts; this is the wire-level
      // consequence for this branch.
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
      expect(event.sessionId).toBe(DAEMON_SCOPE_SENTINEL_SESSION_ID);
      const parsed = SessionEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
      // The sentinel survives verbatim — never normalized, never nulled away.
      expect(parsed.success && parsed.data.sessionId).toBe(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    },
  );

  it("event.compacted names at least one removed session", () => {
    const event = buildEventCompacted();
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    expect(
      SessionEventSchema.safeParse({ ...event, payload: { ...event.payload, removedSessions: [] } })
        .success,
    ).toBe(false);
  });

  it("event.compacted refuses a stubbed range that ends before it starts", () => {
    const event = buildEventCompacted();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: {
          ...event.payload,
          removedSessions: [{ sessionId: SESSION_ID, fromSeq: 10, toSeq: 9 }],
        },
      }).success,
    ).toBe(false);
  });

  it("bounds payload sequence endpoints by the envelope's own ceiling", () => {
    // A range endpoint above MAX_SAFE_INTEGER cannot name the row it points at, the same
    // injectivity argument as the envelope `sequence`. Pinned as a boundary pair with a message
    // assertion, as above: `.int()` already refuses anything past the safe-integer range, so a
    // lone `success === false` would read the same with `payloadSequenceSchema`'s `.max()`
    // deleted.
    const event = buildEventCompacted();
    const atCeiling = SessionEventSchema.safeParse({
      ...event,
      payload: {
        ...event.payload,
        removedSessions: [
          { sessionId: SESSION_ID, fromSeq: 1, toSeq: EVENT_ENVELOPE_SEQUENCE_MAX },
        ],
      },
    });
    expect(atCeiling.success).toBe(true);

    const overCeiling = SessionEventSchema.safeParse({
      ...event,
      payload: {
        ...event.payload,
        removedSessions: [
          { sessionId: SESSION_ID, fromSeq: 1, toSeq: EVENT_ENVELOPE_SEQUENCE_MAX + 1 },
        ],
      },
    });
    expect(overCeiling.success).toBe(false);
    // Issue count is not asserted (see the envelope pin): pinning it would couple the test to
    // Zod's internals.
    const issueMessages = overCeiling.error?.issues.map((issue) => issue.message) ?? [];
    expect(
      issueMessages.some((message) =>
        /the same injectivity ceiling EventEnvelope\.sequence takes/.test(message),
      ),
    ).toBe(true);
  });

  it.each(SESSION_EVENT_VARIANTS)(
    "%s stays interpretable at the tolerant carrier as well as the strict layer",
    (_label, build) => {
      // The layering pin: each registered variant parses through
      // `EventEnvelopeSchema` too, so a reader that has not yet learned the
      // variant still persists the row rather than dropping it.
      expect(EventEnvelopeSchema.safeParse(build()).success).toBe(true);
    },
  );
});

// The standalone export is the surface the emission seam validates a candidate row against
// before append, so it must agree with the independently spelled union arms (the same
// standalone-versus-union stance as `repo.test.ts` and `worktree.test.ts`). The two spellings
// are deliberately not deduplicated; this block is what makes that safe. Structural `parse` /
// `safeParse` typing sidesteps `z.ZodType` variance; the fixture view is the two members every
// row is probed on.
type MaintenanceEventFixture = {
  readonly category: string;
  readonly payload: Record<string, unknown>;
};

const STANDALONE_MAINTENANCE_EVENT_SCHEMAS: ReadonlyArray<
  readonly [
    string,
    () => MaintenanceEventFixture,
    {
      parse: (candidate: unknown) => unknown;
      safeParse: (candidate: unknown) => { success: boolean };
    },
  ]
> = [["event.compacted", buildEventCompacted, EventCompactedEventSchema]];

describe("standalone event schemas agree with the union arms", () => {
  it.each(STANDALONE_MAINTENANCE_EVENT_SCHEMAS)(
    "%s standalone accepts what the union accepts, with an identical parse output",
    (_label, build, standaloneSchema) => {
      const fixture = build();
      expect(standaloneSchema.safeParse(fixture).success).toBe(true);
      expect(SessionEventSchema.safeParse(fixture).success).toBe(true);
      // Success parity alone would miss a `.default()` or `.transform()` that
      // landed on only one surface — same verdict, different bytes. Comparing
      // the parse OUTPUTS is what makes the two spellings interchangeable at
      // an emission seam (the repo.test.ts standalone-schema precedent).
      expect(standaloneSchema.parse(fixture)).toStrictEqual(SessionEventSchema.parse(fixture));
    },
  );

  it.each(STANDALONE_MAINTENANCE_EVENT_SCHEMAS)(
    "%s standalone rejects what the union rejects (unknown payload key)",
    (_label, build, standaloneSchema) => {
      const fixture = build();
      const broken = { ...fixture, payload: { ...fixture.payload, vendorExtension: "drift" } };
      expect(standaloneSchema.safeParse(broken).success).toBe(false);
      expect(SessionEventSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each(STANDALONE_MAINTENANCE_EVENT_SCHEMAS)(
    "%s standalone refuses a spurious ENVELOPE key and a category mismatch",
    (_label, build, standaloneSchema) => {
      // Outer `.strict()` is the one axis of this parity with no compile-time backstop: a
      // schema's inferred output type does not reflect it, so a copy-paste slip that dropped it
      // from the export would typecheck and strip the spurious key instead of rejecting it. The
      // emission seam would then append canonical bytes it never built, surfacing later as a
      // strict-union rejection at replay, and this row is never purged, so the divergence would
      // be permanent. The union control on each row makes the verdict a parity statement rather
      // than a lone rejection.
      const fixture = build();
      const withSpuriousEnvelopeKey = { ...fixture, spuriousEnvelopeKey: "x" };
      expect(standaloneSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      expect(SessionEventSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      // `category` sits in the RFC 8785 canonical bytes — pinned on the union
      // above, pinned here on the standalone surface.
      const withMismatchedCategory = { ...fixture, category: "session_lifecycle" };
      expect(standaloneSchema.safeParse(withMismatchedCategory).success).toBe(false);
      expect(SessionEventSchema.safeParse(withMismatchedCategory).success).toBe(false);
    },
  );
});

// The five body-bearing assistant and tool payload variants. Both provider normalizers derive
// emission readiness from `SESSION_EVENT_TYPES`, so an unregistered type forbids envelope
// construction outright. Coverage is the shape contract: no body member, the two families kept
// distinct, and the codec-owned members admissible but never required.

const RUN_ID = "990e8400-e29b-41d4-a716-446655440004";

const buildAssistantMessage = () => ({
  id: "evt-3601",
  sessionId: SESSION_ID,
  sequence: 40,
  occurredAt: "2026-01-22T19:15:01.000Z",
  category: "assistant_output" as const,
  type: "assistant.message" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    contentType: "text/markdown",
    contentLength: 4096,
  },
});

const buildAssistantThinkingUpdate = () => ({
  id: "evt-3602",
  sessionId: SESSION_ID,
  sequence: 41,
  occurredAt: "2026-01-22T19:15:02.000Z",
  category: "assistant_output" as const,
  type: "assistant.thinking_update" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    contentLength: 128,
  },
});

const buildToolRow = (type: "tool.invoked" | "tool.result" | "tool.error", sequence: number) => ({
  id: `evt-36${String(sequence)}`,
  sessionId: SESSION_ID,
  sequence,
  occurredAt: "2026-01-22T19:15:03.000Z",
  category: "tool_activity" as const,
  type,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    toolName: "Bash",
    toolCallId: "call-0001",
    durationMs: 1200,
    contentLength: 262_145,
    contentTruncated: true as const,
  },
});

const BODY_BEARING_VARIANTS = [
  ["assistant.message", buildAssistantMessage],
  ["assistant.thinking_update", buildAssistantThinkingUpdate],
  ["tool.invoked", () => buildToolRow("tool.invoked", 42)],
  ["tool.result", () => buildToolRow("tool.result", 43)],
  ["tool.error", () => buildToolRow("tool.error", 44)],
] as const;

describe("SessionEventSchema — body-bearing assistant / tool variants", () => {
  it.each(BODY_BEARING_VARIANTS)("round-trips %s through JSON without loss", (_type, build) => {
    const event = build();
    const parsed = SessionEventSchema.safeParse(JSON.parse(JSON.stringify(event)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(event);
  });

  it.each(BODY_BEARING_VARIANTS)(
    "%s carries the descriptive members but NEVER a body member",
    (_type, build) => {
      const event = build();
      // The whole point of the column: the prose is not in the payload, so no
      // amount of schema growth here may quietly reintroduce it.
      for (const bodyKey of ["body", "content", "text", "result", "arguments"]) {
        const smuggled = { ...event, payload: { ...event.payload, [bodyKey]: "the prose" } };
        expect(SessionEventSchema.safeParse(smuggled).success).toBe(false);
      }
    },
  );

  it.each(BODY_BEARING_VARIANTS)(
    "%s accepts a row carrying no descriptive member at all",
    (_type, build) => {
      const event = build();
      const bare: Record<string, unknown> = { ...event.payload };
      delete bare[CONTENT_LENGTH_PAYLOAD_KEY];
      delete bare[CONTENT_TRUNCATED_PAYLOAD_KEY];
      // A row whose type admits prose but that carried none is valid; requiring
      // the members would force a producer to fabricate a length for bytes that
      // do not exist.
      expect(SessionEventSchema.safeParse({ ...event, payload: bare }).success).toBe(true);
    },
  );

  it.each(BODY_BEARING_VARIANTS)("%s rejects contentTruncated: false", (_type, build) => {
    const event = build();
    // Absence is the completeness signal. A `false` on the wire would put bytes
    // into the canonical serialization that a complete row must not have.
    const withFalse = { ...event, payload: { ...event.payload, contentTruncated: false } };
    expect(SessionEventSchema.safeParse(withFalse).success).toBe(false);
  });

  it.each(BODY_BEARING_VARIANTS)("%s rejects a negative contentLength", (_type, build) => {
    const event = build();
    const negative = { ...event, payload: { ...event.payload, contentLength: -1 } };
    expect(SessionEventSchema.safeParse(negative).success).toBe(false);
  });

  it("keeps the assistant and tool families distinct rather than one schema", () => {
    const assistant = buildAssistantMessage();
    const tool = buildToolRow("tool.result", 45);
    // A `toolName` on an assistant row and a `contentType` on a tool row are members neither
    // family defines.
    expect(
      SessionEventSchema.safeParse({
        ...assistant,
        payload: { ...assistant.payload, toolName: "Bash" },
      }).success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse({
        ...tool,
        payload: { ...tool.payload, contentType: "text/plain" },
      }).success,
    ).toBe(false);
  });

  it("requires toolName on every tool row", () => {
    for (const type of ["tool.invoked", "tool.result", "tool.error"] as const) {
      const event = buildToolRow(type, 46);
      const { toolName: _dropped, ...withoutToolName } = event.payload;
      expect(SessionEventSchema.safeParse({ ...event, payload: withoutToolName }).success).toBe(
        false,
      );
    }
  });

  it.each(BODY_BEARING_VARIANTS)("%s admits the run-scoped epoch stamp pair", (_type, build) => {
    const event = build();
    const stamped = {
      ...event,
      payload: { ...event.payload, sourceEpoch: 2, sourcePosition: 7 },
    };
    expect(SessionEventSchema.safeParse(stamped).success).toBe(true);
    // Half a stamp is unattributable and is refused at parse.
    const halfStamped = { ...event, payload: { ...event.payload, sourceEpoch: 2 } };
    expect(SessionEventSchema.safeParse(halfStamped).success).toBe(false);
  });

  it("pins the plaintext bound at 256 KiB", () => {
    // The figure the sealing codec enforces; pinned here because several modules read it and a
    // silent change would move a durable truncation boundary.
    expect(CONTENT_PAYLOAD_PLAINTEXT_MAX).toBe(262_144);
    expect(CONTENT_PAYLOAD_PLAINTEXT_MAX).toBe(256 * 1024);
  });

  it("exports the two codec-owned payload keys under their wire spellings", () => {
    expect(CONTENT_LENGTH_PAYLOAD_KEY).toBe("contentLength");
    expect(CONTENT_TRUNCATED_PAYLOAD_KEY).toBe("contentTruncated");
  });
});

// The variants whose payload another contract declares: one row per owning contract, each with
// the event that must fail at the union (a refinement the owner wrote, the strictness of an arm,
// the category the registry files the type under, or half an epoch stamp). Each owner's own
// suite covers the rest of its payload.

const OWNER_RUN_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const OWNER_AGENT_ID = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b";
const OWNER_REQUEST_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_PLAN_ID = "1f2b4d5e-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_QUESTION_ID = "2f2b4d5e-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_WAIT_ID = "3f2b4d5e-dddd-4ddd-8ddd-dddddddddddd";
const OWNER_SIDE_QUESTION_ID = "4f2b4d5e-eeee-4eee-8eee-eeeeeeeeeeee";

const ownedVariantEvent = (
  type: SessionEventType,
  category: EventCategory,
  payload: Record<string, unknown>,
) => ({
  id: `evt-${type}`,
  sessionId: SESSION_ID,
  sequence: 9,
  occurredAt: "2026-09-29T19:30:00.000Z",
  category,
  type,
  actor: null,
  version: VERSION,
  payload,
});

const APPROVAL_RESOLVED = {
  sessionId: SESSION_ID,
  runId: OWNER_RUN_ID,
  approvalRequestId: OWNER_REQUEST_ID,
  category: "tool_execution",
  scope: "pnpm test",
  approver: USER_ID,
  effectiveScope: "pnpm test",
  clientResolutionId: OWNER_WAIT_ID,
};
const QUESTION = {
  questionId: OWNER_QUESTION_ID,
  sessionId: SESSION_ID,
  runId: OWNER_RUN_ID,
  pageCount: 1,
};
const MCP_STATUS = {
  provider: "claude",
  scope: "project",
  scopeRefDigest: "b3:9f2c",
  serverName: "docs",
  previousStatus: "starting",
  status: "failed",
  origin: "session_feed",
  bindingId: "leg-1",
};
const SIDE_QUESTION = {
  sessionId: SESSION_ID,
  sideQuestionId: OWNER_SIDE_QUESTION_ID,
};
const REVIEW_FLAGGED = {
  sessionId: SESSION_ID,
  runId: OWNER_RUN_ID,
  agentId: OWNER_AGENT_ID,
  eventId: "item-7",
  signal: "review_required",
  text: "This request requires additional safety checks",
};
const COMMAND_ENDED = {
  sessionId: SESSION_ID,
  runId: OWNER_RUN_ID,
  commandId: "cmd-1",
  ending: "ended_by_person",
  durationMs: 4200,
  sourceEpoch: 1,
  sourcePosition: 4,
};
const OWNER_REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const OWNER_WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const OWNER_REMOVED_WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f22";
const SESSION_SWEPT = {
  sessionId: SESSION_ID,
  repoMountId: OWNER_REPO_MOUNT_ID,
  worktreeId: OWNER_WORKTREE_ID,
  pendingMoveCleared: true,
};
const WORKTREE_READY = { sessionId: SESSION_ID, worktreeId: OWNER_WORKTREE_ID, state: "ready" };
const MODEL_REROUTED = {
  sessionId: SESSION_ID,
  runId: OWNER_RUN_ID,
  agentId: OWNER_AGENT_ID,
  fromModel: "claude-opus-5-5",
  toModel: "claude-sonnet-5",
  scope: "local",
  cause: "safety",
  safetyCategory: "cybersecurity",
  sourceEpoch: 1,
  sourcePosition: 4,
};
const RELAY_PIN_REFUSED = {
  relayHost: "relay.example.com",
  pinnedSpkiPrefix: "3f3f3f3f3f3f3f3f",
  presentedSpkiPrefix: "0123456789abcdef",
};
const OWNER_DENIAL_ID = "5f2b4d5e-ffff-4fff-8fff-ffffffffffff";
const OWNER_WORKFLOW_RUN_ID = "6f2b4d5e-abab-4bab-8bab-abababababab";
const CLAUDE_BINDING = {
  driverName: "claude",
  modelId: "claude-opus-5-5",
  providerAccountId: "account-1",
  effort: "high",
};
const CODEX_BINDING = {
  driverName: "codex",
  modelId: "gpt-5.5",
  providerAccountId: "account-2",
  effort: "medium",
};
const APPROVAL_REQUESTED = {
  sessionId: SESSION_ID,
  runId: OWNER_RUN_ID,
  approvalRequestId: OWNER_REQUEST_ID,
  category: "tool_execution",
  scope: "pnpm test",
  requestedBy: "agent",
  resourceDescriptor: { command: "pnpm test" },
};
const REVIEWER_DENIED = {
  sessionId: SESSION_ID,
  runId: OWNER_RUN_ID,
  agentId: OWNER_AGENT_ID,
  denialId: OWNER_DENIAL_ID,
  eventId: "item-9",
  reason: "[Data Exfiltration]",
  overridable: true,
  contentLength: 412,
};
const WORKFLOW_RUN_EVENT = {
  sessionId: SESSION_ID,
  workflowRunId: OWNER_WORKFLOW_RUN_ID,
  definitionId: "wfd-1",
  workflowVersionId: "wfv-3",
};
const WORKFLOW_STEP_EVENT = {
  sessionId: SESSION_ID,
  workflowRunId: OWNER_WORKFLOW_RUN_ID,
  nodeId: "review",
  executionIndex: 0,
  attempt: 1,
};
const GATE_RESOLVED = {
  ...WORKFLOW_RUN_EVENT,
  nodeId: "approve",
  outcome: "approved",
  gateResolutionId: "gr-1",
  deviceId: "desktop-1",
};

const OWNED_VARIANT_FAMILIES: ReadonlyArray<
  readonly [
    string,
    string,
    ReturnType<typeof ownedVariantEvent>,
    ReturnType<typeof ownedVariantEvent>,
  ]
> = [
  [
    "approval",
    "a member the answer does not declare",
    ownedVariantEvent("approval.rejected", "approval_flow", APPROVAL_RESOLVED),
    ownedVariantEvent("approval.rejected", "approval_flow", {
      ...APPROVAL_RESOLVED,
      editedAction: "pnpm test --filter contracts",
    }),
  ],
  [
    "plan",
    "a hand-off that names no fresh session",
    ownedVariantEvent("plan.handed_off", "approval_flow", {
      planId: OWNER_PLAN_ID,
      sessionId: SESSION_ID,
      freshSessionId: USER_ID,
    }),
    ownedVariantEvent("plan.handed_off", "approval_flow", {
      planId: OWNER_PLAN_ID,
      sessionId: SESSION_ID,
    }),
  ],
  [
    "question",
    "a question naming both a run and a workflow wait",
    ownedVariantEvent("question.asked", "interactive_request", QUESTION),
    ownedVariantEvent("question.asked", "interactive_request", {
      ...QUESTION,
      waitId: OWNER_WAIT_ID,
    }),
  ],
  [
    "MCP governance",
    "a session observation that names no leg",
    ownedVariantEvent("mcp.server_status_changed", "mcp_governance", MCP_STATUS),
    ownedVariantEvent("mcp.server_status_changed", "mcp_governance", {
      ...MCP_STATUS,
      bindingId: undefined,
    }),
  ],
  [
    "cloud task",
    "the type filed under another category",
    ownedVariantEvent("cloud.task_updated", "session_lifecycle", {
      task: {
        taskId: "session_01ABCDEF",
        sessionId: SESSION_ID,
        provider: "claude",
        state: "submitted",
        url: "https://claude.ai/code/session_01ABCDEF",
      },
    }),
    ownedVariantEvent("cloud.task_updated", "tool_activity", {
      task: {
        taskId: "session_01ABCDEF",
        sessionId: SESSION_ID,
        provider: "claude",
        state: "submitted",
        url: "https://claude.ai/code/session_01ABCDEF",
      },
    }),
  ],
  [
    "undo",
    "a record with no result",
    ownedVariantEvent("session.restore_finished", "session_lifecycle", {
      sessionId: SESSION_ID,
      target: { kind: "snapshot", snapshotId: "turn-7" },
      result: {
        outcome: "restore-finished",
        requested: "files",
        restored: "files",
        files: { restoredFileCount: 3, restoredLineCount: 41, skipped: [] },
      },
    }),
    ownedVariantEvent("session.restore_finished", "session_lifecycle", {
      sessionId: SESSION_ID,
      target: { kind: "snapshot", snapshotId: "turn-7" },
    }),
  ],
  [
    "goal",
    "a clear that names no agent",
    ownedVariantEvent("session.goal_cleared", "session_lifecycle", {
      sessionId: SESSION_ID,
      agentId: OWNER_AGENT_ID,
    }),
    ownedVariantEvent("session.goal_cleared", "session_lifecycle", { sessionId: SESSION_ID }),
  ],
  [
    "notice",
    "a lowered level looser than the one asked for",
    ownedVariantEvent("session.notice", "session_lifecycle", {
      sessionId: SESSION_ID,
      kind: "settings_ignored",
      provider: "codex",
      file: "/home/.codex/config.toml",
      line: 4,
    }),
    ownedVariantEvent("session.notice", "session_lifecycle", {
      sessionId: SESSION_ID,
      kind: "permission_level_lowered",
      requestedLevel: "reviewed",
      level: "yolo",
    }),
  ],
  [
    "side question",
    "the person's question kept in the plain half",
    ownedVariantEvent("session.side_question_answered", "session_lifecycle", SIDE_QUESTION),
    ownedVariantEvent("session.side_question_answered", "session_lifecycle", {
      ...SIDE_QUESTION,
      question: "Why is the build slow?",
    }),
  ],
  [
    "reviewer flag",
    "a reviewer signal outside the two",
    ownedVariantEvent("moderation.review_flagged", "approval_flow", REVIEW_FLAGGED),
    ownedVariantEvent("moderation.review_flagged", "approval_flow", {
      ...REVIEW_FLAGGED,
      signal: "review_blocked",
    }),
  ],
  [
    "command",
    "half an epoch stamp",
    ownedVariantEvent("command.ended", "tool_activity", COMMAND_ENDED),
    ownedVariantEvent("command.ended", "tool_activity", {
      ...COMMAND_ENDED,
      sourcePosition: undefined,
    }),
  ],
  [
    "git settlement",
    "a push that names a run",
    ownedVariantEvent("git.settled", "artifact_publication", {
      sessionId: SESSION_ID,
      cause: "committed",
      commitId: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      runId: OWNER_RUN_ID,
    }),
    ownedVariantEvent("git.settled", "artifact_publication", {
      sessionId: SESSION_ID,
      cause: "pushed",
      branch: "main",
      runId: OWNER_RUN_ID,
    }),
  ],
  [
    "relay pin",
    "a whole key hash where its prefix belongs",
    ownedVariantEvent("relay.pin_refused", "security_events", RELAY_PIN_REFUSED),
    ownedVariantEvent("relay.pin_refused", "security_events", {
      ...RELAY_PIN_REFUSED,
      presentedSpkiPrefix: "3f".repeat(32),
    }),
  ],
  [
    "session lifecycle move",
    "a move that names no state the session is in",
    ownedVariantEvent("session.archived", "session_lifecycle", {
      sessionId: SESSION_ID,
      previousState: "active",
      newState: "archived",
      actor: USER_ID,
    }),
    ownedVariantEvent("session.archived", "session_lifecycle", {
      sessionId: SESSION_ID,
      previousState: "active",
    }),
  ],
  [
    "session mark",
    "a pin carrying a pin order in place of its time",
    ownedVariantEvent("session.pinned", "session_lifecycle", {
      sessionId: SESSION_ID,
      at: "2026-09-29T12:30:00.000-07:00",
    }),
    ownedVariantEvent("session.pinned", "session_lifecycle", {
      sessionId: SESSION_ID,
      pinOrder: 1,
    }),
  ],
  [
    "chat conversion",
    "a negative copy count",
    ownedVariantEvent("session.converted", "session_lifecycle", {
      sessionId: SESSION_ID,
      repoMountId: OWNER_REPO_MOUNT_ID,
      copiedCount: 3,
      skippedPaths: ["README.md"],
    }),
    ownedVariantEvent("session.converted", "session_lifecycle", {
      sessionId: SESSION_ID,
      repoMountId: OWNER_REPO_MOUNT_ID,
      copiedCount: -1,
      skippedPaths: [],
    }),
  ],
  [
    "sweep to the repository root",
    "a cleared-move flag spelled false",
    ownedVariantEvent("session.swept_to_repo_root", "session_lifecycle", SESSION_SWEPT),
    ownedVariantEvent("session.swept_to_repo_root", "session_lifecycle", {
      ...SESSION_SWEPT,
      pendingMoveCleared: false,
    }),
  ],
  [
    "branch change",
    "a change that omits the branch it left",
    ownedVariantEvent("session.branch_changed", "session_lifecycle", {
      sessionId: SESSION_ID,
      repoMountId: OWNER_REPO_MOUNT_ID,
      worktreeId: null,
      branch: null,
      previousBranch: "main",
    }),
    ownedVariantEvent("session.branch_changed", "session_lifecycle", {
      sessionId: SESSION_ID,
      repoMountId: OWNER_REPO_MOUNT_ID,
      worktreeId: null,
      branch: null,
    }),
  ],
  [
    "worktree put-back",
    "the kept-copy member on a worktree event that does not declare it",
    ownedVariantEvent("worktree.created", "session_lifecycle", {
      ...WORKTREE_READY,
      restoredFrom: OWNER_REMOVED_WORKTREE_ID,
    }),
    ownedVariantEvent("worktree.ready", "session_lifecycle", {
      ...WORKTREE_READY,
      restoredFrom: OWNER_REMOVED_WORKTREE_ID,
    }),
  ],
  [
    "worktree discard",
    "a created worktree naming a copy a discard left",
    ownedVariantEvent("worktree.retired", "session_lifecycle", {
      ...WORKTREE_READY,
      state: "retired",
      removedWorktreeId: OWNER_REMOVED_WORKTREE_ID,
    }),
    ownedVariantEvent("worktree.created", "session_lifecycle", {
      ...WORKTREE_READY,
      removedWorktreeId: OWNER_REMOVED_WORKTREE_ID,
    }),
  ],
  [
    "model reroute",
    "a subagent scope, which the payload names local",
    ownedVariantEvent("usage.model_rerouted", "usage_telemetry", MODEL_REROUTED),
    ownedVariantEvent("usage.model_rerouted", "usage_telemetry", {
      ...MODEL_REROUTED,
      scope: "subagent",
    }),
  ],
  [
    "provider binding change",
    "a brief that declares no loss",
    ownedVariantEvent("agent.provider_binding_changed", "session_lifecycle", {
      sessionId: SESSION_ID,
      agentId: OWNER_AGENT_ID,
      actor: USER_ID,
      switchId: "switch-1",
      continuity: "resumed",
      declaredLosses: [],
      from: CLAUDE_BINDING,
      to: { ...CLAUDE_BINDING, providerAccountId: "account-3" },
      landedProviderAccountId: "account-3",
      turnContinued: true,
    }),
    ownedVariantEvent("agent.provider_binding_changed", "session_lifecycle", {
      sessionId: SESSION_ID,
      agentId: OWNER_AGENT_ID,
      actor: USER_ID,
      switchId: "switch-1",
      continuity: "brief",
      declaredLosses: [],
      from: CLAUDE_BINDING,
      to: CODEX_BINDING,
      landedProviderAccountId: "account-2",
      turnContinued: false,
    }),
  ],
  [
    "provider binding change failure",
    "an account failure that names no account state",
    ownedVariantEvent("agent.provider_binding_change_failed", "session_lifecycle", {
      sessionId: SESSION_ID,
      agentId: OWNER_AGENT_ID,
      actor: USER_ID,
      switchId: "switch-2",
      from: CLAUDE_BINDING,
      attempted: { driverName: "codex" },
      reason: "account_unavailable",
      accountState: "reauth_required",
    }),
    ownedVariantEvent("agent.provider_binding_change_failed", "session_lifecycle", {
      sessionId: SESSION_ID,
      agentId: OWNER_AGENT_ID,
      actor: USER_ID,
      switchId: "switch-2",
      from: CLAUDE_BINDING,
      attempted: { driverName: "codex" },
      reason: "account_unavailable",
    }),
  ],
  [
    "approval request",
    "an expiry, which an approval does not have",
    ownedVariantEvent("approval.requested", "approval_flow", APPROVAL_REQUESTED),
    ownedVariantEvent("approval.requested", "approval_flow", {
      ...APPROVAL_REQUESTED,
      expiryAt: "2026-09-29T19:35:00.000Z",
    }),
  ],
  [
    "approval answer",
    "an answer with no client resolution id",
    ownedVariantEvent("approval.approved", "approval_flow", APPROVAL_RESOLVED),
    ownedVariantEvent("approval.approved", "approval_flow", {
      ...APPROVAL_RESOLVED,
      clientResolutionId: undefined,
    }),
  ],
  [
    "reviewer's block",
    "a completeness mark spelled false",
    ownedVariantEvent("approval.reviewer_denied", "approval_flow", REVIEWER_DENIED),
    ownedVariantEvent("approval.reviewer_denied", "approval_flow", {
      ...REVIEWER_DENIED,
      contentTruncated: false,
    }),
  ],
  [
    "block allowed once",
    "an override that names no block",
    ownedVariantEvent("approval.denial_overridden", "approval_flow", {
      sessionId: SESSION_ID,
      denialId: OWNER_DENIAL_ID,
    }),
    ownedVariantEvent("approval.denial_overridden", "approval_flow", { sessionId: SESSION_ID }),
  ],
  [
    "step bound",
    "a bound of zero steps",
    ownedVariantEvent("run.step_limit_reached", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: OWNER_RUN_ID,
      count: 30,
    }),
    ownedVariantEvent("run.step_limit_reached", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: OWNER_RUN_ID,
      count: 0,
    }),
  ],
  [
    "goal update",
    "a goal that names no agent",
    ownedVariantEvent("session.goal_updated", "session_lifecycle", {
      sessionId: SESSION_ID,
      agentId: OWNER_AGENT_ID,
      goal: { text: "Ship the login fix" },
      status: "usage-limited",
    }),
    ownedVariantEvent("session.goal_updated", "session_lifecycle", {
      sessionId: SESSION_ID,
      goal: { text: "Ship the login fix" },
      status: "active",
    }),
  ],
  [
    "rename",
    "the plain half still carrying the name the split moves out",
    ownedVariantEvent("session.renamed", "session_lifecycle", {
      sessionId: SESSION_ID,
      origin: "user",
      actor: USER_ID,
    }),
    ownedVariantEvent("session.renamed", "session_lifecycle", {
      sessionId: SESSION_ID,
      origin: "user",
      actor: USER_ID,
      name: "Fix the login redirect",
    }),
  ],
  [
    "terminal holder",
    "a take that names no holder",
    ownedVariantEvent("pty.control_changed", "session_lifecycle", {
      sessionId: SESSION_ID,
      terminalId: "term-1",
      holderDeviceId: "desktop-1",
      holderRunId: OWNER_RUN_ID,
      holderCommandId: "command-1",
      previousHolderDeviceId: null,
      reason: "taken",
    }),
    ownedVariantEvent("pty.control_changed", "session_lifecycle", {
      sessionId: SESSION_ID,
      terminalId: "term-1",
      holderDeviceId: null,
      previousHolderDeviceId: null,
      reason: "taken",
    }),
  ],
  [
    "workflow run",
    "a start that names no pinned version",
    ownedVariantEvent("workflow.started", "workflow_lifecycle", {
      ...WORKFLOW_RUN_EVENT,
      mode: "manual",
      startedBy: { kind: "user", userId: USER_ID },
    }),
    ownedVariantEvent("workflow.started", "workflow_lifecycle", {
      ...WORKFLOW_RUN_EVENT,
      workflowVersionId: undefined,
      mode: "manual",
      startedBy: { kind: "user", userId: USER_ID },
    }),
  ],
  [
    "workflow step",
    "a skip for a reason outside the two",
    ownedVariantEvent("workflow.step_skipped", "workflow_phase_lifecycle", {
      ...WORKFLOW_STEP_EVENT,
      reason: "no-items",
    }),
    ownedVariantEvent("workflow.step_skipped", "workflow_phase_lifecycle", {
      ...WORKFLOW_STEP_EVENT,
      reason: "timed-out",
    }),
  ],
  [
    "gate resolution",
    "an answer that names no definition",
    ownedVariantEvent("workflow.gate_resolved", "workflow_gate_resolution", GATE_RESOLVED),
    ownedVariantEvent("workflow.gate_resolved", "workflow_gate_resolution", {
      ...GATE_RESOLVED,
      definitionId: undefined,
    }),
  ],
  [
    "backup",
    "the type filed under the recovery category, which admits personal data",
    ownedVariantEvent("backup.completed", "event_maintenance", {
      backupId: "2026-09-29 daily",
      totalBytes: 1_048_576,
    }),
    ownedVariantEvent("backup.completed", "recovery_events", {
      backupId: "2026-09-29 daily",
      totalBytes: 1_048_576,
    }),
  ],
  [
    "provider warning",
    "a warning from a source outside the two",
    ownedVariantEvent("session.notice", "session_lifecycle", {
      sessionId: SESSION_ID,
      kind: "provider_warning",
      source: "deprecation",
      text: "`tools.web_search` is deprecated",
      details: "Use `web_search` in config.toml instead.",
    }),
    ownedVariantEvent("session.notice", "session_lifecycle", {
      sessionId: SESSION_ID,
      kind: "provider_warning",
      source: "config",
      text: "Invalid configuration; using defaults",
    }),
  ],
];

describe("SessionEventSchema — variants whose payload a contract of its own declares", () => {
  it.each(OWNED_VARIANT_FAMILIES)(
    "%s: accepts the design's shape, and refuses %s",
    (_family, _refusedCase, accepted, refused) => {
      expect(SessionEventSchema.safeParse(accepted).success).toBe(true);
      expect(SessionEventSchema.safeParse(refused).success).toBe(false);
    },
  );
});
