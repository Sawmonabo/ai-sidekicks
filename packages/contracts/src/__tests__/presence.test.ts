// Plan-002 Phase 1 T1.3 — presence contract schema tests.
//
// Backstops the C4 acceptance criterion (Plan-002 §C4, Spec-002 line 84):
// `PresenceHeartbeat` payload carries the 5 required metadata fields
// `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`
// per the canonical wire form at docs/architecture/contracts/api-payload-
// contracts.md lines 412-417 merged with the Spec-002 line 59 metadata
// requirement.
//
// Test surface enumerated (the "what" each block pins):
//   * PresenceStateSchema wire-form pin — exactly the 4 canonical literals
//     `{online, idle, reconnecting, offline}` per Spec-002 line 47 and
//     api-payload-contracts.md:123. `"away"` / `"busy"` rejected.
//   * JoinModeSchema wire-form pin — exactly the 3 canonical SPACED literals
//     `{viewer, collaborator, runtime contributor}` per api-payload-
//     contracts.md:120. snake_case `"runtime_contributor"` rejected.
//   * PresenceHeartbeatSchema happy path — all 3 outer + 5 metadata fields
//     parse cleanly. C4 backstop.
//   * PresenceHeartbeatSchema required-field guards — outer 3 each required
//     (participantId, deviceId, activityState); ALL 5 metadata fields each
//     required-key-at-parse (deviceType, focusedSessionId, focusedChannelId,
//     lastActivityAt, appVisible). focusedSessionId and focusedChannelId
//     additionally accept explicit `null` as their value (.nullable() shape);
//     `undefined` is rejected to pin against future drift to `.nullish()`.
//   * PresenceHeartbeatSchema .strict() anti-leakage — unknown top-level OR
//     unknown `metadata.*` key rejected.
//   * PresenceUpdateSchema happy path — `{sessionId, awarenessState}` with
//     real Uint8Array parses; non-Uint8Array (string, plain array,
//     ArrayBuffer) rejected. Node `Buffer` (subclass) accepted.
//   * PresenceReadRequestSchema + PresenceReadResponseSchema happy paths.
//   * UUID composability — branded UUID guards reject malformed strings on
//     every UUID-typed field.
//
// Coverage shape mirrors memberships.test.ts and invites.test.ts.
import { describe, expect, it } from "vitest";

import {
  ChannelIdSchema,
  DEVICE_ID_MAX_LEN,
  DEVICE_TYPE_MAX_LEN,
  JoinModeSchema,
  ParticipantIdSchema,
  PresenceHeartbeatSchema,
  PresenceReadRequestSchema,
  PresenceReadResponseSchema,
  PresenceStateSchema,
  PresenceUpdateSchema,
  SessionIdSchema,
  type JoinMode,
  type PresenceState,
} from "../presence.js";

// Real RFC 9562 UUIDs (mix of v4 and v7). z.uuid() validates the version
// nibble + variant bits in canonical positions; mismatch is rejected at the
// branded-id schema layer.
const PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440003";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const CHANNEL_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f02";
const SECOND_PARTICIPANT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f03";

const DEVICE_ID = "device-7c4a-9b1c-1b7c";
const DEVICE_TYPE = "desktop";
const LAST_ACTIVITY_AT = "2026-05-22T14:30:00.000Z";
const LAST_SEEN = "2026-05-22T14:29:45.000Z";

// Fixture returns a wire-shaped object without per-field brand casts —
// safeParse accepts plain UUID strings and brands them on the way out.
// The schema (not the type system) is the unit under test, so feeding raw
// wire data is the natural test surface. Mirrors the invites.test.ts pattern.
const buildHeartbeatPayload = () => ({
  participantId: PARTICIPANT_ID,
  deviceId: DEVICE_ID,
  activityState: "online" as PresenceState,
  metadata: {
    deviceType: DEVICE_TYPE,
    focusedSessionId: SESSION_ID,
    focusedChannelId: CHANNEL_ID,
    lastActivityAt: LAST_ACTIVITY_AT,
    appVisible: true,
  },
});

