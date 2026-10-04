// The status notice never carries a folder path, and names the live leg exactly when a session
// observed the change.
import { describe, expect, it } from "vitest";

import { McpServerStatusChangedPayloadSchema } from "../mcp-governance.js";

describe("status notice payload", () => {
  const auditRef = { provider: "claude", scope: "project", serverName: "docs" } as const;
  const change = { ...auditRef, previousStatus: "starting", status: "failed" };

  it("names a project binding by provider, scope and name, never its folder", () => {
    expect(
      McpServerStatusChangedPayloadSchema.safeParse({ ...change, origin: "node_probe" }).success,
    ).toBe(true);
    expect(
      McpServerStatusChangedPayloadSchema.safeParse({
        ...change,
        scopeRef: "/work/app",
        origin: "node_probe",
      }).success,
    ).toBe(false);
  });

  it("names the leg exactly when a session observed the change", () => {
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
});
