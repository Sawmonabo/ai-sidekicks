// A session's tool servers while the caller is mounted: `undefined` until the first list arrives,
// then the newest list, or `lost` when the daemon's list could not be read, which a read-again
// follows afresh.

import { useCallback, useEffect, useState } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import {
  followSessionMcpServers,
  type SessionMcpServerFrame,
} from "#renderer/services/daemon/session-mcp-servers.js";

/** The newest frame, and the act that follows the list afresh after it was lost. */
export interface SessionMcpServersReading {
  readonly frame: SessionMcpServerFrame | undefined;
  readonly readAgain: () => void;
}

/** Follow `sessionId`'s tool servers while mounted. */
export function useSessionMcpServers(
  bridge: PlatformBridge,
  sessionId: SessionId,
): SessionMcpServersReading {
  const [frame, setFrame] = useState<SessionMcpServerFrame | undefined>(undefined);
  // Bumped by a read-again, so the effect closes the lost stream and opens a fresh one.
  const [readCount, setReadCount] = useState(0);
  useEffect(() => {
    setFrame(undefined);
    return followSessionMcpServers(bridge, sessionId, setFrame);
  }, [bridge, sessionId, readCount]);
  const readAgain = useCallback(() => {
    setReadCount((count) => count + 1);
  }, []);
  return { frame, readAgain };
}
