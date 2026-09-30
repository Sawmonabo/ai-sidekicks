// Presence contract schema tests.
//
// What each block holds:
//   * PresenceStateSchema — the four liveness states; anything else refused.
//   * PresenceHeartbeatSchema — the 2 outer and 4 metadata fields, each
//     required; `focusedSessionId` is `null`, never absent; unknown keys
//     refused at both levels; the device-id and device-type bounds.
//   * The two requests — empty; a request naming a session is refused.
//   * MachinePresenceSchema — the devices connected to this machine.

import { describe, expect, it } from "vitest";

import { DEVICE_ID_MAX_LEN } from "../trust-statement.js";
import {
  DEVICE_TYPE_MAX_LEN,
  MachinePresenceSchema,
  PresenceHeartbeatSchema,
  PresenceReadRequestSchema,
  PresenceStateSchema,
  PresenceSubscribeRequestSchema,
  type PresenceState,
} from "../presence.js";

// Real RFC 9562 UUIDs (mix of v4 and v7). `RFC_9562_TEXT_FORM` validates the version
// nibble + variant bits in canonical positions; mismatch is rejected at the
// branded-id schema layer.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

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
    lastActivityAt: LAST_ACTIVITY_AT,
    appVisible: true,
  },
});

// =============================================================================
// PresenceStateSchema — canonical lifecycle enum
// =============================================================================
//
// The wire form is EXACTLY four lowercase literals. Adding `"away"` /
// `"busy"` is a contract break.

describe("PresenceStateSchema (wire form is exactly {online, idle, reconnecting, offline})", () => {
  const EXPECTED_STATES = ["online", "idle", "reconnecting", "offline"] as const;

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
//   * 4 REQUIRED metadata fields
//     `{deviceType, focusedSessionId, lastActivityAt, appVisible}`
//
// All 4 metadata keys MUST be present at parse time. `focusedSessionId` is
// nullable (the value may be `null` when the user is not focused on a
// session) — the KEY is always present. The
// no-focus case is serialized as `null` on the wire; an absent key is
// REJECTED. `undefined` is also rejected to pin against future drift to
// `.nullish()`, which would re-admit the absent-key shape the schema
// explicitly rejects.
//
// `deviceId` and `metadata.deviceType` compose `wireFreeFormString` (NUL-byte
// rejection / whitespace-only rejection) per the package wire-trust-boundary
// convention. Explicit NUL-byte regression tests live near the boundary
// checks below.

describe("PresenceHeartbeatSchema (2 outer + 4 metadata fields)", () => {
  // ----------------------------------------------------------------------
  // Happy paths
  // ----------------------------------------------------------------------

  it("accepts a fully-populated heartbeat (both outer + all 4 metadata fields)", () => {
    const parsed = PresenceHeartbeatSchema.parse(buildHeartbeatPayload());
    expect(parsed.deviceId).toBe(DEVICE_ID);
    expect(parsed.activityState).toBe("online");
    expect(parsed.metadata.deviceType).toBe(DEVICE_TYPE);
    expect(parsed.metadata.focusedSessionId).toBe(SESSION_ID);
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
  // Metadata fields — ALL 4 keys REQUIRED at parse time.
  // focusedSessionId additionally accepts explicit null as its value
  // (nullable shape); absent key and `undefined` value are both REJECTED.
  // ----------------------------------------------------------------------

  it.each(["deviceType", "focusedSessionId", "lastActivityAt", "appVisible"] as const)(
    "rejects heartbeat with metadata field KEY ABSENT: %s (all 4 keys required)",
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
// Requests — presence is the machine's, so neither request names a session
// =============================================================================

describe.each([
  ["PresenceReadRequestSchema", PresenceReadRequestSchema],
  ["PresenceSubscribeRequestSchema", PresenceSubscribeRequestSchema],
] as const)("%s", (_name, schema) => {
  it("accepts the empty request", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("refuses a request that names a session", () => {
    expect(schema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
  });
});

// =============================================================================
// MachinePresenceSchema — the devices connected to this machine
// =============================================================================
//
// Wire shape:
//   `{devices: Array<{deviceId, deviceType, appVisible, state, lastSeen}>}`
//
// `presence.read` answers with it and `presence.subscribe` pushes it.

const buildDeviceEntry = () => ({
  deviceId: DEVICE_ID,
  deviceType: DEVICE_TYPE,
  appVisible: true,
  state: "online" as PresenceState,
  lastSeen: LAST_SEEN,
});

describe("MachinePresenceSchema (the devices connected to this machine)", () => {
  it("accepts a response with one device", () => {
    const parsed = MachinePresenceSchema.parse({ devices: [buildDeviceEntry()] });
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0]?.deviceId).toBe(DEVICE_ID);
    expect(parsed.devices[0]?.deviceType).toBe(DEVICE_TYPE);
    expect(parsed.devices[0]?.appVisible).toBe(true);
    expect(parsed.devices[0]?.state).toBe("online");
    expect(parsed.devices[0]?.lastSeen).toBe(LAST_SEEN);
  });

  it("accepts an empty devices array (no device connected)", () => {
    const parsed = MachinePresenceSchema.parse({ devices: [] });
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
    const parsed = MachinePresenceSchema.parse(payload);
    expect(parsed.devices).toHaveLength(2);
  });

  it.each(["deviceId", "deviceType", "appVisible", "state", "lastSeen"] as const)(
    "rejects a device element missing required field: %s",
    (field) => {
      const broken = { ...buildDeviceEntry() } as Record<string, unknown>;
      delete broken[field];
      expect(MachinePresenceSchema.safeParse({ devices: [broken] }).success).toBe(false);
    },
  );

  it("rejects a device element with a whitespace-only deviceId (wireFreeFormString guard)", () => {
    const broken = { ...buildDeviceEntry(), deviceId: "   " };
    expect(MachinePresenceSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("rejects a device element with a NUL byte in deviceType (wireFreeFormString guard)", () => {
    const broken = { ...buildDeviceEntry(), deviceType: "desk\u0000top" };
    expect(MachinePresenceSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("rejects a device element with a non-boolean appVisible", () => {
    const broken = { ...buildDeviceEntry(), appVisible: "yes" };
    expect(MachinePresenceSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("rejects a device element with unknown state (composes from PresenceStateSchema)", () => {
    const broken = { ...buildDeviceEntry(), state: "away" };
    expect(MachinePresenceSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("rejects a device element with non-ISO lastSeen", () => {
    const broken = { ...buildDeviceEntry(), lastSeen: "an hour ago" };
    expect(MachinePresenceSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });

  it("accepts lastSeen with numeric offset (RFC 3339 section 5.6)", () => {
    const payload = {
      devices: [{ ...buildDeviceEntry(), lastSeen: "2026-05-22T08:29:45-04:00" }],
    };
    expect(MachinePresenceSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects response missing the devices field", () => {
    expect(MachinePresenceSchema.safeParse({}).success).toBe(false);
  });

  it("rejects extraneous keys at top level (.strict() guard)", () => {
    const broken = { devices: [], unexpected: "field" };
    expect(MachinePresenceSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a device element that names a session (.strict() guard)", () => {
    const broken = { ...buildDeviceEntry(), sessionId: SESSION_ID };
    expect(MachinePresenceSchema.safeParse({ devices: [broken] }).success).toBe(false);
  });
});