// =============================================================================
// Re-exports from session.ts — branded UUID guards
// =============================================================================
//
// Anti-cosmetic: a typo in the `export { ParticipantIdSchema, ... }` line
// would otherwise only surface as a downstream consumer typecheck failure
// at PR review time.

describe("ParticipantIdSchema / SessionIdSchema / ChannelIdSchema (re-exported from session.ts)", () => {
  it("ParticipantIdSchema parses a valid UUID", () => {
    expect(ParticipantIdSchema.parse(PARTICIPANT_ID)).toBe(PARTICIPANT_ID);
  });

  it("SessionIdSchema parses a valid UUID", () => {
    expect(SessionIdSchema.parse(SESSION_ID)).toBe(SESSION_ID);
  });

  it("ChannelIdSchema parses a valid UUID", () => {
    expect(ChannelIdSchema.parse(CHANNEL_ID)).toBe(CHANNEL_ID);
  });

  it.each([
    ["ParticipantIdSchema", ParticipantIdSchema],
    ["SessionIdSchema", SessionIdSchema],
    ["ChannelIdSchema", ChannelIdSchema],
  ])("%s rejects malformed UUID", (_label, schema) => {
    expect(schema.safeParse("not-a-uuid").success).toBe(false);
  });
});

// =============================================================================
// PresenceStateSchema — canonical lifecycle enum (api-payload-contracts.md:123)
// =============================================================================
//
// Spec-002 line 47 + api-payload-contracts.md:123 bind the wire form to
// EXACTLY four lowercase literals. Adding `"away"` / `"busy"` is a contract
// break requiring the spec edit FIRST per doc-first ordering.

describe("PresenceStateSchema (wire form is exactly {online, idle, reconnecting, offline})", () => {
  const EXPECTED_STATES = ["online", "idle", "reconnecting", "offline"] as const;

  it("enumerates exactly four canonical states (no more, no less)", () => {
    const schemaInternals = PresenceStateSchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toHaveLength(4);
    expect([...schemaInternals.options].sort()).toEqual([...EXPECTED_STATES].sort());
  });

  it.each(EXPECTED_STATES)("accepts canonical state: %s", (state) => {
    expect(PresenceStateSchema.safeParse(state).success).toBe(true);
  });

  it.each([
    ["away (contract break — not in canonical set)", "away"],
    ["busy (contract break — not in canonical set)", "busy"],
    ["unknown state", "focused"],
    ["empty string", ""],
    ["null", null],
    ["number", 1],
  ])("rejects non-canonical value: %s", (_label, value) => {
    expect(PresenceStateSchema.safeParse(value).success).toBe(false);
  });
});

// =============================================================================
// JoinModeSchema — canonical enum (api-payload-contracts.md:124 + :388)
// =============================================================================
//
// Spec-002 line 45 + api-payload-contracts.md:124 bind the wire form to
// EXACTLY three SPACED literals. Editing the space in "runtime contributor"
// to underscore or camelCase is a contract break.

describe("JoinModeSchema (canonical wire form is SPACED 'runtime contributor')", () => {
  const EXPECTED_MODES = ["viewer", "collaborator", "runtime contributor"] as const;

  it("enumerates exactly three canonical modes (no more, no less)", () => {
    const schemaInternals = JoinModeSchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toHaveLength(3);
    expect([...schemaInternals.options].sort()).toEqual([...EXPECTED_MODES].sort());
  });

  it.each(EXPECTED_MODES)("accepts canonical mode: %s", (mode) => {
    expect(JoinModeSchema.safeParse(mode).success).toBe(true);
  });

  it("accepts the SPACED 'runtime contributor' form (the space is load-bearing)", () => {
    const parsed = JoinModeSchema.parse("runtime contributor");
    expect(parsed).toBe("runtime contributor");
  });

  it("rejects snake_case 'runtime_contributor' (contract break — wire is SPACED)", () => {
    expect(JoinModeSchema.safeParse("runtime_contributor").success).toBe(false);
  });

  it("rejects camelCase 'runtimeContributor' (contract break — wire is SPACED)", () => {
    expect(JoinModeSchema.safeParse("runtimeContributor").success).toBe(false);
  });

  it("rejects 'owner' (owner is a MembershipRole, not a JoinMode)", () => {
    expect(JoinModeSchema.safeParse("owner").success).toBe(false);
  });

  it.each([
    ["unknown mode", "admin"],
    ["empty string", ""],
    ["null", null],
    ["number", 1],
  ])("rejects non-canonical value: %s", (_label, value) => {
    expect(JoinModeSchema.safeParse(value).success).toBe(false);
  });

  it("compile-time pin — JoinMode type matches the schema's runtime set", () => {
    // If JoinMode ever drifts from the schema, this assignment fails to
    // typecheck. The TYPE assertion is the load-bearing piece.
    const modes: JoinMode[] = ["viewer", "collaborator", "runtime contributor"];
    expect(modes).toHaveLength(3);
  });
});

