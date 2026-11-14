// A session's tool servers as the daemon reports them, followed through
// `session.mcpServer.subscribe`, which delivers the whole list now and again after each change,
// and the session-level switch sent through `session.mcpServer.enabled.update`. A refused stream
// is handed on as the list being lost.

import type {
  SessionMcpServer,
  SessionMcpServerEnabledUpdateResponse,
  SessionMcpServerList,
} from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { SESSION_MCP_SERVER_STREAM } from "#shared/daemon/streams.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { callDaemon, type DaemonReply } from "./reply.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";

/** One delivery: the session's tool servers, or word that the list could not be read. */
export type SessionMcpServerFrame =
  | { readonly kind: "listed"; readonly servers: readonly SessionMcpServer[] }
  | { readonly kind: "lost" };

/** Follow one session's tool servers, handing each frame on, until the handle releases it. */
export function followSessionMcpServers(
  bridge: PlatformBridge,
  sessionId: SessionId,
  onFrame: (frame: SessionMcpServerFrame) => void,
): Unsubscribe {
  return openReopeningSubscription({
    signal: bridge.transportReconnect,
    subject: SESSION_MCP_SERVER_STREAM,
    firstOpenFailure: "refuseAndRetry",
    open: (deliver, onEnded) =>
      bridge.daemon.subscribe(SESSION_MCP_SERVER_STREAM, { sessionId }, deliver, onEnded),
    onFrame: (payload: unknown) => {
      onFrame({ kind: "listed", servers: (payload as SessionMcpServerList).servers });
    },
    onReopenRefusal: (refusal) => {
      if (refusal !== undefined) {
        onFrame({ kind: "lost" });
      }
    },
  });
}

/** Switch one tool server on or off for this session alone, from its next turn. */
export async function updateSessionMcpServerEnabled(
  bridge: PlatformBridge,
  sessionId: SessionId,
  serverName: string,
  enabled: boolean,
): Promise<DaemonReply<SessionMcpServerEnabledUpdateResponse>> {
  return await callDaemon(bridge, "session.mcpServer.enabled.update", {
    sessionId,
    serverName,
    enabled,
  });
}
