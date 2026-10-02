// The MCP servers page: the frame, and the body a composition registered for it. A fixture
// launch registers `fixtures/McpFixtureMount.tsx`; with nothing registered the frame stays empty.

import type { ReactNode } from "react";

import { findSettingsPageBody } from "../page-body-registry.js";

/** The MCP servers page: the registered body under the page heading. */
export function McpServersPage(): ReactNode {
  const Body = findSettingsPageBody("mcp-servers");
  return <div className="meridian-settings-page">{Body === undefined ? null : <Body />}</div>;
}
