// Presence contract schema tests.
//
// Backstops the `PresenceHeartbeat` payload: 2 outer fields
// `{deviceId, activityState}` plus the 5 required metadata fields
// `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`.
//
// Test surface enumerated (the "what" each block pins):
//   * PresenceStateSchema wire-form pin — exactly the 4 canonical literals
//     `{online, idle, reconnecting, offline}`. `"away"` / `"busy"` rejected.
//   * PresenceHeartbeatSchema happy path — all 2 outer + 5 metadata fields
//     parse cleanly.
//   * PresenceHeartbeatSchema required-field guards — outer 2 each required
//     (deviceId, activityState); ALL 5 metadata fields each
//     required-key-at-parse (deviceType, focusedSessionId, focusedChannelId,
//     lastActivityAt, appVisible). focusedSessionId and focusedChannelId
//     additionally accept explicit `null` as their value (.nullable() shape);
//     `undefined` is rejected to pin against future drift to `.nullish()`.
//   * PresenceHeartbeatSchema .strict() anti-leakage — unknown top-level OR
//     unknown `metadata.*` key rejected.
//   * PresenceUpdateSchema happy path — `{sessionId, awarenessState}` with
//     real Uint8Array parses; non-Uint8Array (string, plain array,
//     ArrayBuffer) rejected. Node `Buffer` (subclass) accepted.
//   * PresenceReadRequestSchema + PresenceReadResponseSchema happy paths —
//     the read reply is the one user's DEVICE list, not a roster of people.
//   * UUID composability — branded UUID guards reject malformed strings on
//     every UUID-typed field.
//
// Coverage shape mirrors channels.test.ts.
import { describe, expect, it } from "vitest";

import {
  ChannelIdSchema,
  DEVICE_ID_MAX_LEN,
  DEVICE_TYPE_MAX_LEN,
  PresenceHeartbeatSchema,
  PresenceReadRequestSchema,
  PresenceReadResponseSchema,
  PresenceStateSchema,
  PresenceUpdateSchema,
  SessionIdSchema,
  type PresenceState,
} from "../presence.js";

// Real RFC 9562 UUIDs (mix of v4 and v7). `RFC_9562_TEXT_FORM` validates the version
// nibble + variant bits in canonical positions; mismatch is rejected at the
// branded-id schema layer.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const CHANNEL_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f02";

const DEVICE_ID = "device-7c4a-9b1c-1b7c";
const SECOND_DEVICE_ID = "device-9b1c-1b7c-7c4a";
const DEVICE_TYPE = "desktop";
const SECOND_DEVICE_TYPE = "mobile";
const LAST_ACTIVITY_AT = "2026-05-22T14:30:00.000Z";
const LAST_SEEN = "2026-05-22T14:29:45.000Z";