// =============================================================================
// C4 — PresenceHeartbeatSchema (Spec-002 line 59 + line 84)
// =============================================================================
//
// Canonical wire form merges two governance sources:
//   * api-payload-contracts.md:422-426 — 3 outer fields
//     `{participantId, deviceId, activityState}`
//   * Spec-002 line 59 + line 84 — 5 REQUIRED metadata fields
//     `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`
//
// All 5 metadata keys MUST be present at parse time. `focusedSessionId` and
// `focusedChannelId` are nullable (the value may be `null` when the user is
// not focused on a session/channel) — the KEYS are always present per
// Spec-002:59 ("must include at minimum") and Spec-002:84 (canonical 5-field
// list). The no-focus case is serialized as `null` on the wire; an absent
// key is REJECTED. `undefined` is also rejected to pin against future drift
// to `.nullish()` (which would re-admit the absent-key shape the schema
// explicitly rejects — Spec-002:59 binds the FIELD SET, the floor, so the
// nullable-on-no-focus encoding is the spec-faithful interpretation).
//
// `deviceId` and `metadata.deviceType` compose `wireFreeFormString` (NUL-byte
// rejection / whitespace-only rejection) per the package wire-trust-boundary
// convention. Explicit NUL-byte regression tests live near the boundary
// checks below.

