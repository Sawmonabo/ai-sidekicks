// Test C3: `SessionEvent discriminated union round-trips through
// JSON`.
//
// Coverage shape:
//   • For the founding variant (session.created):
//       - parse a wire-shaped fixture, JSON-serialize it, JSON-parse it,
//         re-parse through the schema — assert deep equality with the input
//   • Discriminator dispatch is correct (parsed.type narrows the payload)
//   • Unknown `type` discriminator value is rejected
//   • Known type with a payload from a sibling variant is rejected (the
//     `.strict()` modifier prevents cross-variant payload smuggling)
//   • Each variant carries the canonical `category` literal per
//     `SESSION_EVENT_CATEGORY_BY_TYPE`, AND a category/type mismatch is
//     rejected at parse time (`category` participates in the BLAKE3-hashed
//     canonical bytes)
//   • `SESSION_EVENT_CATEGORY_BY_TYPE` is a `ReadonlyMap`, so prototype-
//     chain walks (`__proto__`, `constructor`, etc.) resolve to `undefined`
//     instead of returning truthy non-EventCategory values
//   • EventEnvelopeVersion accepts canonical "MAJOR.MINOR" forms and rejects
//     numeric / three-segment / leading-zero variants
//   • `occurredAt` accepts numeric RFC 3339 section 5.6 offsets (Z + +HH:MM)
//   • Empty-string `actor` and oversized fields are rejected (defense-in-depth)
//   • Staff-bar consistency: `wireFreeFormString` helper
//     applied to every free-form string in the EventEnvelope (`id`,
//     `actor`, `correlationId`, `causationId`) — whitespace-only and
//     NUL-byte rejection now uniform across all wire fields
//
// Adds the EventEnvelopeSchema canonical-carrier suite after it: the 11-member
// canonical-set pin, envelope-vs-strict layering, producer-set `version`
// semantics, and the payload own-`__proto__` reject-loud carve-out (record
// parser cannot preserve that key; silent stripping is forbidden), which
// extends with the daemon-scope sentinel pin (the B18 `mcp_governance` binding
// costs the carrier no carve-out). appends the `CapabilityDetailsSchema` suite
// last: the canonical capability snapshot (exhaustive enum-keyed flags;
// non-normalizing strict tools). extends coverage with the four-variant
// acceptance/rejection suite for the
// `audit_integrity` + `event_maintenance` payload variants emits itself —
// including the `failureMode`-discriminated `audit_integrity_failed` arms and
// the daemon-scope sentinel binding — and ends with the standalone-vs-union
// parity block for the four `*EventSchema` exports, on the worktree.test.ts
// precedent (outer `.strict()` has no compile-time backstop).
import { describe, expect, it } from "vitest";

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
  KeyReuseDetectedEventSchema,
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
  VerifierFailureModeSchema,
  VerifierFailurePathSchema,
  type CapabilityDetails,
  type EventCategory,
  type EventEnvelope,
  type SessionEvent,
  type SessionEventType,
  CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
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
    config: { resourceLimits: { sessions: 10 } },
    metadata: { source: "cli" },
  },
});

