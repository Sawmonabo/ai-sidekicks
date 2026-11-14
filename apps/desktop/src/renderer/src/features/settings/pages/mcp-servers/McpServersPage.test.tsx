// The MCP servers page, driven with the daemon verbs handed in as arguments. The three
// servers are the arms the page must draw: a connected binding, one needing authorization while a
// leg is fine, and one whose binding store could not be read; a plugin's server and a project's
// unused copy of a name join them where a case reads where each binding applies. Every status and
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
  McpServerBindingId,
  McpServerInventoryEntry,
  McpServerMutationResponse,
  McpServerStatus,
  McpToolOverrideMutationResponse,
} from "@ai-sidekicks/contracts/mcp/server";
import type { DistroName } from "@ai-sidekicks/contracts/place";
import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { ProjectListState } from "#renderer/store/projects/list.js";
import type { RuntimeBindingId } from "@ai-sidekicks/contracts/provider/driver/runtime-binding";
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
import { refuse, RefusalError } from "#renderer/lib/refusal/contract.js";
import { MCP_SERVER_SIGN_IN_FAILED_CODE } from "@ai-sidekicks/contracts/mcp/governance";
import { McpServersPage, type McpServerOperations } from "./McpServersPage.js";

afterEach(() => {
  cleanup();
});

const SESSION_A = "11111111-1111-4111-8111-111111111111" as SessionId;
const SESSION_B = "22222222-2222-4222-8222-222222222222" as SessionId;
const CLAUDE = "claude" as ProviderId;
const CODEX = "codex" as ProviderId;
const LEG_A = "leg-a" as RuntimeBindingId;
const LEG_B = "leg-b" as RuntimeBindingId;

/** A binding id for a fixture row, named for it. */
function bindingIdFor(serverName: string): McpServerBindingId {
  return `binding-${serverName}` as McpServerBindingId;
}

// The service's sessions, naming both running sessions as the session list does.
const SESSION_DIRECTORY: SessionDirectoryState = {
  status: "served",
  chatCount: 0,
  sessions: [
    sessionListEntry({ sessionId: SESSION_A, name: "Fix login" }),
    sessionListEntry({ sessionId: SESSION_B, name: "Tidy the docs" }),
  ],
};

const FILESYSTEM: McpServerInventoryEntry = {
  provider: CLAUDE,
  scope: "user",
  serverName: "filesystem",
  serverBindingId: bindingIdFor("filesystem"),
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
        serverValue: "manualReconcileOnly",
      },
    },
  ],
};

const ISSUE_TRACKER: McpServerInventoryEntry = {
  provider: CODEX,
  scope: "project",
  scopeRef: "/work/repo",
  serverName: "issue-tracker",
  serverBindingId: bindingIdFor("issue-tracker"),
  config: {
    transport: "http",
    url: "https://issues.example.test/mcp",
    headerNames: ["X-Workspace"],
    bearerTokenEnvVar: "ISSUES_TOKEN",
  },
  status: "needsAuth",
  legs: [
    { sessionId: SESSION_A, bindingId: LEG_A, status: "needsAuth" },
    { sessionId: SESSION_B, bindingId: LEG_B, status: "connected" },
  ],
  enabled: true,
  tools: [],
};

const SCRATCHPAD: McpServerInventoryEntry = {
  provider: CLAUDE,
  scope: "local",
  scopeRef: "/work/repo",
  serverName: "scratchpad",
  serverBindingId: bindingIdFor("scratchpad"),
  config: { transport: "stdio", command: "./scripts/scratchpad-mcp" },
  status: "unknown",
  bindingStoreUnavailable: true,
};

// The project's shared copy of the scratchpad name, which its own copy outside the repo replaces.
const SHARED_SCRATCHPAD: McpServerInventoryEntry = {
  provider: CLAUDE,
  scope: "project",
  scopeRef: "/work/repo",
  serverName: "scratchpad",
  serverBindingId: bindingIdFor("scratchpad"),
  config: { transport: "stdio", command: "scratchpad-mcp" },
  status: "unknown",
  supersededIn: [{ path: "/work/repo" }],
  enabled: true,
  tools: [],
};

const REVIEWER: McpServerInventoryEntry = {
  provider: CLAUDE,
  scope: "plugin",
  scopeRef: "review-tools",
  serverName: "reviewer",
  serverBindingId: bindingIdFor("reviewer"),
  config: { transport: "stdio", command: "reviewer-mcp" },
  status: "connected",
  enabled: true,
  tools: [],
};

// A claude.ai connector, whose switch applies one project at a time.
const LINEAR: McpServerInventoryEntry = {
  provider: CLAUDE,
  scope: "connector",
  scopeRef: "account-work" as ProviderAccountId,
  serverName: "linear",
  serverBindingId: bindingIdFor("linear"),
  config: { transport: "http", url: "https://mcp.linear.example/" },
  status: "connected",
  enabled: true,
  tools: [],
};

