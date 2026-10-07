// The session events on the `mcp.subscribe` stream are governance events only: a
// client validating a frame with `McpGovernanceEventSchema` is refused any other
// session event, so a daemon that filtered wrongly cannot hand it one.
import { describe, expect, it } from "vitest";

import { McpGovernanceEventSchema } from "../event.js";
import { buildSessionCreatedEvent } from "../../event/__tests__/session.test-support.js";
import { buildMcpServerOauthCompletedEvent } from "./event.test-support.js";

describe("McpGovernanceEventSchema", () => {
  it("accepts a governance event", () => {
    expect(McpGovernanceEventSchema.safeParse(buildMcpServerOauthCompletedEvent()).success).toBe(
      true,
    );
  });

  it("refuses a session event of another category", () => {
    const parsed = McpGovernanceEventSchema.safeParse(buildSessionCreatedEvent());
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["type"]);
  });
});