describe("SessionEventSchema (C3: discriminated-union JSON round-trip)", () => {
  it("registers exactly the payload-variant roster", () => {
    // The SCHEMA-registered subset (21), not the 111-type census. Each
    // group's round-trip and payload coverage lives in the suite that owns
    // its contract (repo.test.ts / worktree.test.ts for the payload shapes,
    // and the audit-integrity / event-maintenance and body-bearing assistant
    // / tool suites at the end of this file).
    expect(SESSION_EVENT_TYPES).toEqual([
      "session.created",
      "repo.attached",
      "repo.detached",
      "workspace.preparing",
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
      "event.compacted",
      "assistant.message",
      "assistant.thinking_update",
      "tool.invoked",
      "tool.result",
      "tool.error",
    ]);
  });

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
      // This is wire-load-bearing because puts `category` inside the canonical bytes
      // that back the BLAKE3 hash chain and Ed25519 signature; the parsed value must
      // equal the per-type category defined in `SESSION_EVENT_CATEGORY_BY_TYPE`.
      const parsed = SessionEventSchema.parse(build());
      expect(parsed.category).toBe(expected);
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(label)).toBe(expected);
    },
  );

  it.each([["__proto__"], ["constructor"], ["toString"], ["hasOwnProperty"], ["unknown.event"]])(
    "SESSION_EVENT_CATEGORY_BY_TYPE.get rejects prototype-chain walks: %s",
    (untrusted) => {
      // Map (NOT object-literal) lookup is load-bearing: a integrity
      // verifier that calls `.get(evt.type)` on a not-yet-parsed string
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
    // the integrity protocol would hash the event under the wrong
    // category byte and replay would diverge.
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

  it("EventCategorySchema enumerates exactly the 16 canonical categories", () => {
    // Pinning the enum values prevents accidental drift from the canonical
    // EventCategory definition. If adds a category, the spec edit must land
    // before this list; the test will fail until both sides agree.
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
      "audit_integrity",
      "security_events",
      "event_maintenance",
      "policy_events",
      "orchestration_admission",
      "mcp_governance",
    ];
    // Read `.options` from the underlying enum construct. The schema is
    // typed as the abstract `z.ZodType<EventCategory>` so we cast via
    // `unknown` to read the construct-specific `.options` property; the
    // assertions below check both length AND exact set membership.
    const schemaInternals = EventCategorySchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toHaveLength(16);
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

  // --------------------------------------------------------------------
  // The wireFreeFormString helper, applied to all free-form fields.
  // --------------------------------------------------------------------
  // Staff-bar consistency: the same wire-layer guards
  // (whitespace-only rejection + NUL-byte rejection) that protect
  // `identityHandle` are now applied to every free-form string in the
  // EventEnvelope: `id`, `actor`, `correlationId`, `causationId`.
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
// strings (event.ts).
//
// The precision cases below are the second load-bearing guard: the SCHEMA caps
// input length (EVENT_ENVELOPE_VERSION_MAX_LEN), but well within that bound a
// `Number` parse still collapses two distinct versions above
// `Number.MAX_SAFE_INTEGER` to one float. The comparator parses with `BigInt`,
// so the ordering stays EXACT across that range: two versions that collapsed to
// one float would otherwise compare as equal.
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
// SessionEventType census + category registry.
// --------------------------------------------------------------------------
//
// Backstops the full census (111 types across 16 categories) plus the
// category/type bijection: SESSION_EVENT_CATEGORY_BY_TYPE covers every
// registered type exactly once, its values span exactly the 16 canonical
// categories (every category non-empty), and the 16 per-category arrays
// partition the census. Assertions are exact-set style wherever set equality
// is feasible (the hardened idiom of the EventCategorySchema pin above), with
// the exact size assertions (size === 111, 16 distinct categories) alongside.

// One row per category with its pinned count. Rows sum to 111 (asserted
// below), mirroring the census table's Total row.
const CENSUS_BASELINE: ReadonlyArray<
  readonly [EventCategory, readonly SessionEventType[], number]
> = [
  ["run_lifecycle", RUN_LIFECYCLE_EVENT_TYPES, 13],
  ["assistant_output", ASSISTANT_OUTPUT_EVENT_TYPES, 2],
  ["tool_activity", TOOL_ACTIVITY_EVENT_TYPES, 7],
  ["interactive_request", INTERACTIVE_REQUEST_EVENT_TYPES, 16],
  ["artifact_publication", ARTIFACT_PUBLICATION_EVENT_TYPES, 6],
  ["session_lifecycle", SESSION_LIFECYCLE_EVENT_TYPES, 27],
  ["approval_flow", APPROVAL_FLOW_EVENT_TYPES, 10],
  ["usage_telemetry", USAGE_TELEMETRY_EVENT_TYPES, 8],
  ["runtime_node_lifecycle", RUNTIME_NODE_LIFECYCLE_EVENT_TYPES, 2],
  ["recovery_events", RECOVERY_EVENTS_EVENT_TYPES, 3],
  ["audit_integrity", AUDIT_INTEGRITY_EVENT_TYPES, 3],
  ["security_events", SECURITY_EVENTS_EVENT_TYPES, 5],
  ["event_maintenance", EVENT_MAINTENANCE_EVENT_TYPES, 1],
  ["policy_events", POLICY_EVENTS_EVENT_TYPES, 2],
  ["orchestration_admission", ORCHESTRATION_ADMISSION_EVENT_TYPES, 1],
  ["mcp_governance", MCP_GOVERNANCE_EVENT_TYPES, 5],
];

// The fifteen most recently minted literals, each with the category it
// registered under — census members asserted PRESENT under a named category.
//
// The element type is load-bearing, not decoration. `SessionEventType` is
// the census union itself, so a literal that failed to register — or that a
// later edit renames, which the immutability rule forbids — is a COMPILE
// error under `tsc -p tsconfig.test.json` (the package's `typecheck` leg;
// vitest strips types and would not catch it). The runtime assertions below
// pin the category half and the 96 + 15 = 111 arithmetic.
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
  it("registers exactly 111 types across exactly 16 distinct categories", () => {
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.size).toBe(111);
    expect(new Set(SESSION_EVENT_CATEGORY_BY_TYPE.values()).size).toBe(16);
  });

  it("registry categories span exactly the canonical EventCategory set (no empty category)", () => {
    // Exact-set schema surface (same `.options` cast idiom as the
    // EventCategorySchema pin above): the surjective side of the bijection —
    // every canonical category has at least one registered type.
    const schemaInternals = EventCategorySchema as unknown as { options: readonly string[] };
    const registryCategories = [...new Set(SESSION_EVENT_CATEGORY_BY_TYPE.values())].sort();
    expect(registryCategories).toEqual([...schemaInternals.options].sort());
  });

  it("census table is complete: 16 rows, one per category, counts summing to 111", () => {
    const tableCategories = CENSUS_BASELINE.map(([category]) => category);
    expect(tableCategories).toHaveLength(16);
    expect(new Set(tableCategories).size).toBe(16);
    const total = CENSUS_BASELINE.reduce((sum, [, , expectedCount]) => sum + expectedCount, 0);
    expect(total).toBe(111);
  });

  it.each(CENSUS_BASELINE)(
    "%s: per-category array equals the registry partition, count pinned to census",
    (category, categoryTypes, expectedCount) => {
      // Census-row pin (aggregated per category).
      expect(categoryTypes).toHaveLength(expectedCount);
      // No intra-array duplicates: distinct-member count equals length.
      expect(new Set(categoryTypes).size).toBe(expectedCount);
      // Exact set equality vs the registry's keys filtered to this category
      // — anti-drift bind between arrays and registry. This also forces
      // pairwise-disjoint arrays: each registry key carries exactly one
      // category, so the 16 filtered key sets are disjoint.
      const registryKeysInCategory = [...SESSION_EVENT_CATEGORY_BY_TYPE.entries()]
        .filter(([, registeredCategory]) => registeredCategory === category)
        .map(([eventType]) => eventType)
        .sort();
      expect([...categoryTypes].sort()).toEqual(registryKeysInCategory);
    },
  );

  it("the 16 per-category arrays partition the registry key set exactly", () => {
    const aggregated = CENSUS_BASELINE.flatMap(([, categoryTypes]) => [...categoryTypes]);
    expect(aggregated).toHaveLength(111);
    expect(new Set(aggregated).size).toBe(111);
    expect([...aggregated].sort()).toEqual([...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].sort());
  });

  it("keeps the founding wire literal unrenamed with an unchanged category", () => {
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.get("session.created")).toBe("session_lifecycle");
    // The SCHEMA-registered payload subset grows ONLY through the
    // union-registration seam, and every one of those type strings is
    // already a census member. The loop below is the bind that matters:
    // every registered variant must be a census member, so a variant
    // registered under an unregistered literal fails here.
    expect(SESSION_EVENT_TYPES).toEqual([
      "session.created",
      "repo.attached",
      "repo.detached",
      "workspace.preparing",
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
      "event.compacted",
      "assistant.message",
      "assistant.thinking_update",
      "tool.invoked",
      "tool.result",
      "tool.error",
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
    // pair `key_reuse_detected` is a flat name with no namespace at
    // all).
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
    ["key_reuse_detected", "audit_integrity"],
  ] as const)(
    "category authority is the registry, not the namespace prefix: %s -> %s",
    (eventType, expectedCategory) => {
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe(expectedCategory);
    },
  );

  it("the census minus the fifteen late-minted literals is exactly 96 types", () => {
    // Completeness self-check for the LATE_MINTED_TYPES fixture (the same
    // row-sum bind CENSUS_BASELINE gets above): `111 − 15 = 96`, pinning
    // the delta's SIZE so the widening cannot be over- or under-counted. A
    // dropped or duplicated fixture entry fails here instead of leaving 14
    // passing per-literal pins.
    expect(LATE_MINTED_TYPES).toHaveLength(15);
    expect(new Set(LATE_MINTED_TYPES.map(([eventType]) => eventType)).size).toBe(15);
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.size - LATE_MINTED_TYPES.length).toBe(96);
    // Removing the fifteen leaves exactly 96 keys. This is a cardinality
    // bind, not an identity one: a rename edited in both the record and its
    // per-category array would still land on 96. Names are pinned elsewhere —
    // the founding literal and the prefix-mismatch rows above, plus
    // CENSUS_BASELINE's per-category counts.
    const minted = new Set<string>(LATE_MINTED_TYPES.map(([eventType]) => eventType));
    const remaining = [...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].filter(
      (eventType) => !minted.has(eventType),
    );
    expect(remaining).toHaveLength(96);
  });

  it.each([...LATE_MINTED_TYPES])(
    "late-minted literal %s is registered under %s",
    (mintedType, expectedCategory) => {
      // One `.get()` proves both halves — an unregistered literal returns
      // `undefined`, and a literal registered under the wrong category
      // returns the wrong value. (The element type already proved
      // registration at COMPILE time; this adds the category.)
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(mintedType)).toBe(expectedCategory);
    },
  );
});

