// The MCP shell, driven with the daemon verbs handed in as arguments.
//
// The three rows below are the three arms this page has to draw: an ordinary trusted
// binding, one that needs authorization while a leg of it is fine, and one whose trust
// store could not be read at all.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import type {
  McpMutationResult,
  McpServerInventoryEntry,
  SessionId,
} from "@ai-sidekicks/contracts";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { McpFixtureBody, type McpShellOperations } from "./McpFixtureBody.js";

afterEach(() => {
  cleanup();
});

const SESSION_A = "11111111-1111-4111-8111-111111111111" as SessionId;
const SESSION_B = "22222222-2222-4222-8222-222222222222" as SessionId;

const FILESYSTEM: McpServerInventoryEntry = {
  provider: "claude",
  scope: "user",
  serverName: "filesystem",
  effectiveInRuns: true,
  config: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    envVarNames: ["FS_ROOT"],
  },
  status: "connected",
  enabled: true,
  trusted: true,
  configHash: "hash-filesystem",
  toolOverrides: [],
};

const ISSUE_TRACKER: McpServerInventoryEntry = {
  provider: "codex",
  scope: "project",
  scopeRef: "/work/repo",
  serverName: "issue-tracker",
  effectiveInRuns: true,
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
  trusted: false,
  configHash: "hash-issues",
  toolOverrides: [],
};

const SCRATCHPAD: McpServerInventoryEntry = {
  provider: "claude",
  scope: "local",
  scopeRef: "/work/repo",
  serverName: "scratchpad",
  effectiveInRuns: false,
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
  overrides: Partial<McpShellOperations> = {},
): McpShellOperations {
  return {
    listInventory: async () => await Promise.resolve({ servers }),
    subscribeInventoryChanges: () => () => undefined,
    sendEnabled: async () => await Promise.resolve(PARTIAL_APPLICATION),
    sendTrust: async () => await Promise.resolve(PARTIAL_APPLICATION),
    ...overrides,
  };
}

function fixtureBridge(): PlatformBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("mcp-shell") });
}

/**
 * The shell as a composition mounts it: the bridge comes from the provider's resolution,
 * which moves one commit after a prop changes.
 */
