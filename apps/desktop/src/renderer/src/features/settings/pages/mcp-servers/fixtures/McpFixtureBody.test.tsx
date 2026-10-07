// The MCP fixture body, driven with the daemon verbs handed in as arguments. The three servers
// are the arms the page must draw: a connected binding, one needing authorization while a leg is
// fine, and one whose binding store could not be read; a plugin's server and a project's unused
// copy of a name join them where a case reads where each binding applies. Every status and
// outcome is drawn as the daemon reported it, and a server's readings and controls are drawn only
// while it is selected: the first server when the page opens, or the one picked from the list.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "#renderer/services/platform/bridge.fixture.js";
import type {
  McpMutationResult,
  McpServerInventoryEntry,
  McpToolOverrideMutationResult,
} from "@ai-sidekicks/contracts/mcp/server";
import type { McpServerStatus } from "@ai-sidekicks/contracts/mcp/server";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { sessionListEntry } from "#renderer/store/session/directory/state.test-support.js";
import type { Clock } from "#renderer/lib/clock.js";
import { MILLISECONDS_PER_MINUTE } from "#renderer/lib/instant.js";
import { REFRESH_MAX_WAIT_MS } from "#renderer/lib/reads/refresh/caps.js";
import { LOADING_NOTICE_DELAY_MS } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { unscriptedScenario } from "#test/helpers/fixture/bridge.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { drawnText } from "#test/helpers/live-region.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { McpFixtureBody, type McpServerOperations } from "./McpFixtureBody.js";

afterEach(() => {
  cleanup();
});

const SESSION_A = "11111111-1111-4111-8111-111111111111" as SessionId;
const SESSION_B = "22222222-2222-4222-8222-222222222222" as SessionId;

// The service's sessions, naming both running sessions as the session list does.
const SESSION_DIRECTORY: SessionDirectoryState = {
  status: "served",
  sessions: [
    sessionListEntry({ sessionId: SESSION_A, name: "Fix login" }),
    sessionListEntry({ sessionId: SESSION_B, name: "Tidy the docs" }),
  ],
};

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
  tools: [
    {
      toolName: "write_file",
      enabled: { value: true, source: "server" },
      approvalMode: { value: "prompt", source: "override", serverValue: "auto" },
      idempotencyClass: {
        value: "compensable",
        source: "override",
        serverValue: "manual_reconcile_only",
      },
    },
  ],
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
  tools: [],
};

const SCRATCHPAD: McpServerInventoryEntry = {
  provider: "claude",
  scope: "local",
  scopeRef: "/work/repo",
  serverName: "scratchpad",
  config: { transport: "stdio", command: "./scripts/scratchpad-mcp" },
  status: "unknown",
  bindingStoreUnavailable: true,
};

// The project's shared copy of the scratchpad name, which its own copy outside the repo replaces.
const SHARED_SCRATCHPAD: McpServerInventoryEntry = {
  provider: "claude",
  scope: "project",
  scopeRef: "/work/repo",
  serverName: "scratchpad",
  config: { transport: "stdio", command: "scratchpad-mcp" },
  status: "unknown",
  supersededIn: ["/work/repo"],
  enabled: true,
  tools: [],
};

const REVIEWER: McpServerInventoryEntry = {
  provider: "claude",
  scope: "plugin",
  scopeRef: "review-tools",
  serverName: "reviewer",
  config: { transport: "stdio", command: "reviewer-mcp" },
  status: "connected",
  enabled: true,
  tools: [],
};