// --------------------------------------------------------------------------
// EventEnvelopeSchema: the canonical event carrier.
// --------------------------------------------------------------------------
//
// Backstops — the canonical set) and the two Phase-1 invariants the named
// envelope export underwrites:
//   • The envelope FIELD SET is fixed at the canonical eleven members;
//     serialized ORDER is RFC 8785 section 3.2.3 UTF-16 code-unit
//     lex-sort, produced by Phase 2's canonicalizer (golden vectors) — so
//     this layer pins membership mechanically, not byte order.
//   • `version` is producer-set and never rewritten: the parse path must
//     hand back the producer's string verbatim. The read-side
//     never-rewrite half (upcaster chain) is daemon behavior, out of
//     contract-layer reach — asserted by the consuming plans, not here.
// Layering: the envelope is the version- TOLERANT carrier — `type` is a
// bounded free-form string, NOT the census union — while
// `SessionEventSchema` stays the strict interpretation layer.

// The canonical 11-member set, transcribed. Listed in wire-authority
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

describe("EventEnvelopeSchema — canonical carrier", () => {
  it("declares exactly the canonical 11-field set (membership pin)", () => {
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
    // Layering pin: `usage.token_count` is census-registered but has no
    // discriminated-union payload variant — the tolerant carrier parses it,
    // the strict layer refuses to interpret it.
    const fixture = buildBareEnvelope();
    expect(EventEnvelopeSchema.safeParse(fixture).success).toBe(true);
    expect(SessionEventSchema.safeParse(fixture).success).toBe(false);
  });

  it("accepts a census-UNKNOWN forward type", () => {
    // A reader must be able to parse the ENVELOPE (to persist it as a
    // version stub) for a type from a NEWER producer that this build's
    // census does not know at all — rejecting here would drop exactly the
    // events the stub path exists to preserve.
    //
    // The literal is deliberately fictional (the `session.exploded` idiom
    // used by the unknown-discriminator pin above), and its absence from
    // the census is asserted MECHANICALLY rather than asserted in prose.
    // That guard is the point: this test previously used `session.renamed`
    // — then a B18-pending literal — and the census closure registered it,
    // which would have left the test green while its stated premise
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
    // `mcp_governance` types to the RFC 9562 section 5.10 Max UUID sentinel, with
    // a session-scoped initiator living in the payload as `initiatingSessionId` —
    // never in the row's own `sessionId`. Choosing the sentinel is a producer
    // obligation; what makes it FREE at this layer is that the `sessionId` UUID
    // check already admits the Max UUID, so no sentinel branch and no widened
    // field type are needed. The case qualifier this comment used to carry is GONE
    // as of 2026-09-08 and the history is worth keeping, because it was a real
    // producer obligation rather than a footnote: while `brandedUuidIdSchema`
    // delegated to Zod's unversioned uuid regex, that pattern reached the Max UUID
    // only through a lowercase string-literal alternative carrying no `i` flag,
    // and its general alternative demands a `[1-8]` version nibble that `f` fails
    // — so `FFFFFFFF-…` was REJECTED even though RFC 9562 section 4 makes UUID
    // text case-insensitive, and the producer obligation was "emit the sentinel
    // LOWERCASE," not merely "emit the sentinel." `internal/branded.ts` now
    // validates against its own `RFC_9562_TEXT_FORM` predicate carrying `i`, so
    // every spelling of the sentinel parses and the obligation is only the
    // canonical-form convention. The acceptance is pinned in `session-id.test.ts`
    // at the FACTORY, which is where the predicate lives; no uppercase-rejection
    // assertion was ever pinned here, deliberately — it would have frozen a Zod
    // regex quirk and turned red for the very fix that has now landed. The
    // sentinel is the PRODUCTION constant, not a local respelling: a test that
    // carries its own literal passes even if the shipped constant drifts to a
    // different (or uppercase) value, which is exactly the regression this arm
    // exists to catch. Pinning the Max-UUID acceptance means a future tightening
    // of that check (a v4-only constraint, say) fails HERE rather than silently
    // making every node-scope governance event unrepresentable on the wire. The
    // sentinel is deliberately disjoint from the `gen_random_uuid()` v4 space real
    // sessions draw from, so a sentinel-partitioned chain cannot collide with a
    // real session's. The payload carries only `initiatingSessionId` — owns the
    // rest of the governance payload shape, and the carrier treats `payload` as
    // opaque anyway.
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
      // `pii_payload` foremost: it is a storage COLUMN, deliberately NOT in
      // the canonical form — an envelope smuggling it as a top-level member
      // is malformed, and silently stripping it would desync the parse
      // output from the hashed canonical bytes. The `__proto__` row pins
      // that Zod's OBJECT parser (unlike its record parser — see the
      // payload pre-guard pins below) surfaces an own `__proto__` as an
      // unrecognized key, so `.strict()` rejects it. The computed-key
      // spread creates an OWN property (only a non-computed literal
      // `__proto__:` key in an object literal would set the prototype
      // instead).
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
      // The wire authority types the correlation pair `field?: string` —
      // optional, NOT nullable, matching `buildCommonShape()`'s modeling
      // (unchanged refactor): `actor` alone carries the null-for-system
      // convention. Pinned so any widening to nullable is a deliberate,
      // loud contract change.
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
    // literal `{ __proto__:... }` would set the prototype instead and
    // never reach the parser with an own key. Zod's record parser
    // unconditionally SKIPS own `__proto__` keys, so preserve-verbatim is
    // impossible for this one key and the default outcome is a silent drop
    // — two distinct wire byte-strings collapsing to one parse output
    // no-collapse hazard. The payload pre-guard (raw pre-record
    // superRefine; a refine on the record's OUTPUT could never see the
    // already-dropped key) rejects it loud instead.
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
      // the prototype members) — still round-trips untouched.
      // Forward-regression pin: Zod's record-parser skip-list is
      // verifiably `__proto__`-only today, making the pre-guard exactly
      // co-extensive with the drop behavior; a future Zod upgrade that
      // widens that skip-list would silently reintroduce the drop-collapse
      // hazard for keys the guard does not cover — it must fail loud HERE
      // first (same forward-pin idiom as the `.options` / `.shape`
      // internals casts).
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
      // The strict layer emits within the carrier contract: each registered
      // variant fixture re-parses through EventEnvelopeSchema, and the
      // subtype relation holds at compile time — the `EventEnvelope`
      // annotation below is the static leg (the variants extend the
      // envelope interface since refactor).
      const parsed: EventEnvelope = SessionEventSchema.parse(build());
      expect(EventEnvelopeSchema.safeParse(parsed).success).toBe(true);
    },
  );
});