// The projects attached to this computer: one on the machine, one in a WSL distribution.
const ATTACHED_PROJECTS: ProjectListState = {
  status: "served",
  projects: [
    {
      projectId: "project-atlas" as ProjectId,
      repoMountId: null,
      name: "atlas",
      folderPath: "/work/atlas",
      state: "active",
      sessionCount: 0,
      runningSessionId: null,
      sessionTally: { running: 0, waiting: 0, done: 0 },
      setup: { filesToCopy: [], commands: [] },
      environmentRows: [],
      branchPattern: null,
    },
    {
      projectId: "project-beacon" as ProjectId,
      repoMountId: null,
      name: "beacon",
      folderPath: "/home/me/beacon",
      state: "active",
      sessionCount: 0,
      runningSessionId: null,
      sessionTally: { running: 0, waiting: 0, done: 0 },
      setup: { filesToCopy: [], commands: [] },
      environmentRows: [],
      branchPattern: null,
      place: { distro: "Ubuntu" as DistroName },
    },
  ],
};

// Saved, and missed one of the two running sessions.
const PARTIAL_APPLICATION: McpServerMutationResponse = {
  server: { ...FILESYSTEM, enabled: false },
  applied: "userConfigWrite",
  liveResults: [
    { sessionId: SESSION_A, bindingId: LEG_A, outcome: "applied" },
    {
      sessionId: SESSION_B,
      bindingId: LEG_B,
      outcome: "failed",
      errorCode: "mcp.server.configWriteConflict",
    },
  ],
};

// The filesystem binding's one tool switched off, enforced at once.
const TOOL_SWITCHED_OFF: McpToolOverrideMutationResponse = {
  server: FILESYSTEM,
  applied: { enabled: "daemonEnforced" },
};

function operationsServing(
  servers: readonly McpServerInventoryEntry[],
  overrides: Partial<McpServerOperations> = {},
): McpServerOperations {
  return {
    listInventory: async () => await Promise.resolve({ servers, failedProviders: [] }),
    subscribeInventoryChanges: () => () => undefined,
    sendEnabled: async () => await Promise.resolve(PARTIAL_APPLICATION),
    sendToolOverride: async () => await Promise.resolve(TOOL_SWITCHED_OFF),
    sendClearToolOverride: async () => await Promise.resolve(TOOL_SWITCHED_OFF),
    sendSignIn: async () =>
      await Promise.resolve({ authorizationUrl: "https://issues.example.test/authorize" }),
    ...overrides,
  };
}

function fixtureBridge(): FixtureBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("mcp-servers-page") });
}

