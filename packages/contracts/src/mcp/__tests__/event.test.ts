// The session events on the `mcp.subscribe` stream are governance events only: a
// client validating a frame with `McpGovernanceEventSchema` is refused any other
// session event, so a daemon that filtered wrongly cannot hand it one.
import { describe, expect, it } from "vitest";

import { McpGovernanceEventSchema } from "../event.js";
import { buildSessionCreatedEvent } from "../../event/__tests__/session.test-support.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

const oauthCompleted = {
  id: "evt-mcp-1",
  sessionId: SESSION_ID,
  sequence: 9,
  occurredAt: "2026-09-29T19:30:00.000Z",
  category: "mcp_governance",
  type: "mcp.server_oauth_completed",
  actor: null,
  version: "1.0",
  payload: {
    provider: "claude",
    scope: "project",
    serverName: "docs",
    outcome: "success",
  },
};

describe("McpGovernanceEventSchema", () => {
  it("accepts a governance event", () => {
    expect(McpGovernanceEventSchema.safeParse(oauthCompleted).success).toBe(true);
  });

  it("refuses a session event of another category", () => {
    const parsed = McpGovernanceEventSchema.safeParse(buildSessionCreatedEvent());
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["type"]);
  });
});
