// The `mcp.subscribe` stream carries governance events and nothing else: a
// client validating a frame with `McpGovernanceEventSchema` is refused any other
// session event, so a daemon that filtered wrongly cannot hand it one.
import { describe, expect, it } from "vitest";

import { McpGovernanceEventSchema } from "../mcp-event.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";

const statusChanged = {
  id: "evt-mcp-1",
  sessionId: SESSION_ID,
  sequence: 9,
  occurredAt: "2026-09-29T19:30:00.000Z",
  category: "mcp_governance",
  type: "mcp.server_status_changed",
  actor: null,
  version: "1.0",
  payload: {
    provider: "claude",
    scope: "project",
    scopeRefDigest: "b3:9f2c",
    serverName: "docs",
    previousStatus: "starting",
    status: "failed",
    origin: "session_feed",
    bindingId: "leg-1",
  },
};

const sessionCreated = {
  id: "evt-0001",
  sessionId: SESSION_ID,
  sequence: 0,
  occurredAt: "2026-01-22T19:14:35.000Z",
  category: "session_lifecycle",
  type: "session.created",
  actor: USER_ID,
  version: "1.0",
  payload: {
    sessionId: SESSION_ID,
    config: { resourceLimits: { sessions: 10 } },
    metadata: { source: "cli" },
  },
};

describe("McpGovernanceEventSchema", () => {
  it("accepts a governance event", () => {
    expect(McpGovernanceEventSchema.safeParse(statusChanged).success).toBe(true);
  });

  it("refuses a session event of another category", () => {
    const parsed = McpGovernanceEventSchema.safeParse(sessionCreated);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["type"]);
  });
});
