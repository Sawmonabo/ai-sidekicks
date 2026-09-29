// The servers page's rail entry.

import { describe, expect, it } from "vitest";

import { composeSettingsPages } from "../../settings-pages.js";

describe("the servers page — its rail entry", () => {
  it("claims the servers section with a search vocabulary", () => {
    const registry = composeSettingsPages();
    const descriptor = registry.descriptorFor("mcp-servers");
    expect(descriptor?.label).toBe("MCP servers");
    expect(descriptor?.keywords).toContain("model context protocol");
  });
});
