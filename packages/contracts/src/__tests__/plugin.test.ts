// A plugin's source that names a repository also names the commit it was fetched at, so what
// was installed can always be traced to exact code.
import { describe, expect, it } from "vitest";

import { PluginReadResponseSchema, PluginRefSchema } from "../plugin.js";

describe("plugin.read", () => {
  const ITEMS = {
    agents: [{ name: "code-reviewer", description: "Reviews a change." }],
    skills: [],
    mcpServers: [{ name: "github", description: null }],
    hooks: [{ name: "PreToolUse", description: null }],
  };

  it("accepts a plugin's items and a source fetched from a repository", () => {
    expect(PluginRefSchema.safeParse({ provider: "codex", id: "linear" }).success).toBe(true);
    expect(
      PluginReadResponseSchema.safeParse({
        items: ITEMS,
        source: {
          marketplace: "team-tools",
          repository: "https://github.com/example/team-tools",
          commit: "3f2a9c1",
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a repository with no commit", () => {
    expect(
      PluginReadResponseSchema.safeParse({
        items: ITEMS,
        source: { marketplace: "team-tools", repository: "https://github.com/example/team-tools" },
      }).success,
    ).toBe(false);
  });
});