// Saved, and missed one of the two running sessions.
const PARTIAL_APPLICATION: McpMutationResult = {
  server: { ...FILESYSTEM, enabled: false },
  applied: "user_config_write",
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

// The filesystem binding's one tool switched off, enforced at once.
const TOOL_SWITCHED_OFF: McpToolOverrideMutationResult = {
  server: FILESYSTEM,
  applied: { enabled: "daemon_enforced" },
};

function operationsServing(
  servers: readonly McpServerInventoryEntry[],
  overrides: Partial<McpServerOperations> = {},
): McpServerOperations {
  return {
    listInventory: async () => await Promise.resolve({ servers }),
    subscribeInventoryChanges: () => () => undefined,
    sendEnabled: async () => await Promise.resolve(PARTIAL_APPLICATION),
    sendToolOverride: async () => await Promise.resolve(TOOL_SWITCHED_OFF),
    sendClearToolOverride: async () => await Promise.resolve(TOOL_SWITCHED_OFF),
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
    <McpFixtureBody
      bridge={bridge}
      operations={props.operations}
      sessionDirectory={SESSION_DIRECTORY}
    />
  ) : (
    <McpFixtureBody
      bridge={bridge}
      operations={props.operations}
      mintKey={props.mintKey}
      sessionDirectory={SESSION_DIRECTORY}
    />
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
 * The first row's `On for runs` switch, the press most mutation cases make. Throws so a case that
 * never reached a settled inventory fails at the press.
 */
function firstEnableButton(container: HTMLElement): HTMLElement {
  const label = [...container.querySelectorAll(".meridian-switch__label")].find(
    (candidate) => candidate.textContent === "On for runs",
  );
  const control = label?.querySelector('[role="switch"]');
  if (!(control instanceof HTMLElement)) {
    throw new Error("the settled inventory rendered no enablement control to press");
  }
  return control;
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

function entryNamed(container: HTMLElement, serverName: string, nth = 0): Element | undefined {
  return [...container.querySelectorAll(".meridian-mcp__entry")].filter(
    (entry) =>
      entry.querySelector(".meridian-mcp__entry-identity")?.firstChild?.textContent === serverName,
  )[nth];
}

/** Picks the named server from the list and answers the selected server's pane. */
function selectServer(container: HTMLElement, serverName: string, nth = 0): Element {
  const entry = entryNamed(container, serverName, nth);
  if (entry === undefined) {
    throw new Error(`the list drew no server named ${serverName}`);
  }
  fireEvent.click(entry);
  const detail = container.querySelector(".meridian-mcp__detail");
  if (detail === null) {
    throw new Error("the page drew no selected server's pane");
  }
  return detail;
}

/** The chip labels inside `selector` within `scope`. */
function chipLabelsIn(scope: Element | undefined, selector: string): readonly (string | null)[] {
  return [...(scope?.querySelectorAll(`${selector} .meridian-chip__label`) ?? [])].map(
    (label) => label.textContent,
  );
}

describe("McpFixtureBody", () => {
  it("renders the daemon's aggregate status rather than folding the legs itself", async () => {
    const { container } = await renderSettledMcpPage(operationsServing([ISSUE_TRACKER]));
    // The two legs disagree and the row's chip carries the daemon's aggregate; folding the legs
    // by eye would have to pick one.
    expect(
      chipLabelsIn(entryNamed(container, "issue-tracker"), ".meridian-mcp__entry-identity"),
    ).toStrictEqual(["Codex", "Needs sign-in"]);
    const detail = selectServer(container, "issue-tracker");
    expect(chipLabelsIn(detail, ".meridian-mcp__legs")).toStrictEqual([
      "Needs sign-in",
      "Connected",
    ]);
  });

  it("draws every server state in the page's five words, and each provider by its name", async () => {
    const drawn: readonly [McpServerInventoryEntry, McpServerStatus, string, string][] = [
      [FILESYSTEM, "connected", "Claude Code", "Connected"],
      [ISSUE_TRACKER, "starting", "Codex", "Starting"],
      [FILESYSTEM, "needs-auth", "Claude Code", "Needs sign-in"],
      [ISSUE_TRACKER, "failed", "Codex", "Failed"],
      [FILESYSTEM, "unknown", "Claude Code", "Unknown"],
    ];
    const { container } = await renderSettledMcpPage(
      operationsServing(
        drawn.map(([server, status]) => ({
          ...server,
          serverName: `server-${status}`,
          status,
          legs: [{ sessionId: SESSION_A, bindingId: `leg-${status}`, status }],
        })),
      ),
    );
    for (const [, status, providerName, word] of drawn) {
      const serverName = `server-${status}`;
      expect(
        chipLabelsIn(entryNamed(container, serverName), ".meridian-mcp__entry-identity"),
      ).toStrictEqual([providerName, word]);
      expect(
        chipLabelsIn(selectServer(container, serverName), ".meridian-mcp__legs"),
      ).toStrictEqual([word]);
    }
  });

  it("says where each binding applies in the add form's words, or the plugin that declared it", async () => {
    const { container } = await renderSettledMcpPage(
      operationsServing([FILESYSTEM, ISSUE_TRACKER, SCRATCHPAD, REVIEWER]),
    );
    const whereItApplies = (serverName: string): string | null | undefined =>
      entryNamed(container, serverName)?.querySelector(".meridian-mcp__entry-place")?.textContent;
    expect(whereItApplies("filesystem")).toBe("All projects");
    // The place words alone: a project's root path is a wire value, never drawn beside them.
    expect(whereItApplies("issue-tracker")).toBe("This project · in the repo");
    expect(whereItApplies("scratchpad")).toBe("This project · not in the repo");
    expect(whereItApplies("reviewer")).toBe("From plugin review-tools");
  });

  it("keeps both rows of a name set twice, the copy a project does not use saying so", async () => {
    const { container } = await renderSettledMcpPage(
      operationsServing([SCRATCHPAD, SHARED_SCRATCHPAD]),
    );
    expect(container.querySelectorAll(".meridian-mcp__entry")).toHaveLength(2);
    const notUsedLine = "Not used in /work/repo: its own scratchpad takes its place.";
    expect(entryNamed(container, "scratchpad", 0)?.textContent).not.toContain(notUsedLine);
    expect(entryNamed(container, "scratchpad", 1)?.textContent).toContain(notUsedLine);
  });

  it("names every control the degraded row cannot draw, and invents no status", async () => {
    const codexReadsItsOwnSwitch: McpServerInventoryEntry = {
      ...SCRATCHPAD,
      provider: "codex",
      enabled: true,
    };
    const { container } = await renderSettledMcpPage(
      operationsServing([SCRATCHPAD, codexReadsItsOwnSwitch]),
    );
    const degradedLine = (nth: number): string | null | undefined =>
      selectServer(container, "scratchpad", nth).querySelector(".meridian-nothing--not-checked")
        ?.textContent;
    expect(degradedLine(0)).toBe(
      "On for runs and the per-tool settings cannot be read right now. Those controls are not " +
        "drawn because the reading they act on did not arrive; everything else on this page is " +
        "offered exactly as usual.",
    );
    expect(degradedLine(1)).toBe(
      "Per-tool settings cannot be read right now. Those controls are not drawn because the " +
        "reading they act on did not arrive; everything else on this page is offered exactly as " +
        "usual.",
    );
    expect(
      selectServer(container, "scratchpad", 0).querySelectorAll('[role="switch"]'),
    ).toHaveLength(0);
  });

  it("says which provider has no servers, in place of the list or at its foot", async () => {
    const noServersLines = (container: HTMLElement): readonly (string | null)[] =>
      [...container.querySelectorAll("p")]
        .filter((line) => (line.textContent ?? "").startsWith("No tool servers"))
        .map((line) =>
          line.closest(".meridian-nothing--empty") === null
            ? `foot: ${line.textContent ?? ""}`
            : `block: ${line.textContent ?? ""}`,
        );
    const withOne = await renderSettledMcpPage(operationsServing([FILESYSTEM]));
    expect(noServersLines(withOne.container)).toStrictEqual([
      "foot: No tool servers are set up for Codex.",
    ]);
    cleanup();
    const withNone = await renderSettledMcpPage(operationsServing([]));
    expect(noServersLines(withNone.container)).toStrictEqual([
      "block: No tool servers are set up for Claude Code.",
      "block: No tool servers are set up for Codex.",
    ]);
  });

  it("settles a partial application in place: saved, and one session still on the old setting", async () => {
    const { container, clock } = await renderSettledMcpPage(operationsServing([FILESYSTEM]));
    selectServer(container, "filesystem");
    fireEvent.click(firstEnableButton(container));
    await settleScheduledRead(clock);
    const lines = [...container.querySelectorAll(".meridian-mcp__outcome p")].map(
      (line) => line.textContent,
    );
    expect(lines).toStrictEqual([
      "Saved to Claude Code's settings. New sessions use it.",
      "Tidy the docs is still running with the old setting.",
    ]);
  });

  it("clears only the facet chosen back to the server's own value, and settles under it", async () => {
    const sendToolOverride = vi.fn(async () => await Promise.resolve(TOOL_SWITCHED_OFF));
    const sendClearToolOverride = vi.fn(async () => await Promise.resolve(TOOL_SWITCHED_OFF));
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([FILESYSTEM], { sendToolOverride, sendClearToolOverride }),
      () => "clear-press",
    );
    selectServer(container, "filesystem");
    const [approval] = container.querySelectorAll(".meridian-mcp__tool select");
    if (approval === undefined) {
      throw new Error("the settled inventory rendered no approval choice to make");
    }
    fireEvent.change(approval, { target: { value: "auto" } });
    await settleScheduledRead(clock);
    expect(sendToolOverride).not.toHaveBeenCalled();
    expect(sendClearToolOverride).toHaveBeenCalledWith({
      provider: "claude",
      scope: "user",
      serverName: "filesystem",
      toolName: "write_file",
      facet: "approvalMode",
      clientIdempotencyKey: "clear-press",
    });
    expect(
      [...container.querySelectorAll(".meridian-mcp__tool .meridian-mcp__outcome")].map(
        (line) => line.textContent,
      ),
    ).toStrictEqual(["In force now."]);
  });

  it("switches one tool by sending only that facet, and settles under that tool", async () => {
    const sendToolOverride = vi.fn(async () => await Promise.resolve(TOOL_SWITCHED_OFF));
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([FILESYSTEM], { sendToolOverride }),
      () => "tool-press",
    );
    selectServer(container, "filesystem");
    const toolRow = container.querySelector(".meridian-mcp__tool");
    const toolSwitch = toolRow?.querySelector('[role="switch"]');
    if (!(toolSwitch instanceof HTMLElement)) {
      throw new Error("the settled inventory rendered no tool switch to press");
    }
    fireEvent.click(toolSwitch);
    await settleScheduledRead(clock);
    expect(sendToolOverride).toHaveBeenCalledWith({
      provider: "claude",
      scope: "user",
      serverName: "filesystem",
      override: { toolName: "write_file", enabled: false },
      clientIdempotencyKey: "tool-press",
    });
    expect(toolRow?.querySelector(".meridian-mcp__outcome")?.textContent).toBe("In force now.");
    expect(toolRow?.querySelectorAll(".meridian-mcp__outcome")).toHaveLength(1);
  });

  it("sends the key the caller minted for that press", async () => {
    const sendEnabled = vi.fn(async () => await Promise.resolve(PARTIAL_APPLICATION));
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([FILESYSTEM], { sendEnabled }),
      () => "one-press",
    );
    selectServer(container, "filesystem");
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

describe("McpFixtureBody — the list and the selected server", () => {
  it("opens on the first server, and selects nothing once the selected one leaves", async () => {
    let served: readonly McpServerInventoryEntry[] = [FILESYSTEM, ISSUE_TRACKER];
    let announceChange = (): void => undefined;
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([], {
        listInventory: async () => await Promise.resolve({ servers: served }),
        subscribeInventoryChanges: (onChange) => {
          announceChange = onChange;
          return () => undefined;
        },
      }),
    );
    const detail = (): Element | null => container.querySelector(".meridian-mcp__detail");
    expect(entryNamed(container, "filesystem")?.getAttribute("aria-current")).toBe("true");
    expect(detail()?.textContent).toContain("Running sessions");
    expect(detail()?.querySelectorAll('[role="switch"]').length).toBeGreaterThan(0);

    // Negative control: a server that is not the selected one leaving keeps the selection.
    served = [FILESYSTEM];
    act(() => {
      announceChange();
    });
    await settleScheduledRead(clock);
    expect(entryNamed(container, "filesystem")?.getAttribute("aria-current")).toBe("true");

    served = [ISSUE_TRACKER];
    act(() => {
      announceChange();
    });
    await settleScheduledRead(clock);
    expect(detail()?.textContent).toBe(
      "Pick a server on the left to see what it is allowed to do.",
    );
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(entryNamed(container, "issue-tracker")?.getAttribute("aria-current")).toBeNull();
    // Picking it draws its readings and controls in the same pane.
    const picked = selectServer(container, "issue-tracker");
    expect(picked.textContent).toContain("Running sessions");
    expect(entryNamed(container, "issue-tracker")?.getAttribute("aria-current")).toBe("true");
  });

  it("moves a reading's age when the clock passes the next figure, and not before", async () => {
    const fixture = fixtureBridge();
    const { clock } = fixture.scenarioEngine;
    // A minute old once the first read has settled, which moves the clock by the read's window.
    const observedAt = new Date(
      clock.now() + REFRESH_MAX_WAIT_MS - MILLISECONDS_PER_MINUTE,
    ).toISOString();
    const operations = operationsServing([{ ...FILESYSTEM, observedAt }]);
    const { container } = render(mcpPageTree(fixture, operations));
    await settleScheduledRead(clock);
    const age = (): string | null | undefined =>
      entryNamed(container, "filesystem")?.querySelector(".meridian-mcp__entry-identity")
        ?.lastElementChild?.textContent;
    expect(age()).toBe("1 minute ago");
    // A minute and a half still rounds to one minute.
    act(() => {
      fixture.scenarioEngine.advance(MILLISECONDS_PER_MINUTE / 2);
    });
    expect(age()).toBe("1 minute ago");
    act(() => {
      fixture.scenarioEngine.advance(1);
    });
    expect(age()).toBe("2 minutes ago");
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
const HELD_MUTATION_OUTCOME_TEXT = "Saved to Claude Code's settings. New sessions use it.";

describe("McpFixtureBody — a bridge replaced under a mounted fixture body", () => {
  it("shows no outcome from a bridge the mount no longer holds", async () => {
    const superseded = operationsHoldingTheirMutation();
    const supersededBridge = fixtureBridge();
    const { container, rerender } = render(mcpPageTree(supersededBridge, superseded.operations));
    await settleScheduledRead(supersededBridge.scenarioEngine.clock);
    selectServer(container, "filesystem");
    fireEvent.click(firstEnableButton(container));
    expect(drawnText(container)).not.toContain("Sending…");
    act(() => {
      supersededBridge.scenarioEngine.advance(LOADING_NOTICE_DELAY_MS);
    });
    expect(drawnText(container)).toContain("Sending…");

    const replacementBridge = fixtureBridge();
    rerender(mcpPageTree(replacementBridge, operationsServing([FILESYSTEM, ISSUE_TRACKER])));
    await settleScheduledRead(replacementBridge.scenarioEngine.clock);
    // The replacement answered its own inventory; the superseded press is not reported as in
    // flight against it.
    expect(container.querySelectorAll(".meridian-mcp__entry")).toHaveLength(2);
    expect(drawnText(container)).not.toContain("Sending…");

    await act(async () => {
      superseded.answerHeldMutation();
      await crossMacrotaskBoundary();
    });
    // Neither drawn nor said: the whole container, the announcer's regions included.
    expect(container.textContent).not.toContain(HELD_MUTATION_OUTCOME_TEXT);
  });

  // Negative control: the same held call and release with no replacement, so the clean reading
  // above is about whose settlement it was.
  it("negative control: the same settlement renders while its own bridge still holds", async () => {
    const held = operationsHoldingTheirMutation();
    const { container, clock } = await renderSettledMcpPage(held.operations);
    selectServer(container, "filesystem");
    fireEvent.click(firstEnableButton(container));
    await settleScheduledRead(clock);

    await act(async () => {
      held.answerHeldMutation();
      await crossMacrotaskBoundary();
    });
    expect(container.textContent).toContain(HELD_MUTATION_OUTCOME_TEXT);
  });
});