// --------------------------------------------------------------------------
// CapabilityDetailsSchema: canonical capability snapshot.
// --------------------------------------------------------------------------
//
// Backstops the canonical capability snapshot shape.
//   • NON-NORMALIZING: parse output is structurally identical to accepted
//     input (the daemon emitter persists the PARSED output, so any
//     default-filling or stripping arm would rewrite stored payloads). The
//     discriminator vs the ingress `ProviderToolMetadataSchema`: a tool
//     entry MISSING `idempotency_class` REJECTS here, where the ingress
//     normalizer would default-fill `manual_reconcile_only`.
//   • EXHAUSTIVE flags: enum-keyed record over the live
//     `DRIVER_CAPABILITY_FLAGS` const — a missing member, an unknown key,
//     and a non-boolean value all reject. Fixtures DERIVE from the const
//     (no hardcoded flag names or counts), so the scheduled flag widening
//     flows through this suite without edits.

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
// The four payload variants.
// --------------------------------------------------------------------------
//
// `audit_integrity` (3) + `event_maintenance` (1) — the only registered
// variants emits itself, so their payload schemas are authored in event.ts
// rather than imported from an emitting plan's module. Coverage is
// deliberately variant-level (through `SessionEventSchema`) rather than
// payload-level: registration into the union is half of what ships, and a
// payload-only suite would stay green if an arm were never registered.

