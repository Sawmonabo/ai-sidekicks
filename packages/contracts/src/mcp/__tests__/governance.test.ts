// The status notice reaches a client as an `mcp.subscribe` frame, never carries a folder path,
// and names the session and leg exactly when a session observed the change.
import { describe, expect, it } from "vitest";

import { McpSubscribeEmissionSchema } from "../event.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("status notice on mcp.subscribe", () => {
  const auditRef = { provider: "claude", scope: "project", serverName: "docs" } as const;
  const change = {
    ...auditRef,
    type: "mcp.server_status_changed",
    previousStatus: "starting",
    status: "failed",
  };
  const parses = (frame: object) => McpSubscribeEmissionSchema.safeParse(frame).success;

  it("names a project binding by provider, scope and name, never its folder", () => {
    expect(parses({ ...change, origin: "node_probe" })).toBe(true);
    expect(parses({ ...change, scopeRef: "/work/app", origin: "node_probe" })).toBe(false);
  });

  it("names the session and leg exactly when a session observed the change", () => {
    const fromSession = { ...change, origin: "session_feed" };
    expect(parses({ ...fromSession, sessionId: SESSION_ID, bindingId: "leg-1" })).toBe(true);
    expect(parses(fromSession)).toBe(false);
    expect(parses({ ...fromSession, bindingId: "leg-1" })).toBe(false);
    expect(parses({ ...fromSession, sessionId: SESSION_ID })).toBe(false);
    expect(parses({ ...change, origin: "node_probe", bindingId: "leg-1" })).toBe(false);
    expect(parses({ ...change, origin: "node_probe", sessionId: SESSION_ID })).toBe(false);
  });
});
