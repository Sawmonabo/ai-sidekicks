// The MCP servers page over this window's bridge. Its inventory read and its changes go
// through `callDaemon`, so each reply is parsed against the method's registered shape, and its
// live-status signal is the governance stream, opened before the first read and opened again when
// it ends, with a read after each re-open for what the gap hid. The running sessions are named
// from the window's session list feed, which the sessions list shares, and the projects a
// server's switches apply in come from the window's project feed.

import { useMemo, type ReactNode } from "react";

import { callDaemon } from "#renderer/services/daemon/reply.js";
import { MCP_NOTICE_STREAM } from "#shared/daemon/streams.js";
import { unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { openReopeningSubscription } from "#renderer/services/transport/reopening-subscription.js";
import { projectListFeedFor } from "#renderer/services/daemon/project-list.js";
import { sessionDirectoryFeedFor } from "#renderer/services/daemon/session/list-feed.js";
import { useProjectList } from "#renderer/store/projects/hooks/useProjectList.js";
import { projectLists } from "#renderer/store/projects/list.js";
import { useSessionDirectory } from "#renderer/store/session/directory/useSessionDirectory.js";
import { McpServersPage, type McpServerOperations } from "./McpServersPage.js";

/** The MCP servers page, its verbs answered by the daemon this window's bridge reaches. */
export function McpServersMount(): ReactNode {
  const bridge = usePlatformBridge();
  // Held per bridge: the page restarts its inventory read when the operations change.
  const operations = useMemo(() => mcpServerOperationsOver(bridge), [bridge]);
  const sessionDirectory = useSessionDirectory(sessionDirectoryFeedFor(bridge));
  const projectListFeed = projectListFeedFor(bridge);
  const projects = {
    state: useProjectList(projectListFeed),
    readAgain: () => {
      projectLists.reread(projectListFeed);
    },
  };
  return (
    <McpServersPage
      bridge={bridge}
      operations={operations}
      sessionDirectory={sessionDirectory}
      projects={projects}
    />
  );
}

/**
 * The verbs the body drives, over one bridge. A refused reply rejects with the daemon's
 * refusal, which the body's read and its mutation outcome both carry verbatim. A stream frame is
 * a signal to read again, so its payload is not read.
 */
function mcpServerOperationsOver(bridge: PlatformBridge): McpServerOperations {
  return {
    listInventory: async (signal) =>
      unwrapDaemonReply(await callDaemon(bridge, "mcp.server.list", {}, { signal })),
    subscribeInventoryChanges: (onChange) =>
      openReopeningSubscription({
        signal: bridge.transportReconnect,
        subject: MCP_NOTICE_STREAM,
        open: (deliver, onEnded) =>
          bridge.daemon.subscribe(MCP_NOTICE_STREAM, {}, deliver, onEnded),
        onFrame: () => {
          onChange();
        },
        onReopened: onChange,
      }),
    sendEnabled: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "mcp.server.enabled.update", request)),
    sendToolOverride: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "mcp.toolOverride.update", request)),
    sendClearToolOverride: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "mcp.toolOverride.clear", request)),
    sendSignIn: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "mcp.server.signIn", request)),
  };
}
