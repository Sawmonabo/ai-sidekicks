// A session's tool servers while the caller is mounted: `undefined` until the first list arrives,
// then the newest list, or `lost` when the daemon's list could not be read.

import { useEffect, useState } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import {
  followSessionMcpServers,
  type SessionMcpServerFrame,
} from "#renderer/services/daemon/session-mcp-servers.js";

/** Follow `sessionId`'s tool servers while mounted. */
export function useSessionMcpServers(
  bridge: PlatformBridge,
  sessionId: SessionId,
): SessionMcpServerFrame | undefined {
  const [frame, setFrame] = useState<SessionMcpServerFrame | undefined>(undefined);
  useEffect(() => {
    setFrame(undefined);
    return followSessionMcpServers(bridge, sessionId, setFrame);
  }, [bridge, sessionId]);
  return frame;
}
