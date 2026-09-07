// Two legs of one binding, in two sessions, under one `bindingId`.
//
// THE DEFECT THIS PINS. Both lists that render a leg keyed it by `bindingId` alone,
// while the registered live-leg identity is `(sessionId, bindingId)`. Two sessions
// holding one configuration open can report the same handle, so the two rows shared a
// React identity — and React reuses the wrong row when a leg is added, removed, or
// reordered, putting one session's status beside the other session's id.
//
// THE READING IS REACT'S OWN REPORT, and it is proved non-vacuous rather than trusted:
// the last case renders the same data through a list keyed the old way and asserts the
// warning IS raised, so a clean result above means the keys are distinct and not that
// nothing was ever watching.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GrowthMcpInventoryEntry,
  GrowthMcpLiveApplicationResult,
  GrowthMcpServerLegStatus,
} from "../../../../bridge/index.js";
import { mcpLiveLegKeyOf } from "./live-leg-key.js";
import type { McpMutationOutcome } from "./mcp-mutation.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import { ServerLegs } from "./ServerLegs.js";

afterEach(() => {
  cleanup();
});

const FIRST_SESSION = "019b7892-1a00-7c31-8110-cca0117a0500";
const SECOND_SESSION = "019b7892-1a00-7c31-8110-cca0117a0501";
/** One handle, reported by both sessions — which is what the pair key has to survive. */
const SHARED_BINDING_ID = "leg-filesystem";

const LEGS_SHARING_A_HANDLE: readonly GrowthMcpServerLegStatus[] = [
  { sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID, status: "connected" },
  { sessionId: SECOND_SESSION, bindingId: SHARED_BINDING_ID, status: "failed" },
];

const LIVE_RESULTS_SHARING_A_HANDLE: readonly GrowthMcpLiveApplicationResult[] = [
  { sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID, outcome: "applied" },
  {
    sessionId: SECOND_SESSION,
    bindingId: SHARED_BINDING_ID,
    outcome: "failed",
    errorCode: "mcp.config_write_conflict",
  },
];

const SERVER_ROW: GrowthMcpInventoryEntry = {
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
    liveResults: LIVE_RESULTS_SHARING_A_HANDLE,
  },
};

/**
 * Render, capturing what React reported while it was reconciling.
 *
 * React raises the duplicate-key report through `console.error`, so the spy is the
 * reading and the restore is unconditional — a spy left installed by a failing case
 * would silence every later file in the worker.
 */
function renderReportingReactWarnings(element: React.JSX.Element): readonly string[] {
  const reported: string[] = [];
  const consoleErrors = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: readonly unknown[]) => {
      reported.push(parts.map((part) => String(part)).join(" "));
    });
  try {
    render(element);
  } finally {
    consoleErrors.mockRestore();
  }
  return reported;
}

/** Whatever React said about two children sharing one key, if it said anything. */
function duplicateKeyReports(reported: readonly string[]): readonly string[] {
  return reported.filter((line) => /same key/iu.test(line));
}

describe("mcpLiveLegKeyOf", () => {
  it("keys two sessions' legs of one binding apart", () => {
    expect(mcpLiveLegKeyOf(LEGS_SHARING_A_HANDLE[0] as GrowthMcpServerLegStatus)).not.toBe(
      mcpLiveLegKeyOf(LEGS_SHARING_A_HANDLE[1] as GrowthMcpServerLegStatus),
    );
  });

  it("gives one leg the same key however the value reached it", () => {
    expect(mcpLiveLegKeyOf({ sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID })).toBe(
      mcpLiveLegKeyOf({ sessionId: FIRST_SESSION, bindingId: SHARED_BINDING_ID }),
    );
  });

  // The negative control on the JOIN, not on the pair: both members are wire strings
  // this console does not author, so a separator either may contain is not one.
  it("keeps two pairs apart that a separator join would fold together", () => {
    expect(mcpLiveLegKeyOf({ sessionId: "session one", bindingId: "leg" })).not.toBe(
      mcpLiveLegKeyOf({ sessionId: "session", bindingId: "one leg" }),
    );
  });
});

describe("the two lists that render a live leg", () => {
  it("gives each of one binding's legs its own React identity", () => {
    const reported = renderReportingReactWarnings(<ServerLegs legs={LEGS_SHARING_A_HANDLE} />);
    expect(duplicateKeyReports(reported)).toEqual([]);
  });

  it("gives each per-leg mutation outcome its own React identity", () => {
    const reported = renderReportingReactWarnings(
      <MutationOutcomeLine outcome={SETTLED_OUTCOME} />,
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

  // The negative control for the two clean results above: the same data through the
  // single-field keying DOES raise React's report, so a clean reading means the keys
  // are distinct rather than that nothing was watching.
  it("negative control: the single-field keying raises React's duplicate-key report", () => {
    const reported = renderReportingReactWarnings(
      <ul>
        {LEGS_SHARING_A_HANDLE.map((leg) => (
          <li key={leg.bindingId}>{leg.sessionId}</li>
        ))}
      </ul>,
    );
    expect(duplicateKeyReports(reported)).not.toEqual([]);
  });
});
