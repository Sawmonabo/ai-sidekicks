// Two legs of one binding, in two sessions, under one `bindingId`.
//
// Keying a leg by `bindingId` alone, while the live-leg identity is `(sessionId, bindingId)`,
// gives two sessions holding one configuration one React identity. The reading is React's own
// duplicate-key report.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  McpLiveApplicationResult,
  McpServerLegStatus,
} from "@ai-sidekicks/contracts/mcp/server";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { ManualClock } from "#renderer/lib/clock.js";
import { duplicateKeyReports, reportsWhileReactRan } from "#test/helpers/react-reports.js";
import { mcpLiveLegKeyOf } from "./live-leg-key.js";
import type { McpMutationOutcome } from "./mutation.js";
import { MutationOutcomeLine } from "./components/MutationOutcomeLine.js";
import { ServerLegs } from "./components/ServerLegs.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { liveBridgeWrapper, withAnnouncer } from "#test/helpers/app/frame-fixtures.js";

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

// Both failed, since only a session a change failed on gets a line of its own.
const LIVE_RESULTS_SHARING_A_HANDLE: readonly McpLiveApplicationResult[] = [
  { sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID, outcome: "failed" },
  { sessionId: SECOND_SESSION, bindingId: SHARED_BINDING_ID, outcome: "failed" },
];

const SETTLED_OUTCOME: McpMutationOutcome = {
  kind: "settled",
  binding: { provider: "claude", scope: "user", serverName: "filesystem" },
  settlement: { grades: ["user_config_write"], liveResults: LIVE_RESULTS_SHARING_A_HANDLE },
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
      render(
        <ServerLegs
          legs={LEGS_SHARING_A_HANDLE}
          sessionDirectory={{ status: "reading" }}
          nowMilliseconds={0}
        />,
        { wrapper: withAnnouncer(liveBridgeWrapper()) },
      ),
    );
    expect(duplicateKeyReports(reported)).toEqual([]);
  });

  it("gives each per-leg mutation outcome its own React identity", async () => {
    const { reported } = await reportsWhileReactRan(() =>
      render(
        <MutationOutcomeLine
          outcome={SETTLED_OUTCOME}
          sessionDirectory={{ status: "reading" }}
          clock={new ManualClock(0)}
        />,
        { wrapper: LiveAnnouncerProvider },
      ),
    );
    expect(duplicateKeyReports(reported)).toEqual([]);
  });
});
