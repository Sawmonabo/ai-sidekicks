// The governance events the log keeps. A kept event names the live leg exactly when a
// session observed the change, and gives a removal the hash it had and no new one.
import { describe, expect, it } from "vitest";

import {
  McpServerConfigChangedPayloadSchema,
  McpServerStatusChangedPayloadSchema,
} from "../mcp-governance.js";

const DIGEST = "b3:9f2c";

describe("governance event payloads", () => {
  const auditRef = {
    provider: "claude",
    scope: "project",
    scopeRefDigest: DIGEST,
    serverName: "docs",
  } as const;

  it("names the leg exactly when a session observed the change", () => {
    const change = { ...auditRef, previousStatus: "starting", status: "failed" };
    expect(
      McpServerStatusChangedPayloadSchema.safeParse({
        ...change,
        origin: "session_feed",
        bindingId: "leg-1",
      }).success,
    ).toBe(true);
    expect(
      McpServerStatusChangedPayloadSchema.safeParse({ ...change, origin: "session_feed" }).success,
    ).toBe(false);
    expect(
      McpServerStatusChangedPayloadSchema.safeParse({
        ...change,
        origin: "node_probe",
        bindingId: "leg-1",
      }).success,
    ).toBe(false);
  });

  it("gives a removal its previous hash and no new one", () => {
    const removal = { ...auditRef, changeKind: "removed", appliedVia: "user_config_write" };
    expect(
      McpServerConfigChangedPayloadSchema.safeParse({ ...removal, previousConfigHash: DIGEST })
        .success,
    ).toBe(true);
    expect(
      McpServerConfigChangedPayloadSchema.safeParse({
        ...removal,
        previousConfigHash: DIGEST,
        configHash: DIGEST,
      }).success,
    ).toBe(false);
    expect(McpServerConfigChangedPayloadSchema.safeParse(removal).success).toBe(false);
  });
});
