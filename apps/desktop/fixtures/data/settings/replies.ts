// What the machine-level settings pages are answered with, all in one list: each page's replies
// are the machine's, not a session's, so a scenario that plays a session spreads this list into its
// own replies.

import type { ScenarioReply } from "#renderer/services/daemon/scenario/reply.fixture.js";
import { MCP_SERVER_REPLIES } from "./mcp-servers.js";
import { PROVIDERS_PAGE_REPLIES } from "./providers.js";

/** Every call the MCP servers and Providers pages make, and what each is answered with. */
export const SETTINGS_REPLIES: readonly ScenarioReply[] = [
  ...MCP_SERVER_REPLIES,
  ...PROVIDERS_PAGE_REPLIES,
];
