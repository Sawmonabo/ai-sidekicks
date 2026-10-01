// The MCP fixture body, driven with the daemon verbs handed in as arguments. The three rows are
// the arms the page must draw: a connected binding, one needing authorization while a leg is
// fine, and one whose binding store could not be read. Every status and outcome is drawn as the
// daemon reported it.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import type {
  McpMutationResult,
  McpServerInventoryEntry,
  SessionId,
} from "@ai-sidekicks/contracts";
import type { Clock } from "@renderer/lib/clock.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { McpFixtureBody, type McpServerOperations } from "./McpFixtureBody.js";

afterEach(() => {
  cleanup();
});

const SESSION_A = "11111111-1111-4111-8111-111111111111" as SessionId;
const SESSION_B = "22222222-2222-4222-8222-222222222222" as SessionId;

const FILESYSTEM: McpServerInventoryEntry = {
  provider: "claude",
  scope: "user",
  serverName: "filesystem",
  config: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    envVarNames: ["FS_ROOT"],
  },
  status: "connected",
  enabled: true,
  toolOverrides: [],
};

const ISSUE_TRACKER: McpServerInventoryEntry = {
  provider: "codex",
  scope: "project",
  scopeRef: "/work/repo",
  serverName: "issue-tracker",
  config: {
    transport: "http",
    url: "https://issues.example.test/mcp",
    headerNames: ["X-Workspace"],
    bearerTokenEnvVar: "ISSUES_TOKEN",
  },
  status: "needs-auth",
  legs: [
    { sessionId: SESSION_A, bindingId: "leg-a", status: "needs-auth" },
    { sessionId: SESSION_B, bindingId: "leg-b", status: "connected" },
  ],
  enabled: true,
  toolOverrides: [],
};

const SCRATCHPAD: McpServerInventoryEntry = {
  provider: "claude",
  scope: "local",
  scopeRef: "/work/repo",
  serverName: "scratchpad",
  config: { transport: "stdio", command: "./scripts/scratchpad-mcp" },
  status: "unknown",
  trustUnavailable: true,
};

const PARTIAL_APPLICATION: McpMutationResult = {
  server: { ...FILESYSTEM, enabled: false },
  applied: "live_reconcile",
  liveResults: [
    { sessionId: SESSION_A, bindingId: "leg-a", outcome: "applied" },
    {
      sessionId: SESSION_B,
      bindingId: "leg-b",
      outcome: "failed",
      errorCode: "mcp.config_write_conflict",
    },
  ],
};

function operationsServing(
  servers: readonly McpServerInventoryEntry[],
  overrides: Partial<McpServerOperations> = {},
): McpServerOperations {
  return {
    listInventory: async () => await Promise.resolve({ servers }),
    subscribeInventoryChanges: () => () => undefined,
    sendEnabled: async () => await Promise.resolve(PARTIAL_APPLICATION),
    ...overrides,
  };
}

function fixtureBridge(): FixtureBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("mcp-fixture-body") });
}

/** The fixture body as a composition mounts it: the bridge comes from the provider's resolution. */
function MountedMcpPage(props: {
  readonly operations: McpServerOperations;
  readonly mintKey?: () => string;
}): React.JSX.Element {
  const bridge = usePlatformBridge();
  return props.mintKey === undefined ? (
    <McpFixtureBody bridge={bridge} operations={props.operations} />
  ) : (
    <McpFixtureBody bridge={bridge} operations={props.operations} mintKey={props.mintKey} />
  );
}

/**
 * The tree as an element, so a case can re-render the same mount at a different bridge the way
 * `PlatformBridgeProvider` does on a reconnect.
 */
function mcpPageTree(
  fixture: FixtureBridge,
  operations: McpServerOperations,
  mintKey?: () => string,
): React.JSX.Element {
  return (
    <FixtureBridgeProvider fixture={fixture}>
      <LiveAnnouncerProvider>
        {mintKey === undefined ? (
          <MountedMcpPage operations={operations} />
        ) : (
          <MountedMcpPage operations={operations} mintKey={mintKey} />
        )}
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>
  );
}

/**
 * The first row's enablement control, the press every mutation case makes. Throws so a case that
 * never reached a settled inventory fails at the press.
 */
function firstEnableButton(container: HTMLElement): HTMLButtonElement {
  const [button] = [...container.querySelectorAll("button")].filter((candidate) =>
    /this binding$/u.test(candidate.textContent ?? ""),
  );
  if (button === undefined) {
    throw new Error("the settled inventory rendered no enablement control to press");
  }
  return button;
}

async function renderSettledMcpPage(
  operations: McpServerOperations,
  mintKey?: () => string,
): Promise<{ readonly container: HTMLElement; readonly clock: Clock }> {
  const fixture = fixtureBridge();
  const { clock } = fixture.scenarioEngine;
  const { container } = render(mcpPageTree(fixture, operations, mintKey));
  await settleScheduledRead(clock);
  return { container, clock };
}

function rowNamed(container: HTMLElement, serverName: string): Element | undefined {
  return [...container.querySelectorAll(".meridian-mcp__row")].find((row) =>
    (row.textContent ?? "").includes(serverName),
  );
}