const NODE_ID = "node-7f3a2c";
// The daemon-scope sentinel (RFC 9562 section 5.10 Max UUID, lowercase — the case
// matters, see the carrier-level pin above) is referenced BY ITS PRODUCTION NAME
// below, `DAEMON_SCOPE_SENTINEL_SESSION_ID`, with no local literal and no local
// alias. asks for single-SOURCE, not merely single-VALUE: a local alias binding
// would still declare a name in this module that a later edit could silently
// re-point at a respelled literal, which is the exact drift the export exists to
// foreclose. A SECOND real session id.
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
    // The verified range — REQUIRED on this arm, because the
    // consumer dedupe key is `(verifierNodeId, fromSeq, toSeq, verifiedAt)`
    // and was unconstructible without them. Same endpoints as the
    // `audit_integrity_verified` fixture.
    fromSeq: 1,
    toSeq: 4096,
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
  sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
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
    fromSeq: 1,
    toSeq: 4096,
    eventsBefore: 4096,
    eventsAfter: 512,
    bytesReclaimed: 8_388_608,
    tombstoneCount: 3584,
    compactionReason: "age_threshold",
  },
});

const REGISTRAR_FAILURE_MODE = "signing_key_slot_conflict";

// The registered modes READ OFF THE ENUM rather than re-spelled — and read
// through the EXPORTED type surface with NO cast, which is itself the tripwire
// for the annotation regression: `VerifierFailureModeSchema` is
// annotated `z.ZodEnum<...>` precisely so `.options` and `.exclude()` survive
// the module boundary (derives its verifier discriminator with the latter), and
// an annotation sliding back to the erasing `z.ZodType` form turns this line
// red at compile time instead of leaving to discover it at ITS boundary.
// Contrast the `EventCategorySchema` pin above, which still needs the cast
// idiom because no consumer derives from its enum surface. Exact membership is
// pinned once, against a hand-transcribed list, in the vocabulary test below —
// the tables here only DRIVE, so an eighteenth mode joins the per-mode coverage
// automatically instead of being silently skipped.
const VERIFIER_FAILURE_MODE_OPTIONS = VerifierFailureModeSchema.options;

// The read-side verifier modes — every registered mode except the registrar's,
// which belongs to the other payload arm and is exercised separately. That
// split is the whole point of the discrimination, so the table derives it
// rather than restating it.
const VERIFIER_FAILURE_MODES = VERIFIER_FAILURE_MODE_OPTIONS.filter(
  (mode) => mode !== REGISTRAR_FAILURE_MODE,
);

// Each verifier mode beside a `failurePath` the corpus ADMITS for it,
// transcribed by hand from `Security Architecture ` rather than imported from
// event.ts's own map — two independent spellings are what make the pin worth
// anything. The first three and the last seven rows are the TEN
// authority-FIXED pairings (rule 1 → `inclusion`, rule 3 → `consistency`,
// rules 2 + 4 → `signature`); the middle six modes have no corpus-fixed path,
// so their entry here is one lawful choice among three and the latitude itself
// is asserted separately below. Set membership is pinned against
// `VERIFIER_FAILURE_MODES` so a vocabulary change breaks this table loudly
// instead of leaving a mode silently unexercised.
const VERIFIER_MODE_PATH_PAIRS = [
  ["hash_mismatch", "inclusion"],
  ["signature_mismatch", "signature"],
  ["anchor_mismatch", "consistency"],
  ["inclusion_proof_failed", "inclusion"],
  ["consistency_proof_failed", "consistency"],
  ["log_file_missing", "inclusion"],
  ["log_file_moved", "inclusion"],
  ["anchor_missing_for_compacted_range", "consistency"],
  ["anchor_signature_invalid", "signature"],
  ["stub_signature_invalid", "signature"],
  ["stub_scalar_mismatch", "signature"],
  ["signature_placeholder", "signature"],
  ["occurred_at_not_canonical", "signature"],
  ["pii_ciphertext_digest_unbound", "signature"],
  ["pii_owner_stamp_unbound", "signature"],
  ["content_ciphertext_digest_unbound", "signature"],
] as const;