describe("PresenceHeartbeatSchema (C4: 5 metadata fields per Spec-002 line 84)", () => {
  // ----------------------------------------------------------------------
  // Happy paths
  // ----------------------------------------------------------------------

  it("accepts a fully-populated heartbeat (all 3 outer + all 5 metadata fields)", () => {
    const parsed = PresenceHeartbeatSchema.parse(buildHeartbeatPayload());
    expect(parsed.participantId).toBe(PARTICIPANT_ID);
    expect(parsed.deviceId).toBe(DEVICE_ID);
    expect(parsed.activityState).toBe("online");
    expect(parsed.metadata.deviceType).toBe(DEVICE_TYPE);
    expect(parsed.metadata.focusedSessionId).toBe(SESSION_ID);
    expect(parsed.metadata.focusedChannelId).toBe(CHANNEL_ID);
    expect(parsed.metadata.lastActivityAt).toBe(LAST_ACTIVITY_AT);
    expect(parsed.metadata.appVisible).toBe(true);
  });

  it.each(["online", "idle", "reconnecting", "offline"] as const)(
    "accepts every canonical activityState: %s",
    (state) => {
      const valid = buildHeartbeatPayload();
      const payload = { ...valid, activityState: state };
      expect(PresenceHeartbeatSchema.safeParse(payload).success).toBe(true);
    },
  );

  it("accepts a heartbeat with appVisible=false", () => {
    const valid = buildHeartbeatPayload();
    const payload = { ...valid, metadata: { ...valid.metadata, appVisible: false } };
    const parsed = PresenceHeartbeatSchema.parse(payload);
    expect(parsed.metadata.appVisible).toBe(false);
  });

  // ----------------------------------------------------------------------
  // Outer fields are all REQUIRED — api-payload-contracts.md:422-426.
  // ----------------------------------------------------------------------

  it.each(["participantId", "deviceId", "activityState"] as const)(
    "rejects heartbeat missing required outer field: %s",
    (field) => {
      const valid = buildHeartbeatPayload();
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      const result = PresenceHeartbeatSchema.safeParse(broken);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path.join("."));
        expect(paths).toContain(field);
      }
    },
  );

  // ----------------------------------------------------------------------
  // Metadata fields — ALL 5 keys REQUIRED at parse time per Spec-002:59,84.
  // focusedSessionId / focusedChannelId additionally accept explicit null
  // as their value (nullable shape); absent key and `undefined` value are
  // both REJECTED.
  // ----------------------------------------------------------------------

  it.each([
    "deviceType",
    "focusedSessionId",
    "focusedChannelId",
    "lastActivityAt",
    "appVisible",
  ] as const)(
    "rejects heartbeat with metadata field KEY ABSENT: %s (all 5 keys required per Spec-002:59,84)",
    (field) => {
      const valid = buildHeartbeatPayload();
      const brokenMetadata = { ...valid.metadata } as Record<string, unknown>;
      delete brokenMetadata[field];
      const broken = { ...valid, metadata: brokenMetadata };
      const result = PresenceHeartbeatSchema.safeParse(broken);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path.join("."));
        expect(paths).toContain(`metadata.${field}`);
      }
    },
  );

  it("accepts a heartbeat with focusedSessionId: null (no-focus case is serialized null, not absent)", () => {
    const valid = buildHeartbeatPayload();
    const payload = {
      ...valid,
      metadata: { ...valid.metadata, focusedSessionId: null },
    };
    const result = PresenceHeartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata.focusedSessionId).toBeNull();
    }
  });

  it("accepts a heartbeat with focusedChannelId: null (no-focus case is serialized null, not absent)", () => {
    const valid = buildHeartbeatPayload();
    const payload = {
      ...valid,
      metadata: { ...valid.metadata, focusedChannelId: null },
    };
    const result = PresenceHeartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata.focusedChannelId).toBeNull();
    }
  });

  it("accepts a heartbeat with BOTH focusedSessionId AND focusedChannelId set to null", () => {
    const valid = buildHeartbeatPayload();
    const payload = {
      ...valid,
      metadata: { ...valid.metadata, focusedSessionId: null, focusedChannelId: null },
    };
    const result = PresenceHeartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata.focusedSessionId).toBeNull();
      expect(result.data.metadata.focusedChannelId).toBeNull();
    }
  });

  it("rejects heartbeat with focusedSessionId: undefined (.nullable() admits null but NOT undefined)", () => {
    // Pin against future drift to `.nullish()` — that shape would re-admit
    // the absent-key case (zod treats `undefined` as "absent" semantically),
    // which the schema explicitly rejects per the Spec-002:59 field-set floor.
    const valid = buildHeartbeatPayload();
    const broken = {
      ...valid,
      metadata: { ...valid.metadata, focusedSessionId: undefined },
    };
    const result = PresenceHeartbeatSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects heartbeat with focusedChannelId: undefined (.nullable() admits null but NOT undefined)", () => {
    // Same drift-pin as the focusedSessionId case above.
    const valid = buildHeartbeatPayload();
    const broken = {
      ...valid,
      metadata: { ...valid.metadata, focusedChannelId: undefined },
    };
    const result = PresenceHeartbeatSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects heartbeat missing the metadata sub-object entirely", () => {
    const valid = buildHeartbeatPayload();
    const { metadata: _omitted, ...withoutMetadata } = valid;
    const result = PresenceHeartbeatSchema.safeParse(withoutMetadata);
    expect(result.success).toBe(false);
  });

  // ----------------------------------------------------------------------
  // Field-level type guards — ID composability, ISO datetime, boolean shape
  // ----------------------------------------------------------------------

  it("rejects heartbeat with malformed participantId (UUID guard composes)", () => {
    const valid = buildHeartbeatPayload();
    const broken = { ...valid, participantId: "not-a-uuid" };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects heartbeat with malformed non-null focusedSessionId (UUID guard composes on the value branch)", () => {
    const valid = buildHeartbeatPayload();
    const broken = {
      ...valid,
      metadata: { ...valid.metadata, focusedSessionId: "not-a-uuid" },
    };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects heartbeat with malformed non-null focusedChannelId (UUID guard composes on the value branch)", () => {
    const valid = buildHeartbeatPayload();
    const broken = {
      ...valid,
      metadata: { ...valid.metadata, focusedChannelId: "not-a-uuid" },
    };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects heartbeat with unknown activityState (composes from PresenceStateSchema)", () => {
    const valid = buildHeartbeatPayload();
    const broken = { ...valid, activityState: "away" };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects heartbeat with empty deviceId", () => {
    const valid = buildHeartbeatPayload();
    const broken = { ...valid, deviceId: "" };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects heartbeat with empty metadata.deviceType", () => {
    const valid = buildHeartbeatPayload();
    const broken = { ...valid, metadata: { ...valid.metadata, deviceType: "" } };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  // ----------------------------------------------------------------------
  // Length-cap boundaries — DEVICE_ID_MAX_LEN / DEVICE_TYPE_MAX_LEN
  // ----------------------------------------------------------------------
  //
  // Pin both the inclusive accept (= MAX_LEN) and the strict reject
  // (= MAX_LEN + 1) for each cap. Mirrors the convention in
  // invites.test.ts:217-222 and session-create.test.ts:207-216. Guards
  // against silent widening — a future PR that bumps either constant
  // without intent will fail these tests.

  it("accepts a heartbeat with deviceId at DEVICE_ID_MAX_LEN (boundary)", () => {
    const valid = buildHeartbeatPayload();
    const ok = { ...valid, deviceId: "x".repeat(DEVICE_ID_MAX_LEN) };
    expect(PresenceHeartbeatSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects a heartbeat with deviceId at DEVICE_ID_MAX_LEN + 1 (boundary)", () => {
    const valid = buildHeartbeatPayload();
    const broken = { ...valid, deviceId: "x".repeat(DEVICE_ID_MAX_LEN + 1) };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a heartbeat with metadata.deviceType at DEVICE_TYPE_MAX_LEN (boundary)", () => {
    const valid = buildHeartbeatPayload();
    const ok = {
      ...valid,
      metadata: { ...valid.metadata, deviceType: "x".repeat(DEVICE_TYPE_MAX_LEN) },
    };
    expect(PresenceHeartbeatSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects a heartbeat with metadata.deviceType at DEVICE_TYPE_MAX_LEN + 1 (boundary)", () => {
    const valid = buildHeartbeatPayload();
    const broken = {
      ...valid,
      metadata: { ...valid.metadata, deviceType: "x".repeat(DEVICE_TYPE_MAX_LEN + 1) },
    };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  // ----------------------------------------------------------------------
  // wireFreeFormString composition — NUL-byte log-injection guard
  // ----------------------------------------------------------------------
  //
  // `deviceId` and `metadata.deviceType` compose `wireFreeFormString` (see
  // session.ts:118), which rejects NUL bytes as an OpenTelemetry log-
  // injection guard. A buggy or hostile client emitting
  // `deviceId: "ios-\0-injection"` would otherwise corrupt structured log
  // lines / OTel traces (NUL terminates string serialization at the
  // observability layer). These tests pin the composition; removing the
  // helper would re-open the injection vector.

  it("rejects a heartbeat with NUL byte in deviceId (wireFreeFormString log-injection guard)", () => {
    const valid = buildHeartbeatPayload();
    const broken = { ...valid, deviceId: "ios-\0-injection" };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a heartbeat with NUL byte in metadata.deviceType (wireFreeFormString log-injection guard)", () => {
    const valid = buildHeartbeatPayload();
    const broken = {
      ...valid,
      metadata: { ...valid.metadata, deviceType: "desk\0top" },
    };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects heartbeat with non-ISO lastActivityAt", () => {
    const valid = buildHeartbeatPayload();
    const broken = { ...valid, metadata: { ...valid.metadata, lastActivityAt: "tomorrow" } };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts ISO lastActivityAt with numeric offset (RFC 3339 §5.6)", () => {
    const valid = buildHeartbeatPayload();
    const ok = {
      ...valid,
      metadata: { ...valid.metadata, lastActivityAt: "2026-05-22T08:30:00-04:00" },
    };
    expect(PresenceHeartbeatSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects heartbeat with non-boolean appVisible", () => {
    const valid = buildHeartbeatPayload();
    const broken = { ...valid, metadata: { ...valid.metadata, appVisible: "true" } };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  // ----------------------------------------------------------------------
  // .strict() anti-leakage — outer AND nested rejection of unknown keys.
  // ----------------------------------------------------------------------
  //
  // Both the outer object and the metadata sub-object MUST reject unknown
  // keys at parse time. Matches the convention used by every other request
  // schema in this package; pins the canonical surface against silent drift.

  it("rejects arbitrary unknown TOP-LEVEL key (.strict() outer guard)", () => {
    const broken = { ...buildHeartbeatPayload(), unexpected: "field" };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects arbitrary unknown METADATA key (.strict() nested guard)", () => {
    const valid = buildHeartbeatPayload();
    const broken = {
      ...valid,
      metadata: { ...valid.metadata, unexpectedMetadataField: "leaked" },
    };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  // ----------------------------------------------------------------------
  // Composability spot-check — UUID v7 + alternate participant
  // ----------------------------------------------------------------------

  it("accepts heartbeat with a UUID v7 participantId (daemon-emitted IDs are sortable v7)", () => {
    const valid = buildHeartbeatPayload();
    const payload = { ...valid, participantId: SECOND_PARTICIPANT_ID };
    const parsed = PresenceHeartbeatSchema.parse(payload);
    expect(parsed.participantId).toBe(SECOND_PARTICIPANT_ID);
  });
});

// =============================================================================
// PresenceUpdateSchema — JSON-RPC local IPC daemon → client push
// =============================================================================
//
// Exact wire shape (api-payload-contracts.md:429-433):
//   `{sessionId: SessionId, awarenessState: Uint8Array}`

describe("PresenceUpdateSchema (JSON-RPC local IPC, daemon → client push)", () => {
  it("accepts a well-formed update with sessionId + Uint8Array awarenessState", () => {
    const payload = {
      sessionId: SESSION_ID,
      awarenessState: new Uint8Array([1, 2, 3, 4, 5]),
    };
    const parsed = PresenceUpdateSchema.parse(payload);
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.awarenessState).toBeInstanceOf(Uint8Array);
    expect(parsed.awarenessState).toHaveLength(5);
  });

  it("accepts an empty Uint8Array (the Yjs encoder may emit zero-length frames)", () => {
    const payload = { sessionId: SESSION_ID, awarenessState: new Uint8Array(0) };
    expect(PresenceUpdateSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts a Node Buffer (Buffer extends Uint8Array — daemon producers emit Buffer)", () => {
    // Node's `Buffer` is a subclass of `Uint8Array`; `z.instanceof(Uint8Array)`
    // accepts Buffer instances. Forcing a copy at the wire layer would be
    // wasteful — daemon-side Yjs encoders frequently emit Buffer directly.
    const payload = {
      sessionId: SESSION_ID,
      awarenessState: Buffer.from([1, 2, 3]),
    };
    const result = PresenceUpdateSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects awarenessState as plain array (not a Uint8Array)", () => {
    const broken = { sessionId: SESSION_ID, awarenessState: [1, 2, 3] };
    expect(PresenceUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects awarenessState as string", () => {
    const broken = { sessionId: SESSION_ID, awarenessState: "binary-as-string" };
    expect(PresenceUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects awarenessState as bare ArrayBuffer (Uint8Array is the canonical view)", () => {
    const broken = { sessionId: SESSION_ID, awarenessState: new ArrayBuffer(8) };
    expect(PresenceUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects update missing sessionId", () => {
    const broken = { awarenessState: new Uint8Array([1]) };
    expect(PresenceUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects update missing awarenessState", () => {
    const broken = { sessionId: SESSION_ID };
    expect(PresenceUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects malformed sessionId (UUID guard composes)", () => {
    const broken = { sessionId: "not-a-uuid", awarenessState: new Uint8Array([1]) };
    expect(PresenceUpdateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    const broken = {
      sessionId: SESSION_ID,
      awarenessState: new Uint8Array([1]),
      unexpected: "field",
    };
    expect(PresenceUpdateSchema.safeParse(broken).success).toBe(false);
  });
});

// =============================================================================
// PresenceReadRequestSchema — JSON-RPC local IPC client → daemon query
// =============================================================================

describe("PresenceReadRequestSchema (JSON-RPC local IPC, client → daemon query)", () => {
  it("accepts a request with sessionId only", () => {
    const parsed = PresenceReadRequestSchema.parse({ sessionId: SESSION_ID });
    expect(parsed.sessionId).toBe(SESSION_ID);
  });

  it("rejects request missing sessionId", () => {
    expect(PresenceReadRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects request with malformed sessionId (UUID guard composes)", () => {
    expect(PresenceReadRequestSchema.safeParse({ sessionId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    const broken = { sessionId: SESSION_ID, unexpected: "field" };
    expect(PresenceReadRequestSchema.safeParse(broken).success).toBe(false);
  });
});

// =============================================================================
// PresenceReadResponseSchema — participant projection array
// =============================================================================
//
// Wire shape (api-payload-contracts.md:439-445):
//   `{participants: Array<{participantId, state: PresenceState, lastSeen: string}>}`

describe("PresenceReadResponseSchema (participant projection per api-payload-contracts.md:439-445)", () => {
  it("accepts a response with one participant", () => {
    const payload = {
      participants: [
        { participantId: PARTICIPANT_ID, state: "online" as PresenceState, lastSeen: LAST_SEEN },
      ],
    };
    const parsed = PresenceReadResponseSchema.parse(payload);
    expect(parsed.participants).toHaveLength(1);
    expect(parsed.participants[0]?.participantId).toBe(PARTICIPANT_ID);
    expect(parsed.participants[0]?.state).toBe("online");
    expect(parsed.participants[0]?.lastSeen).toBe(LAST_SEEN);
  });

  it("accepts an empty participants array (no one online)", () => {
    const parsed = PresenceReadResponseSchema.parse({ participants: [] });
    expect(parsed.participants).toEqual([]);
  });

  it("accepts a response with multiple participants in different states", () => {
    const payload = {
      participants: [
        { participantId: PARTICIPANT_ID, state: "online" as PresenceState, lastSeen: LAST_SEEN },
        {
          participantId: SECOND_PARTICIPANT_ID,
          state: "reconnecting" as PresenceState,
          lastSeen: LAST_SEEN,
        },
      ],
    };
    const parsed = PresenceReadResponseSchema.parse(payload);
    expect(parsed.participants).toHaveLength(2);
  });

  it("rejects participant missing participantId", () => {
    const broken = {
      participants: [{ state: "online", lastSeen: LAST_SEEN }],
    };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects participant missing state", () => {
    const broken = {
      participants: [{ participantId: PARTICIPANT_ID, lastSeen: LAST_SEEN }],
    };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects participant missing lastSeen", () => {
    const broken = {
      participants: [{ participantId: PARTICIPANT_ID, state: "online" }],
    };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects participant with malformed participantId (UUID guard composes)", () => {
    const broken = {
      participants: [{ participantId: "not-a-uuid", state: "online", lastSeen: LAST_SEEN }],
    };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects participant with unknown state (composes from PresenceStateSchema)", () => {
    const broken = {
      participants: [{ participantId: PARTICIPANT_ID, state: "away", lastSeen: LAST_SEEN }],
    };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects participant with non-ISO lastSeen", () => {
    const broken = {
      participants: [{ participantId: PARTICIPANT_ID, state: "online", lastSeen: "an hour ago" }],
    };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts lastSeen with numeric offset (RFC 3339 §5.6)", () => {
    const payload = {
      participants: [
        {
          participantId: PARTICIPANT_ID,
          state: "online" as PresenceState,
          lastSeen: "2026-05-22T08:29:45-04:00",
        },
      ],
    };
    expect(PresenceReadResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects response missing participants field", () => {
    expect(PresenceReadResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects extraneous keys at top level (.strict() guard)", () => {
    const broken = { participants: [], unexpected: "field" };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects extraneous keys within a participant element (.strict() guard)", () => {
    const broken = {
      participants: [
        {
          participantId: PARTICIPANT_ID,
          state: "online",
          lastSeen: LAST_SEEN,
          unexpected: "field",
        },
      ],
    };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });
});