/** The page as its mount draws it: the bridge comes from the provider's resolution. */
function MountedMcpPage(props: {
  readonly operations: McpServerOperations;
  readonly mintKey?: () => string;
}): React.JSX.Element {
  const bridge = usePlatformBridge();
  return props.mintKey === undefined ? (
    <McpServersPage
      bridge={bridge}
      operations={props.operations}
      sessionDirectory={SESSION_DIRECTORY}
      projects={{ state: ATTACHED_PROJECTS, readAgain: () => undefined }}
    />
  ) : (
    <McpServersPage
      bridge={bridge}
      operations={props.operations}
      mintKey={props.mintKey}
      sessionDirectory={SESSION_DIRECTORY}
      projects={{ state: ATTACHED_PROJECTS, readAgain: () => undefined }}
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

/** The selected server's `Sign in to this server` button. */
function signInButton(container: HTMLElement): HTMLElement {
  const button = [...container.querySelectorAll(".meridian-mcp__detail button")].find(
    (candidate) => candidate.textContent === "Sign in to this server",
  );
  if (!(button instanceof HTMLElement)) {
    throw new Error("the selected server drew no sign-in control");
  }
  return button;
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

describe("McpServersPage", () => {
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
      [FILESYSTEM, "needsAuth", "Claude Code", "Needs sign-in"],
      [ISSUE_TRACKER, "failed", "Codex", "Failed"],
      [FILESYSTEM, "unknown", "Claude Code", "Unknown"],
    ];
    const { container } = await renderSettledMcpPage(
      operationsServing(
        drawn.map(([server, status]) => ({
          ...server,
          serverName: `server-${status}`,
          status,
          legs: [{ sessionId: SESSION_A, bindingId: `leg-${status}` as RuntimeBindingId, status }],
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
      provider: CODEX,
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
      provider: CLAUDE,
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
      provider: CLAUDE,
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

describe("McpServersPage — a server switched per project", () => {
  it("sends each project's switch with that project's root and distribution", async () => {
    const sendEnabled = vi.fn(async () => await Promise.resolve(PARTIAL_APPLICATION));
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([LINEAR], { sendEnabled }),
      () => "project-press",
    );
    const switches = [...selectServer(container, "linear").querySelectorAll('[role="switch"]')];
    expect(switches).toHaveLength(2);
    for (const control of switches) {
      fireEvent.click(control);
    }
    await settleScheduledRead(clock);
    for (const request of [
      {
        provider: CLAUDE,
        scope: "connector",
        scopeRef: "account-work",
        serverName: "linear",
        enabled: false,
        projectRoot: "/work/atlas",
        clientIdempotencyKey: "project-press",
      },
      {
        provider: CLAUDE,
        scope: "connector",
        scopeRef: "account-work",
        serverName: "linear",
        enabled: false,
        projectRoot: "/home/me/beacon",
        place: { distro: "Ubuntu" },
        clientIdempotencyKey: "project-press",
      },
    ]) {
      expect(sendEnabled).toHaveBeenCalledWith(request);
    }
  });
});

describe("McpServersPage — a provider whose list could not be read", () => {
  it("draws it as a row of the list under its provider, with no cause, and Try again reads the list again", async () => {
    const listInventory = vi.fn(
      async () =>
        await Promise.resolve({
          servers: [FILESYSTEM],
          failedProviders: [{ provider: CODEX, cause: "codex mcp list exited 1" }],
        }),
    );
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([], { listInventory }),
    );
    const foot = container.querySelector(".meridian-mcp__list");
    const failedRow = foot?.querySelector(".meridian-mcp__entries > .meridian-mcp__failed-entry");
    expect(failedRow?.textContent).toBe("CodexCouldn't load serversTry again");
    // The failed provider is not also said to have no servers.
    expect(foot?.textContent).not.toContain("No tool servers are set up for Codex.");

    const reads = listInventory.mock.calls.length;
    const tryAgain = failedRow?.querySelector("button");
    if (!(tryAgain instanceof HTMLElement)) {
      throw new Error("the failed provider's line drew no Try again");
    }
    fireEvent.click(tryAgain);
    await settleScheduledRead(clock);
    expect(listInventory.mock.calls.length).toBe(reads + 1);
  });
});

describe("McpServersPage — signing in to a server", () => {
  it("sends the binding with the press's key and settles once its page is handed to the browser", async () => {
    const sendSignIn = vi.fn(
      async () =>
        await Promise.resolve({ authorizationUrl: "https://issues.example.test/authorize" }),
    );
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([ISSUE_TRACKER], { sendSignIn }),
      () => "sign-in-press",
    );
    selectServer(container, "issue-tracker");
    fireEvent.click(signInButton(container));
    await settleScheduledRead(clock);
    expect(sendSignIn).toHaveBeenCalledWith({
      provider: CODEX,
      scope: "project",
      scopeRef: "/work/repo",
      serverName: "issue-tracker",
      clientIdempotencyKey: "sign-in-press",
    });
    expect(
      container.querySelector(".meridian-mcp__detail .meridian-mcp__outcome")?.textContent,
    ).toBe("The sign-in for that server opened in the default browser.");
  });

  it("draws each sign-in refusal as the strip ending in Try again, which signs in again", async () => {
    const refusals: readonly [string, string, string][] = [
      [MCP_SERVER_SIGN_IN_FAILED_CODE, "the token endpoint timed out", "Sign-in did not finish."],
      [
        "mcp.server.signInUnsupported",
        "This server publishes no sign-in route.",
        "This server publishes no sign-in route.",
      ],
    ];
    for (const [code, detail, drawn] of refusals) {
      let pressNumber = 0;
      const sendSignIn = vi.fn(
        async () => await Promise.reject(new RefusalError(refuse("daemon-call", code, detail))),
      );
      const { container, clock } = await renderSettledMcpPage(
        operationsServing([ISSUE_TRACKER], { sendSignIn }),
        () => {
          pressNumber += 1;
          return `press-${String(pressNumber)}`;
        },
      );
      selectServer(container, "issue-tracker");
      fireEvent.click(signInButton(container));
      await settleScheduledRead(clock);
      const strip = container.querySelector(".meridian-refusal--strip");
      expect(strip?.getAttribute("data-refusal-code")).toBe(code);
      expect(strip?.querySelector(".meridian-refusal__message")?.textContent).toBe(drawn);

      const tryAgain = strip?.querySelector(".meridian-refusal__try-again button");
      if (!(tryAgain instanceof HTMLElement)) {
        throw new Error("the refusal strip drew no Try again");
      }
      fireEvent.click(tryAgain);
      await settleScheduledRead(clock);
      expect(sendSignIn).toHaveBeenLastCalledWith(
        expect.objectContaining({ serverName: "issue-tracker", clientIdempotencyKey: "press-2" }),
      );
      cleanup();
    }
  });
});

describe("McpServersPage — the list and the selected server", () => {
  it("opens on the first server, and selects nothing once the selected one leaves", async () => {
    let served: readonly McpServerInventoryEntry[] = [FILESYSTEM, ISSUE_TRACKER];
    let announceChange = (): void => undefined;
    const { container, clock } = await renderSettledMcpPage(
      operationsServing([], {
        listInventory: async () => await Promise.resolve({ servers: served, failedProviders: [] }),
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
  const waiting: ((result: McpServerMutationResponse) => void)[] = [];
  return {
    operations: operationsServing([FILESYSTEM], {
      sendEnabled: async () =>
        await new Promise<McpServerMutationResponse>((resolve) => {
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

describe("McpServersPage — a bridge replaced under a mounted page", () => {
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
