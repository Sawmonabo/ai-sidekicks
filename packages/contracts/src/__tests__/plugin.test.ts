// The Browse plugins view reads catalogs and installs through the daemon, which
// answers from each provider's own plugin verbs. These cases hold what the view and
// the daemon both rely on: the two providers and no other, a source that names a
// repository with its commit, apps asked of Codex alone, and a connect link that
// opens only over https.
import { describe, expect, it } from "vitest";

import {
  PluginAppListRequestSchema,
  PluginAppListResponseSchema,
  PluginCatalogListRequestSchema,
  PluginCatalogListResponseSchema,
  PluginInstalledListRequestSchema,
  PluginMarketplaceAddRequestSchema,
  PluginMarketplaceRemoveRequestSchema,
  PluginReadResponseSchema,
  PluginRefSchema,
} from "../plugin.js";

const ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";

describe("plugin.catalogList", () => {
  it("accepts a filtered read and the design's catalog row", () => {
    expect(
      PluginCatalogListRequestSchema.safeParse({ provider: "claude", query: "review" }).success,
    ).toBe(true);
    expect(
      PluginCatalogListResponseSchema.safeParse({
        plugins: [
          {
            id: "pr-review-toolkit@claude-plugins-official",
            provider: "claude",
            name: "pr-review-toolkit",
            displayName: "PR review toolkit",
            description: "Agents that review a pull request.",
            marketplace: "claude-plugins-official",
            carries: { agents: 6, skills: 2, mcpServers: 1, hooks: 0 },
            installed: false,
            installedInTerminal: true,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("refuses a provider outside the two", () => {
    expect(PluginCatalogListRequestSchema.safeParse({ provider: "gemini" }).success).toBe(false);
  });
});

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

describe("the install and marketplace verbs", () => {
  it("accept the design's requests", () => {
    expect(PluginInstalledListRequestSchema.safeParse({}).success).toBe(true);
    expect(
      PluginMarketplaceAddRequestSchema.safeParse({
        provider: "claude",
        source: "https://github.com/example/team-tools",
      }).success,
    ).toBe(true);
    expect(
      PluginMarketplaceRemoveRequestSchema.safeParse({ provider: "codex", name: "team-tools" })
        .success,
    ).toBe(true);
  });
});

describe("plugin.appList", () => {
  it("accepts a Codex plugin's apps with a line per account", () => {
    expect(
      PluginAppListRequestSchema.safeParse({ provider: "codex", pluginId: "linear" }).success,
    ).toBe(true);
    expect(
      PluginAppListResponseSchema.safeParse({
        apps: [
          {
            appId: "linear",
            name: "Linear",
            accounts: [
              {
                providerAccountId: ACCOUNT_ID,
                linked: false,
                connectUrl: "https://chatgpt.com/apps/linear",
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("refuses apps asked of Claude Code", () => {
    expect(
      PluginAppListRequestSchema.safeParse({ provider: "claude", pluginId: "linear" }).success,
    ).toBe(false);
  });

  it("refuses a connect link that is not https", () => {
    expect(
      PluginAppListResponseSchema.safeParse({
        apps: [
          {
            appId: "linear",
            name: "Linear",
            accounts: [
              {
                providerAccountId: ACCOUNT_ID,
                linked: false,
                connectUrl: "javascript:alert(1)",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