describe("McpFixtureBody", () => {
  it("renders the daemon's aggregate status rather than folding the legs itself", async () => {
    const { container } = await renderSettledMcpPage(operationsServing([ISSUE_TRACKER]));
    // The two legs disagree and the row's chip carries the daemon's aggregate; folding the legs
    // by eye would have to pick one.
    const row = rowNamed(container, "issue-tracker");
    const chipLabels = (selector: string): readonly (string | null)[] =>
      [...(row?.querySelectorAll(`${selector} .meridian-chip__label`) ?? [])].map(
        (label) => label.textContent,
      );
    expect(chipLabels(".meridian-mcp__row-identity")).toStrictEqual([
      "codex",
      "project",
      "needs-auth",
    ]);
    expect(chipLabels(".meridian-mcp__legs")).toStrictEqual(["needs-auth", "connected"]);
  });

  it("names no invented status on the degraded row", async () => {
    const { container } = await renderSettledMcpPage(operationsServing([SCRATCHPAD]));
    const degradedRow = rowNamed(container, "scratchpad");
    expect(degradedRow?.textContent).toContain("could not be read");
    expect(degradedRow?.textContent).not.toContain("No tool on this binding carries an override");
  });

  it("renders a partial application: one leg applied, one failed", async () => {
    const { container, clock } = await renderSettledMcpPage(operationsServing([FILESYSTEM]));
    fireEvent.click(firstEnableButton(container));
    await settleScheduledRead(clock);
    expect(container.textContent).toContain("live_reconcile");
    expect(container.textContent).toContain("mcp.config_write_conflict");
  });

  it("sends the key the caller minted for that press", async () => {
    const sendEnabled = vi.fn(async () => await Promise.resolve(PARTIAL_APPLICATION));
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([FILESYSTEM], { sendEnabled }),
      () => "one-press",
    );
    fireEvent.click(firstEnableButton(container));
    await settleScheduledRead(clock);
    expect(sendEnabled).toHaveBeenCalledTimes(1);
    expect(sendEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "filesystem", clientIdempotencyKey: "one-press" }),
    );
  });

  it("draws the refusal where the inventory read could not be put", async () => {
    await renderSettledMcpPage(
      operationsServing([], {
        listInventory: async () => await Promise.reject(new Error("the daemon is unreachable")),
      }),
    );
    expect(screen.getByRole("button", { name: /try again/iu })).toBeDefined();
  });
});

/** Operations whose enablement mutation answers only when the case says so. */
function operationsHoldingTheirMutation(): {
  readonly operations: McpServerOperations;
  readonly answerHeldMutation: () => void;
} {
  const waiting: ((result: McpMutationResult) => void)[] = [];
  return {
    operations: operationsServing([FILESYSTEM], {
      sendEnabled: async () =>
        await new Promise<McpMutationResult>((resolve) => {
          waiting.push(resolve);
        }),
    }),
    answerHeldMutation: () => {
      for (const resolve of waiting.splice(0)) {
        resolve(PARTIAL_APPLICATION);
      }
    },
  };
}

// What the held mutation's answer prints.
const HELD_MUTATION_OUTCOME_TEXT = "mcp.config_write_conflict";

describe("McpFixtureBody — a bridge replaced under a mounted fixture body", () => {
  it("shows no outcome from a bridge the mount no longer holds", async () => {
    const superseded = operationsHoldingTheirMutation();
    const supersededBridge = fixtureBridge();
    const { container, rerender } = render(mcpPageTree(supersededBridge, superseded.operations));
    await settleScheduledRead(supersededBridge.scenarioEngine.clock);
    fireEvent.click(firstEnableButton(container));
    expect(container.textContent).toContain("Asking the background service to apply this.");

    const replacementBridge = fixtureBridge();
    rerender(mcpPageTree(replacementBridge, operationsServing([FILESYSTEM, ISSUE_TRACKER])));
    await settleScheduledRead(replacementBridge.scenarioEngine.clock);
    // The replacement answered its own inventory; the superseded press is not reported as in
    // flight against it.
    expect(container.querySelectorAll(".meridian-mcp__row")).toHaveLength(2);
    expect(container.textContent).not.toContain("Asking the background service to apply this.");

    await act(async () => {
      superseded.answerHeldMutation();
      await crossMacrotaskBoundary();
    });
    expect(container.textContent).not.toContain(HELD_MUTATION_OUTCOME_TEXT);
  });

  // Negative control: the same held call and release with no replacement, so the clean reading
  // above is about whose settlement it was.
  it("negative control: the same settlement renders while its own bridge still holds", async () => {
    const held = operationsHoldingTheirMutation();
    const { container, clock } = await renderSettledMcpPage(held.operations);
    fireEvent.click(firstEnableButton(container));
    await settleScheduledRead(clock);

    await act(async () => {
      held.answerHeldMutation();
      await crossMacrotaskBoundary();
    });
    expect(container.textContent).toContain(HELD_MUTATION_OUTCOME_TEXT);
  });
});
