// MCP governance events several contracts tests parse.
import type { WireSessionEvent } from "../../event/__tests__/session.test-support.js";

/** A valid `mcp.server_oauth_completed` event: a project server's sign-in that succeeded. */
export function buildMcpServerOauthCompletedEvent(): WireSessionEvent {
  return {
    id: "evt-mcp-1",
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
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
}