const SESSION_EVENT_VARIANTS = [
  ["audit_integrity_verified", buildAuditIntegrityVerified],
  ["audit_integrity_failed", buildAuditIntegrityFailedVerifierArm],
  ["audit_integrity_failed (registrar arm)", buildAuditIntegrityFailedRegistrarArm],
  ["key_reuse_detected", buildKeyReuseDetected],
  ["event.compacted", buildEventCompacted],
] as const;

// `audit_integrity_verified` / `audit_integrity_failed` are deliberately
// ABSENT: they carry the verified range's real session id.
const SENTINEL_BOUND_VARIANTS = [
  ["key_reuse_detected", buildKeyReuseDetected],
  ["event.compacted", buildEventCompacted],
] as const;

describe("audit_integrity + event_maintenance payload variants", () => {
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
      // `category` is in the BLAKE3-hashed canonical bytes, so a type/category
      // mismatch must die at parse time, never be coerced.
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
      // None of the four is run-scoped, so none is `withEpochStamp`-wrapped and
      // the strict payload refuses the stamp. The admission RULE is walked
      // over the live union in event-source-epoch.test.ts; this is the
      // wire-level consequence for these four branches.
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

  it("registers EXACTLY the seventeen failure modes and the three failure paths", () => {
    // The exported vocabulary consume, transcribed in the enum's own order.
    // Seventeen, not sixteen: the registrar's `signing_key_slot_conflict` is a
    // member of the enum even though it routes to the other payload arm.
    //
    // Set equality, not just acceptance — acceptance alone passes an
    // eighteenth mode, a dropped one, and a renamed one alike, and every
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
      "content_ciphertext_digest_unbound",
      REGISTRAR_FAILURE_MODE,
    ];
    expect(VERIFIER_FAILURE_MODE_OPTIONS).toHaveLength(17);
    expect([...VERIFIER_FAILURE_MODE_OPTIONS].sort()).toEqual([...expectedModes].sort());
    // The derivation the arm split rests on: sixteen read-side modes, the
    // registrar's excluded.
    expect(VERIFIER_FAILURE_MODES).toHaveLength(16);
    expect(VERIFIER_FAILURE_MODES).not.toContain(REGISTRAR_FAILURE_MODE);
    // The mode/path table below must cover exactly those sixteen — a mode
    // added, renamed, or retired must not leave a row unexercised.
    expect(VERIFIER_MODE_PATH_PAIRS.map(([mode]) => mode).sort()).toEqual(
      [...VERIFIER_FAILURE_MODES].sort(),
    );
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

  it("exports VerifierFailureModeSchema with its .exclude() surface intact", () => {
    // The DOCUMENTED consumer derivation, written here exactly as that task
    // will write it in `integrity-verifier.ts`. Writing it from a DIFFERENT
    // module is the whole point: under the erasing
    // `z.ZodType<VerifierFailureMode>` annotation the same expression compiled
    // fine inside event.ts, off the unannotated module-local twin, and broke
    // only where an importer wrote it — so the break was invisible to the file
    // that shipped the symbol.
    const verifierOnly = VerifierFailureModeSchema.exclude([REGISTRAR_FAILURE_MODE]);
    expect(verifierOnly.options).toHaveLength(16);
    expect([...verifierOnly.options].sort()).toEqual([...VERIFIER_FAILURE_MODES].sort());
    for (const mode of VERIFIER_FAILURE_MODES) {
      expect(verifierOnly.safeParse(mode).success).toBe(true);
    }
    // The seventeenth is refused by the derived schema and accepted by its
    // parent — the derivation subtracts exactly one member.
    expect(verifierOnly.safeParse(REGISTRAR_FAILURE_MODE).success).toBe(false);
    expect(VerifierFailureModeSchema.safeParse(REGISTRAR_FAILURE_MODE).success).toBe(true);
  });

  it.each(VERIFIER_MODE_PATH_PAIRS)(
    "the verifier arm accepts failureMode %s with failurePath %s, carrying the Merkle triple and the range",
    (failureMode, failurePath) => {
      const event = buildAuditIntegrityFailedVerifierArm();
      expect(
        SessionEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, failureMode, failurePath },
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    // The motivating example first: a never-signed row claiming
    // the CHAIN path would route to the tamper responder instead of the
    // sequencing-bug owner, permanently — these rows are never compacted and
    // never shredded.
    ["signature_placeholder", "inclusion"],
    ["hash_mismatch", "signature"],
    ["anchor_mismatch", "inclusion"],
  ] as const)(
    "rejects the authority-fixed %s paired with the wrong failurePath %s",
    (failureMode, failurePath) => {
      const event = buildAuditIntegrityFailedVerifierArm();
      // Positive control on the same fixture: the row is lawful until the
      // pairing is broken, so the rejection below is the pairing's doing.
      expect(SessionEventSchema.safeParse(event).success).toBe(true);
      expect(
        SessionEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, failureMode, failurePath },
        }).success,
      ).toBe(false);
    },
  );

  it.each(["inclusion", "consistency", "signature"] as const)(
    "an unfixed mode keeps the full three-value latitude — log_file_missing + %s",
    (failurePath) => {
      // The six modes `Security Architecture ` names with no `failurePath` must
      // NOT be pinned locally: a narrowing nothing could relax is MAJOR #8.
      // This is the guard against over-tightening the check above.
      const event = buildAuditIntegrityFailedVerifierArm();
      expect(
        SessionEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, failureMode: "log_file_missing", failurePath },
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    ["treeSize"],
    ["expectedRootHash"],
    ["observedRootHash"],
    // The range endpoints are REQUIRED, not optional: the dedupe key is
    // unconstructible without them, and every verifier invocation has a
    // request range even when no single row is implicated.
    ["fromSeq"],
    ["toSeq"],
    ["detail"],
  ] as const)("the verifier arm REQUIRES %s", (member) => {
    const event = buildAuditIntegrityFailedVerifierArm();
    const { [member]: _omitted, ...payload } = event.payload;
    expect(SessionEventSchema.safeParse({ ...event, payload }).success).toBe(false);
  });

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

  it("rejects a failureMode outside the registered vocabulary entirely", () => {
    // Complement of the test above: that one refuses a REGISTERED mode
    // arriving at the wrong arm; this one refuses a mode NO arm declares, so
    // the payload matches neither discriminator and the union has nowhere to
    // dispatch it. Without this control the discriminator could admit any
    // string and every in-vocabulary assertion in this block would still pass.
    // The unmodified-fixture parse is the positive control — it proves the
    // rejection below comes from the mode, not from a fixture that drifted.
    const event = buildAuditIntegrityFailedVerifierArm();
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, failureMode: "not_a_registered_mode" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["treeSize", 4096],
    ["expectedRootHash", ROOT_HASH],
    ["offendingSeq", 12],
    // The range endpoints split the same way as the triple: the registrar
    // verified no range, so carrying one here would be fabrication too.
    ["fromSeq", 1],
    ["toSeq", 4096],
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

  it("the registrar arm REJECTS anchorId — its reduced base, enforced", () => {
    // The discriminating control: this assertion
    // FAILS on the pre-fix schema, where the arm spread the full base and an
    // offered `anchorId` parsed green. calls the member permanently absent on
    // this row — never compacted, never shredded, never rewritten — so an
    // optional-but-conventionally-unset member would leave an emitter free to
    // persist a false anchor association nothing could later correct.
    // `.strict()` is what turns the dropped key into a refusal.
    const event = buildAuditIntegrityFailedRegistrarArm();
    // Positive control: the fixture carries no `anchorId` and parses.
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, anchorId: "anchor-0007" },
      }).success,
    ).toBe(false);
  });

  it("the verifier arm still takes anchorId — the exclusion is arm-scoped", () => {
    // The complement of the assertion above, and the reason it is a SPLIT
    // rather than a removal: `anchorId` stays meaningful on the arm that
    // walked a range an anchor can cover.
    const event = buildAuditIntegrityFailedVerifierArm();
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, anchorId: "anchor-0007" },
      }).success,
    ).toBe(true);
  });

  it("the audit_integrity_verified payload takes anchorId both ways (optional)", () => {
    // Scoped to this event type as of 2026-08-03: the sibling
    // `audit_integrity_failed` registrar arm refuses the member outright, so
    // "audit_integrity payloads" would now over-quantify.
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
    // A key "registered under MORE THAN ONE identity". One identity holding
    // its own key is the compliant register-once state, not an alarm.
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
    // States the finding as the same key material under two DISTINCT
    // `(session_id, node_id)` pairs, so a repeated pair is one identity
    // holding its own key, listed twice: the compliant register-once posture.
    // With `.min(2)` alone this row parses green and mints a false key-reuse
    // alarm on a row that is never compacted and never shredded, so the false
    // alarm is permanent.
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

  it("key_reuse_detected rejects ONE identity spelled in two UUID cases", () => {
    // The distinctness check keys on a serialized `(sessionId, nodeId)` pair,
    // which makes that key a Map-key boundary — and UUID hex is
    // case-INSENSITIVE (RFC 9562 section 4) while the branded schemas normalize
    // nothing. Without canonicalization these two rows read as two identities
    // and mint a permanent FALSE alarm on a never-compacted, never-shredded
    // row: the same defect the test above catches, reached by spelling rather
    // than by duplication. This is the discriminating control for the fix —
    // it passes (wrongly) against a refinement that keys on the raw value.
    const event = buildKeyReuseDetected();
    const uppercased = {
      sessionId: SESSION_ID.toUpperCase(),
      nodeId: NODE_ID,
    };
    const caseVariants = SessionEventSchema.safeParse({
      ...event,
      payload: {
        ...event.payload,
        observedIdentities: [{ sessionId: SESSION_ID, nodeId: NODE_ID }, uppercased],
      },
    });
    expect(caseVariants.success).toBe(false);
    const issueMessages = caseVariants.error?.issues.map((issue) => issue.message) ?? [];
    expect(
      issueMessages.some((message) => /must not name one .* identity twice/.test(message)),
    ).toBe(true);
  });

  it("key_reuse_detected still accepts two DISTINCT identities when one is uppercase", () => {
    // The other half of the canonicalization: folding case must not collapse
    // genuinely different identities. `nodeId` is deliberately NOT folded —
    // it is a bounded free-form brand, not a UUID, so no authority makes it
    // case-insensitive and folding it could merge two real nodes, failing
    // OPEN on the alarm this event exists to raise.
    const event = buildKeyReuseDetected();
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: {
          ...event.payload,
          observedIdentities: [
            { sessionId: SESSION_ID.toUpperCase(), nodeId: NODE_ID },
            { sessionId: OTHER_SESSION_ID, nodeId: "node-b41d" },
          ],
        },
      }).success,
    ).toBe(true);
    // Same sessionId, different nodeId — still two identities, uncollapsed.
    expect(
      SessionEventSchema.safeParse({
        ...event,
        payload: {
          ...event.payload,
          observedIdentities: [
            { sessionId: SESSION_ID, nodeId: NODE_ID },
            { sessionId: SESSION_ID, nodeId: "node-b41d" },
          ],
        },
      }).success,
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

  it.each([["compactionReason", buildEventCompacted, "disk_pressure"]] as const)(
    "rejects an out-of-vocabulary %s",
    (member, build, badValue) => {
      const event = build();
      expect(
        SessionEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, [member]: badValue },
        }).success,
      ).toBe(false);
    },
  );

  it("caps audit_integrity_failed.detail at its boundary", () => {
    const event = buildAuditIntegrityFailedRegistrarArm();
    const atCap = { ...event.payload, detail: "x".repeat(AUDIT_INTEGRITY_DETAIL_MAX_LEN) };
    const overCap = { ...event.payload, detail: "x".repeat(AUDIT_INTEGRITY_DETAIL_MAX_LEN + 1) };
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

// The standalone exports are the surface the four emission seams validate
// against before append — they all `.parse()` a candidate row
// through one of them rather than through the whole union. They must therefore
// agree with the independently-spelled union arms (the repo.test.ts /
// worktree.test.ts standalone-vs-union stance). The two spellings are NOT
// deduplicated: independent spelling is the design, and this block is what
// makes it safe.
//
// Structural `parse` / `safeParse` typing sidesteps `z.ZodType` variance (the
// repo.test.ts standalone-schema precedent); the fixture view is the two
// members every row is probed on.
type AuditEventFixture = {
  readonly category: string;
  readonly payload: Record<string, unknown>;
};

const STANDALONE_AUDIT_EVENT_SCHEMAS: ReadonlyArray<
  readonly [
    string,
    () => AuditEventFixture,
    {
      parse: (candidate: unknown) => unknown;
      safeParse: (candidate: unknown) => { success: boolean };
    },
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
  ["event.compacted", buildEventCompacted, EventCompactedEventSchema],
];

describe("standalone event schemas agree with the union arms", () => {
  it.each(STANDALONE_AUDIT_EVENT_SCHEMAS)(
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

  it.each(STANDALONE_AUDIT_EVENT_SCHEMAS)(
    "%s standalone rejects what the union rejects (unknown payload key)",
    (_label, build, standaloneSchema) => {
      const fixture = build();
      const broken = { ...fixture, payload: { ...fixture.payload, vendorExtension: "drift" } };
      expect(standaloneSchema.safeParse(broken).success).toBe(false);
      expect(SessionEventSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each(STANDALONE_AUDIT_EVENT_SCHEMAS)(
    "%s standalone refuses a spurious ENVELOPE key and a category mismatch",
    (_label, build, standaloneSchema) => {
      // Outer `.strict()` is the one axis of this parity with NO compile-time
      // backstop. A widened `type` or `category` literal fails against the
      // `z.ZodType<*Event>` annotation, and payload strictness cannot diverge
      // because both surfaces reference the same payload schema object — but a
      // schema's inferred output type does not reflect outer `.strict()`, so a
      // copy-paste slip that dropped it from one of the four exports would
      // typecheck green and STRIP the spurious key instead of rejecting. The
      // emission seam validating through that surface would then append
      // canonical bytes it never built, surfacing much later as a strict-union
      // rejection at replay — and on these four rows, which are never
      // compacted, the divergence is permanent. The union control on
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
// The five body-bearing assistant / tool payload variants.
// --------------------------------------------------------------------------
//
// These are the variants whose absence made `session_events.content_payload`
// unwritable: both shipped provider normalizers derive emission readiness from
// `SESSION_EVENT_TYPES`, so an unregistered target forbids envelope
// construction outright. Coverage below is about the SHAPE contract — no body
// member, the two families kept distinct, and the codec-owned members
// admissible but never required.

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
    contentCiphertextDigest: "a".repeat(64),
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
    contentCiphertextDigest: "b".repeat(64),
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
    contentCiphertextDigest: "c".repeat(64),
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
      delete bare[CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY];
      // A row whose type admits prose but that carried none is valid; requiring
      // the members would force a producer to fabricate a digest for bytes that
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
    // A `toolName` on an assistant row and a `contentType` on a tool row are
    // both members the governing spec sections decline to define.
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
    // The figure the sealing codec enforces; pinned here because three modules
    // read it and a silent change would move a durable truncation boundary.
    expect(CONTENT_PAYLOAD_PLAINTEXT_MAX).toBe(262_144);
    expect(CONTENT_PAYLOAD_PLAINTEXT_MAX).toBe(256 * 1024);
  });

  it("exports the three codec-owned payload keys under their wire spellings", () => {
    expect(CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY).toBe("contentCiphertextDigest");
    expect(CONTENT_LENGTH_PAYLOAD_KEY).toBe("contentLength");
    expect(CONTENT_TRUNCATED_PAYLOAD_KEY).toBe("contentTruncated");
  });
});