function MountedMcpShell(props: {
  readonly operations: McpShellOperations;
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
 * The tree, as an element rather than a render, so a case can re-render the SAME mount
 * at a different bridge the way `PlatformBridgeProvider` does on a reconnect.
 */
function shellTree(
  bridge: PlatformBridge,
  operations: McpShellOperations,
  mintKey?: () => string,
): React.JSX.Element {
  return (
    <PlatformBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        {mintKey === undefined ? (
          <MountedMcpShell operations={operations} />
        ) : (
          <MountedMcpShell operations={operations} mintKey={mintKey} />
        )}
      </LiveAnnouncerProvider>
    </PlatformBridgeProvider>
  );
}

/**
 * The first row's enablement control, which is the press every mutation case makes.
 *
 * Throws rather than asserting, so a case that never reached a settled inventory fails
 * at the line that pressed instead of at an assertion three settles later.
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

async function renderSettledShell(
  operations: McpShellOperations,
  mintKey?: () => string,
): Promise<{ readonly container: HTMLElement; readonly bridge: PlatformBridge }> {
  const bridge = fixtureBridge();
  const { container } = render(shellTree(bridge, operations, mintKey));
  await settleScheduledRead(bridge);
  return { container, bridge };
}

function rowNamed(container: HTMLElement, serverName: string): Element | undefined {
  return [...container.querySelectorAll(".meridian-mcp__row")].find((row) =>
    (row.textContent ?? "").includes(serverName),
  );
}

describe("McpShell", () => {
  it("draws a loading absence before the inventory answers", () => {
    const { container } = render(shellTree(fixtureBridge(), operationsServing([FILESYSTEM])));
    expect(container.textContent).toContain("servers this node governs");
    expect(container.querySelectorAll(".meridian-mcp__row")).toHaveLength(0);
  });

  it("lists one row per scope-qualified binding", async () => {
    const { container } = await renderSettledShell(
      operationsServing([FILESYSTEM, ISSUE_TRACKER, SCRATCHPAD]),
    );
    expect(container.querySelectorAll(".meridian-mcp__row")).toHaveLength(3);
  });

  it("renders the daemon's aggregate status rather than folding the legs itself", async () => {
    const { container } = await renderSettledShell(operationsServing([ISSUE_TRACKER]));
    // Its two legs disagree — one `needs-auth`, one `connected` — and the row's own
    // chip carries the daemon's aggregate. A page that folded the legs by eye would
    // have had to pick one of them.
    expect(rowNamed(container, "issue-tracker")?.textContent).toContain("needs-auth");
    expect(rowNamed(container, "issue-tracker")?.textContent).toContain("connected");
  });

  it("renders names where the wire carries names, and no value anywhere", async () => {
    const { container } = await renderSettledShell(operationsServing([FILESYSTEM, ISSUE_TRACKER]));
    expect(container.textContent).toContain("Environment variables read");
    expect(container.textContent).toContain("Headers sent");
    expect(container.textContent).toContain("Bearer token read from");
  });

  it("withholds the trust control on the row whose trust store could not be read", async () => {
    const { container } = await renderSettledShell(
      operationsServing([FILESYSTEM, ISSUE_TRACKER, SCRATCHPAD]),
    );
    const degradedRow = rowNamed(container, "scratchpad");
    expect(degradedRow?.textContent).toContain("trust control is withheld");
    expect(
      [...(degradedRow?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
    ).not.toContain("Grant trust");
  });

  // The negative control for the case above: every other row DOES offer it, so the
  // withholding is about that row's arm and not about the page having no control.
  it("offers the trust control on the rows whose trust arm arrived", async () => {
    const { container } = await renderSettledShell(
      operationsServing([FILESYSTEM, ISSUE_TRACKER, SCRATCHPAD]),
    );
    const trustButtons = [...container.querySelectorAll("button")].filter((button) =>
      /trust/iu.test(button.textContent ?? ""),
    );
    expect(trustButtons).toHaveLength(2);
  });

  it("names no invented status on the degraded row", async () => {
    const { container } = await renderSettledShell(operationsServing([SCRATCHPAD]));
    const degradedRow = rowNamed(container, "scratchpad");
    expect(degradedRow?.textContent).toContain("could not be read");
    expect(degradedRow?.textContent).not.toContain("No tool on this binding carries an override");
  });

  it("renders a partial application: one leg applied, one failed", async () => {
    const { container, bridge } = await renderSettledShell(operationsServing([FILESYSTEM]));
    fireEvent.click(firstEnableButton(container));
    await settleScheduledRead(bridge);
    expect(container.textContent).toContain("live_reconcile");
    expect(container.textContent).toContain("mcp.config_write_conflict");
  });

  it("sends the key the caller minted for that press", async () => {
    const sendEnabled = vi.fn(async () => await Promise.resolve(PARTIAL_APPLICATION));
    const { container, bridge } = await renderSettledShell(
      operationsServing([FILESYSTEM], { sendEnabled }),
      () => "one-press",
    );
    fireEvent.click(firstEnableButton(container));
    await settleScheduledRead(bridge);
    expect(sendEnabled).toHaveBeenCalledTimes(1);
    expect(sendEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "filesystem", clientIdempotencyKey: "one-press" }),
    );
  });

  it("draws the empty inventory as an ordinary state rather than a failure", async () => {
    const { container } = await renderSettledShell(operationsServing([]));
    expect(container.textContent).toContain("governs no MCP servers");
  });

  it("draws the refusal where the inventory read could not be put", async () => {
    await renderSettledShell(
      operationsServing([], {
        listInventory: async () => await Promise.reject(new Error("the daemon is unreachable")),
      }),
    );
    expect(screen.getByRole("button", { name: /try again/iu })).toBeDefined();
  });
});

/** Operations whose enablement mutation answers only when the case says so. */
function operationsHoldingTheirMutation(): {
  readonly operations: McpShellOperations;
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

// What the held mutation's answer prints, as the operator reads it.
const HELD_MUTATION_OUTCOME_TEXT = "mcp.config_write_conflict";

describe("McpShell — a bridge replaced under a mounted shell", () => {
  it("shows no outcome from a bridge the mount no longer holds", async () => {
    const superseded = operationsHoldingTheirMutation();
    const supersededBridge = fixtureBridge();
    const { container, rerender } = render(shellTree(supersededBridge, superseded.operations));
    await settleScheduledRead(supersededBridge);
    fireEvent.click(firstEnableButton(container));
    expect(container.textContent).toContain("Asking the background service to apply this.");

    const replacementBridge = fixtureBridge();
    rerender(shellTree(replacementBridge, operationsServing([FILESYSTEM, ISSUE_TRACKER])));
    await settleScheduledRead(replacementBridge);
    // The replacement answered its own inventory, and the superseded bridge's press
    // is not still reported as in flight against it.
    expect(container.querySelectorAll(".meridian-mcp__row")).toHaveLength(2);
    expect(container.textContent).not.toContain("Asking the background service to apply this.");

    await act(async () => {
      superseded.answerHeldMutation();
      await crossMacrotaskBoundary();
    });
    expect(container.textContent).not.toContain(HELD_MUTATION_OUTCOME_TEXT);
  });

  // The negative control for the case above: the same held call, the same release, and
  // no replacement — so a clean reading there is about WHOSE settlement it was rather
  // than about this shell never rendering one.
  it("negative control: the same settlement renders while its own bridge still holds", async () => {
    const held = operationsHoldingTheirMutation();
    const { container, bridge } = await renderSettledShell(held.operations);
    fireEvent.click(firstEnableButton(container));
    await settleScheduledRead(bridge);

    await act(async () => {
      held.answerHeldMutation();
      await crossMacrotaskBoundary();
    });
    expect(container.textContent).toContain(HELD_MUTATION_OUTCOME_TEXT);
  });
});
