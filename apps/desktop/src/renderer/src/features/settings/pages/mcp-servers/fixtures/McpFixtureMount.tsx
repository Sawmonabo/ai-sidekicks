// The MCP fixture body over this window's bridge. Its inventory read and its enablement change
// go through `callDaemon`, so each reply is parsed against the method's registered shape, and
// its live-status signal is the governance stream, opened before the first read and opened again
// when it ends, with a read after each re-open for what the gap hid.

import { useMemo, type ReactNode } from "react";

import { callDaemon } from "#renderer/services/daemon/daemon-reply.js";
import { MCP_NOTICE_STREAM } from "#renderer/services/daemon/session/event/session-event-streams.js";
import { unwrapDaemonReply } from "#renderer/services/daemon/unwrap-daemon-reply.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { openReopeningSubscription } from "#renderer/services/transport/reopening-subscription.js";
import { McpFixtureBody, type McpServerOperations } from "./McpFixtureBody.js";

/** The MCP fixture body, its verbs answered by the daemon this window's bridge reaches. */
export function McpFixtureMount(): ReactNode {
  const bridge = usePlatformBridge();
  // Held per bridge: the body restarts its inventory read when the operations change.
  const operations = useMemo(() => mcpServerOperationsOver(bridge), [bridge]);
  return <McpFixtureBody bridge={bridge} operations={operations} />;
}

/**
 * The three verbs the body drives, over one bridge. A refused reply rejects with the daemon's
 * refusal, which the body's read and its mutation outcome both carry verbatim. A stream frame is
 * a signal to read again, so its payload is not read.
 */
function mcpServerOperationsOver(bridge: PlatformBridge): McpServerOperations {
  return {
    listInventory: async (signal) =>
      unwrapDaemonReply(await callDaemon(bridge, "mcp.list", {}, { signal })),
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
      unwrapDaemonReply(await callDaemon(bridge, "mcp.setEnabled", request)),
  };
}
