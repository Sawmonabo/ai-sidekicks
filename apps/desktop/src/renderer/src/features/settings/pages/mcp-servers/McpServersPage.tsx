// The MCP servers page: the frame only. The server list and its controls are
// `fixtures/McpFixtureBody.tsx`, which takes its calls as arguments and is not mounted until a
// composition has calls to give.

import type { ReactNode } from "react";

/** The MCP servers page: an empty frame under the page heading. */
export function McpServersPage(): ReactNode {
  return <div className="meridian-settings-page" />;
}
