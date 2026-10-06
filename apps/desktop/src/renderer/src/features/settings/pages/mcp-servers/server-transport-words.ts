// How a server runs, in the add form's `How it runs` words. The wire's transport value never
// reaches the screen.

import type { McpServerConfigView } from "@ai-sidekicks/contracts/mcp/mcp";

/** The on-screen words for each transport: a command it starts, or an address it reaches. */
export const SERVER_TRANSPORT_WORDS: Readonly<Record<McpServerConfigView["transport"], string>> = {
  stdio: "A command",
  http: "An address",
  sse: "An address",
};
