// Package-boundary guards on `@ai-sidekicks/contracts`: the invite and membership-update wire
// shapes stay gone (one user owns a session), the presence contracts stay re-exported from the
// index, and their object schemas stay `.strict()`.
//
// Imports come from `../index.js`, not per-module paths, so the index re-export layer is what
// gets exercised. They do not use the package path either: it resolves to `dist/`, which a
// clean checkout has not built when `vitest run` starts.
import { describe, expect, it } from "vitest";

import {
  MachinePresenceSchema,
  PresenceHeartbeatSchema,
  PresenceReadRequestSchema,
  type PresenceState,
} from "../index.js";
import * as contracts from "../index.js";

// Fixtures mirror presence.test.ts.

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const LAST_ACTIVITY_AT = "2026-05-22T14:30:00.000Z";
const DEVICE_ID = "device-7c4a-9b1c-1b7c";
const DEVICE_TYPE = "desktop";

const buildValidPresenceHeartbeat = () => ({
  deviceId: DEVICE_ID,
  activityState: "online" as PresenceState,
  metadata: {
    deviceType: DEVICE_TYPE,
    focusedSessionId: SESSION_ID,
    lastActivityAt: LAST_ACTIVITY_AT,
    appVisible: true,
  },
});

const buildValidPresenceReadRequest = () => ({});

const buildValidMachinePresence = () => ({
  devices: [
    {
      deviceId: DEVICE_ID,
      deviceType: DEVICE_TYPE,
      appVisible: true,
      state: "online" as PresenceState,
    },
  ],
});

// The invite and membership-update wire surfaces are gone: one user owns a session. The
// symbol names below are literals this guard asserts against, so the deleted vocabulary
// survives only here.

describe("anti-leakage — no invite or membership-update contracts in @ai-sidekicks/contracts", () => {
  const FORBIDDEN_MULTI_USER_SYMBOLS = [
    "InviteId",
    "InviteIdSchema",
    "InviteState",
    "InviteStateSchema",
    "InviteCreate",
    "InviteCreateSchema",
    "InviteCreateResponse",
    "InviteCreateResponseSchema",
    "InviteAccept",
    "InviteAcceptSchema",
    "InviteAcceptResponse",
    "InviteAcceptResponseSchema",
    "InviteRevoke",
    "InviteRevokeSchema",
    "InviteRevokeResponse",
    "InviteRevokeResponseSchema",
    "INVITE_TOKEN_MAX_LEN",
    "INVITE_REVOKE_REASON_MAX_LEN",
    "MembershipUpdate",
    "MembershipUpdateSchema",
    "MembershipUpdateResponse",
    "MembershipUpdateResponseSchema",
  ] as const;

  it.each(FORBIDDEN_MULTI_USER_SYMBOLS)("does not export deleted symbol: %s", (symbol) => {
    expect((contracts as Record<string, unknown>)[symbol]).toBeUndefined();
  });
});

// A dropped re-export or `export *` in `src/index.ts` fails here. Type-only exports are covered
// through their paired schemas.

describe("export inventory — required schemas re-exported from @ai-sidekicks/contracts", () => {
  // Each entry pairs the package-public symbol name with its reference, so a failure names the
  // missing re-export.
  const REQUIRED_SCHEMAS = [
    ["PresenceHeartbeatSchema", contracts.PresenceHeartbeatSchema],
    ["PresenceReadRequestSchema", contracts.PresenceReadRequestSchema],
    ["MachinePresenceSchema", contracts.MachinePresenceSchema],
    ["PresenceStateSchema", contracts.PresenceStateSchema],
  ] as const;

  it.each(REQUIRED_SCHEMAS)(
    "re-exports schema: %s (with a callable .parse function)",
    (_name, schema) => {
      // Defined, and a callable `.parse` (not a non-Zod value bound to the name); the optional
      // chain lets the first failure message surface.
      expect(schema).toBeDefined();
      expect(typeof (schema as { parse?: unknown })?.parse).toBe("function");
    },
  );

  it("re-exports all schemas as a runtime-callable surface", () => {
    // Parsing minimal valid fixtures proves the re-export chain works end to end.
    expect(PresenceHeartbeatSchema.safeParse(buildValidPresenceHeartbeat()).success).toBe(true);
    expect(PresenceReadRequestSchema.safeParse(buildValidPresenceReadRequest()).success).toBe(true);
    expect(MachinePresenceSchema.safeParse(buildValidMachinePresence()).success).toBe(true);
  });
});

// A schema that loses `.strict()` fails here even if its per-module test was relaxed to match.

describe("anti-leakage — cross-contract .strict() posture", () => {
  it("PresenceHeartbeatSchema rejects extraneous TOP-LEVEL keys (.strict() outer guard)", () => {
    const broken = { ...buildValidPresenceHeartbeat(), extra: "leak" };
    expect(PresenceHeartbeatSchema.safeParse(broken).success).toBe(false);
  });

  it("PresenceReadRequestSchema rejects extraneous keys (.strict() guard)", () => {
    const broken = { ...buildValidPresenceReadRequest(), extra: "leak" };
    expect(PresenceReadRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("MachinePresenceSchema rejects extraneous TOP-LEVEL keys (.strict() outer guard)", () => {
    const broken = { ...buildValidMachinePresence(), extra: "leak" };
    expect(MachinePresenceSchema.safeParse(broken).success).toBe(false);
  });
});
