// The servers page's rail entry.

import { describe, expect, it } from "vitest";

import { registerMcpServersPage } from "./McpServersPage.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";

describe("the servers page — its rail entry", () => {
  it("claims the servers section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerMcpServersPage(registry);
    const descriptor = registry.descriptorFor("mcp-servers");
    expect(descriptor?.label).toBe("MCP servers");
    expect(descriptor?.keywords).toContain("model context protocol");
  });
});
