// What a tool server is doing, in the five words every surface says it in. The wire's status
// value never reaches the screen.

import type { McpServerStatus } from "@ai-sidekicks/contracts/mcp/server";

/** The on-screen word for each server status, total over the contract's status set. */
export const MCP_SERVER_STATUS_WORDS: Readonly<Record<McpServerStatus, string>> = {
  connected: "Connected",
  starting: "Starting",
  "needs-auth": "Needs sign-in",
  failed: "Failed",
  unknown: "Unknown",
};