// Fixture returns a wire-shaped object without per-field brand casts —
// safeParse accepts plain UUID strings and brands them on the way out.
// The schema (not the type system) is the unit under test, so feeding raw
// wire data is the natural test surface.
const buildHeartbeatPayload = () => ({
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
// Anti-cosmetic: a typo in the `export { SessionIdSchema, ... }` line
// would otherwise only surface as a downstream consumer typecheck failure
// at PR review time.

describe("SessionIdSchema / ChannelIdSchema (re-exported from session.ts)", () => {
  it("SessionIdSchema parses a valid UUID", () => {
    expect(SessionIdSchema.parse(SESSION_ID)).toBe(SESSION_ID);
  });

  it("ChannelIdSchema parses a valid UUID", () => {
    expect(ChannelIdSchema.parse(CHANNEL_ID)).toBe(CHANNEL_ID);
  });

  it.each([
    ["SessionIdSchema", SessionIdSchema],
    ["ChannelIdSchema", ChannelIdSchema],
  ])("%s rejects malformed UUID", (_label, schema) => {
    expect(schema.safeParse("not-a-uuid").success).toBe(false);
  });
});

// =============================================================================
// PresenceStateSchema — canonical lifecycle enum
// =============================================================================
//
// The wire form is EXACTLY four lowercase literals. Adding `"away"` /
// `"busy"` is a contract break.

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
// PresenceHeartbeatSchema
// =============================================================================
//
// Canonical wire form:
//   * 2 outer fields `{deviceId, activityState}`
//   * 5 REQUIRED metadata fields
//     `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`
//
// All 5 metadata keys MUST be present at parse time. `focusedSessionId` and
// `focusedChannelId` are nullable (the value may be `null` when the user is
// not focused on a session/channel) — the KEYS are always present. The
// no-focus case is serialized as `null` on the wire; an absent key is
// REJECTED. `undefined` is also rejected to pin against future drift to
// `.nullish()`, which would re-admit the absent-key shape the schema
// explicitly rejects.
//
// `deviceId` and `metadata.deviceType` compose `wireFreeFormString` (NUL-byte
// rejection / whitespace-only rejection) per the package wire-trust-boundary
// convention. Explicit NUL-byte regression tests live near the boundary
// checks below.

describe("PresenceHeartbeatSchema (2 outer + 5 metadata fields)", () => {
  // ----------------------------------------------------------------------
  // Happy paths
  // ----------------------------------------------------------------------

  it("accepts a fully-populated heartbeat (both outer + all 5 metadata fields)", () => {
    const parsed = PresenceHeartbeatSchema.parse(buildHeartbeatPayload());
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
  // Outer fields are all REQUIRED.
  // ----------------------------------------------------------------------

  it.each(["deviceId", "activityState"] as const)(
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
  // Metadata fields — ALL 5 keys REQUIRED at parse time.
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
    "rejects heartbeat with metadata field KEY ABSENT: %s (all 5 keys required)",
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
    // which the schema explicitly rejects.
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

  it("rejects heartbeat carrying a userId (no user axis survives)", () => {
    const valid = buildHeartbeatPayload();
    const broken = { ...valid, userId: "660e8400-e29b-41d4-a716-446655440003" };
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
  // session-create.test.ts:207-216. Guards
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

  it("accepts ISO lastActivityAt with numeric offset (RFC 3339 section 5.6)", () => {
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
  // Composability spot-check — a second device of the same user
  // ----------------------------------------------------------------------

  it("accepts a heartbeat from a second device of the same user", () => {
    const valid = buildHeartbeatPayload();
    const payload = {
      ...valid,
      deviceId: SECOND_DEVICE_ID,
      metadata: { ...valid.metadata, deviceType: SECOND_DEVICE_TYPE },
    };
    const parsed = PresenceHeartbeatSchema.parse(payload);
    expect(parsed.deviceId).toBe(SECOND_DEVICE_ID);
    expect(parsed.metadata.deviceType).toBe(SECOND_DEVICE_TYPE);
  });
});

// =============================================================================
// PresenceUpdateSchema — JSON-RPC local IPC daemon → client push
// =============================================================================
//
// Exact wire shape:
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
// PresenceReadResponseSchema — device projection array
// =============================================================================
//
// Wire shape:
//   `{devices: Array<{deviceId, deviceType, appVisible, state, lastSeen}>}`
//
// Every element is one DEVICE of the one user — there is no user axis.

const buildDeviceEntry = () => ({
  deviceId: DEVICE_ID,
  deviceType: DEVICE_TYPE,
  appVisible: true,
  state: "online" as PresenceState,
  lastSeen: LAST_SEEN,
});

describe("PresenceReadResponseSchema (device projection)", () => {
  it("accepts a response with one device", () => {
    const parsed = PresenceReadResponseSchema.parse({ devices: [buildDeviceEntry()] });
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0]?.deviceId).toBe(DEVICE_ID);
    expect(parsed.devices[0]?.deviceType).toBe(DEVICE_TYPE);
    expect(parsed.devices[0]?.appVisible).toBe(true);
    expect(parsed.devices[0]?.state).toBe("online");
    expect(parsed.devices[0]?.lastSeen).toBe(LAST_SEEN);
  });

  it("accepts an empty devices array (no device online)", () => {
    const parsed = PresenceReadResponseSchema.parse({ devices: [] });
    expect(parsed.devices).toEqual([]);
  });

  it("accepts several devices of the same user in different states", () => {
    const payload = {
      devices: [
        buildDeviceEntry(),
        {
          deviceId: SECOND_DEVICE_ID,
          deviceType: SECOND_DEVICE_TYPE,
          appVisible: false,
          state: "reconnecting" as PresenceState,
          lastSeen: LAST_SEEN,
        },
      ],
    };
    const parsed = PresenceReadResponseSchema.parse(payload);
    expect(parsed.devices).toHaveLength(2);
  });

  it.each(["deviceId", "deviceType", "appVisible", "state", "lastSeen"] as const)(
    "rejects a device element missing required field: %s",
    (field) => {
      const broken = { ...buildDeviceEntry() } as Record<string, unknown>;
      delete broken[field];
      expect(PresenceReadResponseSchema.safeParse({ devices: [broken] }).success).toBe(false);
    },
  );

  it("rejects a device element with a whitespace-only deviceId (wireFreeFormString guard)", () => {
    const broken = { ...buildDeviceEntry(), deviceId: "   " };
    expect(PresenceReadResponseSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("rejects a device element with a NUL byte in deviceType (wireFreeFormString guard)", () => {
    const broken = { ...buildDeviceEntry(), deviceType: "desk\u0000top" };
    expect(PresenceReadResponseSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("rejects a device element with a non-boolean appVisible", () => {
    const broken = { ...buildDeviceEntry(), appVisible: "yes" };
    expect(PresenceReadResponseSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("rejects a device element with unknown state (composes from PresenceStateSchema)", () => {
    const broken = { ...buildDeviceEntry(), state: "away" };
    expect(PresenceReadResponseSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("rejects a device element with non-ISO lastSeen", () => {
    const broken = { ...buildDeviceEntry(), lastSeen: "an hour ago" };
    expect(PresenceReadResponseSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("accepts lastSeen with numeric offset (RFC 3339 section 5.6)", () => {
    const payload = {
      devices: [{ ...buildDeviceEntry(), lastSeen: "2026-05-22T08:29:45-04:00" }],
    };
    expect(PresenceReadResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects response missing the devices field", () => {
    expect(PresenceReadResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects extraneous keys at top level (.strict() guard)", () => {
    const broken = { devices: [], unexpected: "field" };
    expect(PresenceReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects extraneous keys within a device element (.strict() guard)", () => {
    const broken = { ...buildDeviceEntry(), userId: "leak" };
    expect(PresenceReadResponseSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });
});
