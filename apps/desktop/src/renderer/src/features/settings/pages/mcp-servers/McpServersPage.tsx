// The MCP servers page: the frame only.
//
// The server list and its controls are `shell/McpShell.tsx`, which takes its calls as
// arguments; nothing mounts it until a composition has calls to give.

import type { ReactNode } from "react";

import type { SettingsPageRegistry } from "../../settings-pages.js";

/** The owner recorded for this page, so an unfilled section names someone. */
const OWNER = "settings-mcp";

/** The MCP servers page: an empty frame under the section heading. */
export function McpServersPage(): ReactNode {
  return <div className="meridian-settings-page" />;
}

/** Claim the MCP servers section. */
export function registerMcpServersPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "mcp-servers",
    owner: OWNER,
    label: "MCP servers",
    keywords: [
      "tools",
      "servers",
      "model context protocol",
      "governance",
      "trust",
      "overrides",
      "reconnect",
      "authorize",
    ],
    render: () => <McpServersPage />,
  });
}
