// Two legs of one binding, in two sessions, under one `bindingId`.
//
// Keying a leg by `bindingId` alone, while the live-leg identity is `(sessionId, bindingId)`,
// gives two sessions holding one configuration one React identity. The reading is React's own
// duplicate-key report.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  McpLiveApplicationResult,
  McpServerInventoryEntry,
  McpServerLegStatus,
} from "@ai-sidekicks/contracts/mcp";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import { duplicateKeyReports, reportsWhileReactRan } from "@test/helpers/react-reports.js";
import { mcpLiveLegKeyOf } from "./live-leg-key.js";
import type { McpMutationOutcome } from "./mcp-mutation.js";
import { MutationOutcomeLine } from "./components/MutationOutcomeLine.js";
import { ServerLegs } from "./components/ServerLegs.js";

afterEach(() => {
  cleanup();
});

const FIRST_SESSION = "019b7892-1a00-7c31-8110-cca0117a0500" as SessionId;
const SECOND_SESSION = "019b7892-1a00-7c31-8110-cca0117a0501" as SessionId;
/** One handle reported by both sessions, which the pair key has to survive. */
const SHARED_BINDING_ID = "leg-filesystem";

const LEGS_SHARING_A_HANDLE: readonly McpServerLegStatus[] = [
  { sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID, status: "connected" },
  { sessionId: SECOND_SESSION, bindingId: SHARED_BINDING_ID, status: "failed" },
];

const LIVE_RESULTS_SHARING_A_HANDLE: readonly McpLiveApplicationResult[] = [
  { sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID, outcome: "applied" },
  {
    sessionId: SECOND_SESSION,
    bindingId: SHARED_BINDING_ID,
    outcome: "failed",
    errorCode: "mcp.config_write_conflict",
  },
];

const SERVER_ROW: McpServerInventoryEntry = {
  provider: "claude",
  scope: "user",
  serverName: "filesystem",
  config: { transport: "stdio", command: "npx" },
  status: "connected",
  enabled: true,
  toolOverrides: [],
};

const SETTLED_OUTCOME: McpMutationOutcome = {
  kind: "settled",
  binding: { provider: "claude", scope: "user", serverName: "filesystem" },
  result: {
    server: SERVER_ROW,
    applied: "live_reconcile",
    liveResults: [...LIVE_RESULTS_SHARING_A_HANDLE],
  },
};

describe("mcpLiveLegKeyOf", () => {
  it("keys two sessions' legs of one binding apart, and one leg the same way twice", () => {
    expect(mcpLiveLegKeyOf(LEGS_SHARING_A_HANDLE[0] as McpServerLegStatus)).not.toBe(
      mcpLiveLegKeyOf(LEGS_SHARING_A_HANDLE[1] as McpServerLegStatus),
    );
    expect(mcpLiveLegKeyOf({ sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID })).toBe(
      mcpLiveLegKeyOf({ sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID }),
    );
  });
});

describe("the two lists that render a live leg", () => {
  it("gives each of one binding's legs its own React identity", async () => {
    const { reported } = await reportsWhileReactRan(() =>
      render(<ServerLegs legs={LEGS_SHARING_A_HANDLE} />),
    );
    expect(duplicateKeyReports(reported)).toEqual([]);
  });

  it("gives each per-leg mutation outcome its own React identity", async () => {
    const { reported } = await reportsWhileReactRan(() =>
      render(<MutationOutcomeLine outcome={SETTLED_OUTCOME} />),
    );
    expect(duplicateKeyReports(reported)).toEqual([]);
  });
});
