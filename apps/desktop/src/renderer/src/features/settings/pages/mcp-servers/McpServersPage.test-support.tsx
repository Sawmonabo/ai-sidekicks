// The servers, daemon verbs and mount the MCP servers page's suites share: a connected server, the
// sessions and projects the page names, and the page mounted under a fixture bridge.

import { render } from "@testing-library/react";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "#renderer/services/platform/bridge.fixture.js";
import type {
  McpServerBindingId,
  McpServerInventoryEntry,
  McpServerMutationResponse,
  McpToolOverrideMutationResponse,
} from "@ai-sidekicks/contracts/mcp/server";
import type { DistroName } from "@ai-sidekicks/contracts/place";
import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { ProjectListState } from "#renderer/store/projects/list.js";
import type { RuntimeBindingId } from "@ai-sidekicks/contracts/provider/driver/runtime-binding";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { sessionListEntry } from "#renderer/store/session/directory/state.test-support.js";
import type { Clock } from "#renderer/lib/clock.js";
import { unscriptedScenario } from "#test/helpers/fixture/bridge.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { McpServersPage, type McpServerOperations } from "./McpServersPage.js";

/** The first of the two running sessions the session list names. */
export const SESSION_A = "11111111-1111-4111-8111-111111111111" as SessionId;
/** The second running session. */
export const SESSION_B = "22222222-2222-4222-8222-222222222222" as SessionId;
/** The provider the filesystem server is set up for. */
export const CLAUDE = "claude" as ProviderId;
/** The first session's live binding. */
export const LEG_A = "leg-a" as RuntimeBindingId;
/** The second session's live binding. */
export const LEG_B = "leg-b" as RuntimeBindingId;

/** A binding id for a fixture row, named for it. */
export function bindingIdFor(serverName: string): McpServerBindingId {
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

/** A connected server set up for all projects, with one tool whose settings are overridden. */
export const FILESYSTEM: McpServerInventoryEntry = {
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

/** A change saved that missed one of the two running sessions. */
export const PARTIAL_APPLICATION: McpServerMutationResponse = {
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

/** The filesystem binding's one tool switched off, enforced at once. */
export const TOOL_SWITCHED_OFF: McpToolOverrideMutationResponse = {
  server: FILESYSTEM,
  applied: { enabled: "daemonEnforced" },
};

/** The page's daemon verbs answering `servers`, with any verb a case replaces. */
export function operationsServing(
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
    sendUpsert: async () => await Promise.resolve(PARTIAL_APPLICATION),
    sendDelete: async () => await Promise.resolve({ applied: "userConfigWrite" }),
    sendReconnect: async () => await Promise.resolve({ legs: [] }),
    searchRegistry: async () => await Promise.resolve({ status: "served", value: { servers: [] } }),
    ...overrides,
  };
}

/** A fixture bridge with no scenario script, its clock the case's to move. */
export function fixtureBridge(): FixtureBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("mcp-servers-page") });
}

/**
 * The tree as an element, so a case can re-render the same mount at a different bridge the way
 * `PlatformBridgeProvider` does on a reconnect.
 */
export function mcpPageTree(
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

/** Mount the page over `operations` and let its first inventory read settle. */
export async function renderSettledMcpPage(
  operations: McpServerOperations,
  mintKey?: () => string,
): Promise<{ readonly container: HTMLElement; readonly clock: Clock }> {
  const fixture = fixtureBridge();
  const { clock } = fixture.scenarioEngine;
  const { container } = render(mcpPageTree(fixture, operations, mintKey));
  await settleScheduledRead(clock);
  return { container, clock };
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
