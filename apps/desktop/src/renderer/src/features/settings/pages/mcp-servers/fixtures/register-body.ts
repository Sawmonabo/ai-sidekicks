import { registerSettingsPageBody } from "../../body-registry.js";
import { McpFixtureMount } from "./McpFixtureMount.js";

/**
 * Mount the MCP fixture body in the MCP servers page. Only a fixture launch's composition calls
 * it.
 */
export function registerMcpFixtureBody(): void {
  registerSettingsPageBody("mcp-servers", "mcp-servers-fixture", McpFixtureMount);
}
