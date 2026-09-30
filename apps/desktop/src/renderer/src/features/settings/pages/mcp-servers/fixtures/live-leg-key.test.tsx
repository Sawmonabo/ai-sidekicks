// Two legs of one binding, in two sessions, under one `bindingId`.
//
// Keying a leg by `bindingId` alone, while the live-leg identity is `(sessionId, bindingId)`,
// gives two sessions holding one configuration one React identity. The reading is React's own
// report, proved non-vacuous by the last case, which renders a single-field keying and asserts
// the warning is raised.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  McpLiveApplicationResult,
  McpServerInventoryEntry,
  McpServerLegStatus,
  SessionId,
} from "@ai-sidekicks/contracts";
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
  effectiveInRuns: true,
  config: { transport: "stdio", command: "npx" },
  status: "connected",
  enabled: true,
  trusted: true,
  configHash: "b3:2f9c41d8ae07b5",
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
  it("keys two sessions' legs of one binding apart", () => {
    expect(mcpLiveLegKeyOf(LEGS_SHARING_A_HANDLE[0] as McpServerLegStatus)).not.toBe(
      mcpLiveLegKeyOf(LEGS_SHARING_A_HANDLE[1] as McpServerLegStatus),
    );
  });

  it("gives one leg the same key however the value reached it", () => {
    expect(mcpLiveLegKeyOf({ sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID })).toBe(
      mcpLiveLegKeyOf({ sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID }),
    );
  });

  // Negative control on the join: both members are wire strings, so a separator either may
  // contain is not one.
  it("keeps two pairs apart that a separator join would fold together", () => {
    expect(mcpLiveLegKeyOf({ sessionId: "session one", bindingId: "leg" })).not.toBe(
      mcpLiveLegKeyOf({ sessionId: "session", bindingId: "one leg" }),
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

  it("still renders both sessions beside their own statuses", () => {
    const { container } = render(<ServerLegs legs={LEGS_SHARING_A_HANDLE} />);
    const rows = [...container.querySelectorAll(".meridian-mcp__leg")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(FIRST_SESSION);
    expect(rows[0]).toContain("connected");
    expect(rows[1]).toContain(SECOND_SESSION);
    expect(rows[1]).toContain("failed");
  });

  // Negative control for the two clean results above: the single-field keying raises React's
  // report, so a clean reading means the keys are distinct.
  it("negative control: the single-field keying raises React's duplicate-key report", async () => {
    const { reported } = await reportsWhileReactRan(() =>
      render(
        <ul>
          {LEGS_SHARING_A_HANDLE.map((leg) => (
            <li key={leg.bindingId}>{leg.sessionId}</li>
          ))}
        </ul>,
      ),
    );
    expect(duplicateKeyReports(reported)).not.toEqual([]);
  });
});
