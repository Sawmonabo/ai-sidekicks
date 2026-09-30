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

// A real RFC 9562 UUID; the branded-id schema checks the version nibble and variant bits.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

const DEVICE_ID = "device-7c4a-9b1c-1b7c";
const SECOND_DEVICE_ID = "device-9b1c-1b7c-7c4a";
const DEVICE_TYPE = "desktop";
const SECOND_DEVICE_TYPE = "mobile";
const LAST_ACTIVITY_AT = "2026-05-22T14:30:00.000Z";

// Raw wire data with no brand casts: the schema, not the type system, is under test.
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

// The wire form is exactly four lowercase literals; adding `"away"` or `"busy"` breaks it.

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

// A heartbeat has outer `{deviceId, activityState}` and four required metadata keys
// `{deviceType, focusedSessionId, lastActivityAt, appVisible}`. `focusedSessionId` is `null`
// when no session is focused; an absent key or `undefined` is refused. `deviceId` and
// `metadata.deviceType` compose `wireFreeFormString`.

describe("PresenceHeartbeatSchema (2 outer + 4 metadata fields)", () => {
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
    // `.nullish()` would re-admit the absent-key case, since zod treats `undefined` as absent.
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

  // Each cap accepts exactly MAX_LEN and rejects MAX_LEN + 1, so a silent widening fails.

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

  // `wireFreeFormString` rejects NUL bytes, which would otherwise corrupt structured log lines
  // and traces from a buggy or hostile client (`deviceId: "ios-\0-injection"`).

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

  // Both the outer object and the metadata sub-object refuse unknown keys.

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

// Presence is the machine's, so neither request names a session.

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

// `presence.read` answers with `{devices: Array<{deviceId, deviceType, appVisible, state}>}`
// and `presence.subscribe` pushes it.

const buildDeviceEntry = () => ({
  deviceId: DEVICE_ID,
  deviceType: DEVICE_TYPE,
  appVisible: true,
  state: "online" as PresenceState,
});

describe("MachinePresenceSchema (the devices connected to this machine)", () => {
  it("accepts a response with one device", () => {
    const parsed = MachinePresenceSchema.parse({ devices: [buildDeviceEntry()] });
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0]?.deviceId).toBe(DEVICE_ID);
    expect(parsed.devices[0]?.deviceType).toBe(DEVICE_TYPE);
    expect(parsed.devices[0]?.appVisible).toBe(true);
    expect(parsed.devices[0]?.state).toBe("online");
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
        },
      ],
    };
    const parsed = MachinePresenceSchema.parse(payload);
    expect(parsed.devices).toHaveLength(2);
  });

  it.each(["deviceId", "deviceType", "appVisible", "state"] as const)(
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
