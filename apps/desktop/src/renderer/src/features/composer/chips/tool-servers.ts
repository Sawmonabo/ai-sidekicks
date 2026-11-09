// What the composer's tool-servers chip reads for a session's servers: its label counting the
// servers switched on, and its list grouped by state, the working servers first (a server still
// starting or of unknown state among them), then the ones needing a sign-in, the failed last.

import type { SessionMcpServer } from "@ai-sidekicks/contracts/session/controls/methods";

/** The chip's label and its list's two groups, each in the daemon's order. */
export interface ToolServersChipReading {
  /** `MCP N` for the servers switched on, `MCP` with none. */
  readonly label: string;
  readonly working: readonly SessionMcpServer[];
  readonly notWorking: readonly SessionMcpServer[];
}

/** The chip for `servers`, the session's tool servers as the daemon lists them. */
export function readToolServersChip(servers: readonly SessionMcpServer[]): ToolServersChipReading {
  const switchedOn = servers.filter((server) => server.enabled).length;
  return {
    label: switchedOn === 0 ? "MCP" : `MCP ${switchedOn}`,
    working: servers.filter((server) => !isNotWorking(server)),
    notWorking: [
      ...servers.filter((server) => server.status === "needsAuth"),
      ...servers.filter((server) => server.status === "failed"),
    ],
  };
}

function isNotWorking(server: SessionMcpServer): boolean {
  return server.status === "needsAuth" || server.status === "failed";
}
