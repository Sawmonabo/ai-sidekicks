// Every MCP governance mutation carries a caller-minted idempotency key, so the
// daemon can replay a retried press from its receipt instead of applying it twice.
// A mutation request without a UUID key is refused before it reaches the daemon's
// store. The binding it addresses keeps the scope rules of the identity union.
import { describe, expect, it } from "vitest";

import { McpSetEnabledRequestSchema, McpSetTrustRequestSchema } from "../mcp.js";

const PROJECT_BINDING = {
  provider: "codex",
  scope: "project",
  scopeRef: "/work/app",
  serverName: "docs",
} as const;
const PRESS_ID = "11111111-1111-4111-8111-111111111111";

describe("MCP governance mutation requests", () => {
  it("refuses a mutation without an idempotency key", () => {
    expect(
      McpSetEnabledRequestSchema.safeParse({ ...PROJECT_BINDING, enabled: true }).success,
    ).toBe(false);
    expect(McpSetTrustRequestSchema.safeParse({ ...PROJECT_BINDING, trusted: true }).success).toBe(
      false,
    );
  });

  it("refuses a key that is not a UUID", () => {
    const request = { ...PROJECT_BINDING, clientIdempotencyKey: "press-1", enabled: true };
    expect(McpSetEnabledRequestSchema.safeParse(request).success).toBe(false);
  });

  it("refuses a local-scope binding for codex, a scope that does not exist there", () => {
    const request = {
      ...PROJECT_BINDING,
      scope: "local",
      clientIdempotencyKey: PRESS_ID,
      trusted: true,
    };
    expect(McpSetTrustRequestSchema.safeParse(request).success).toBe(false);
  });

  it("accepts a keyed mutation on a well-formed binding", () => {
    const enable = { ...PROJECT_BINDING, clientIdempotencyKey: PRESS_ID, enabled: false };
    const trust = { ...PROJECT_BINDING, clientIdempotencyKey: PRESS_ID, trusted: true };
    expect(McpSetEnabledRequestSchema.safeParse(enable).success).toBe(true);
    expect(McpSetTrustRequestSchema.safeParse(trust).success).toBe(true);
  });
});
