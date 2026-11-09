// The session's agent tree read off `agent.childRunLink.list`: every child run and provider helper
// with its head, the badge's counts and the refused creates. The reply is checked with the
// method's generated check; a refusal is thrown, so the read that asked settles failed.

import type {
  AgentChildRunLinkListRequest,
  AgentChildRunLinkListResponse,
} from "@ai-sidekicks/contracts/orchestration";

import type { PlatformBridge } from "../platform/bridge.js";
import { callDaemon, unwrapDaemonReply } from "./reply.js";

/**
 * Read one session's child-run tree over `bridge`, stopping when `signal` aborts. Throws a
 * `RefusalError` carrying the daemon's refusal, or the app's own when the reply is unreadable.
 */
export async function readChildRunLinks(
  bridge: PlatformBridge,
  request: AgentChildRunLinkListRequest,
  signal: AbortSignal,
): Promise<AgentChildRunLinkListResponse> {
  return unwrapDaemonReply(
    await callDaemon(bridge, "agent.childRunLink.list", request, { signal }),
  );
}
