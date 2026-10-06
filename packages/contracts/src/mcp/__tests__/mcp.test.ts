// The `mcp.*` wire the settings page and the daemon share. A binding names a folder exactly at
// the scopes that have one, on both providers; every scope takes the values the person typed; a
// server address carries no credentials; a tool override sets something; and a read-back never
// invents facts the binding store did not answer.
import { describe, expect, it } from "vitest";

import {
  McpGetResponseSchema,
  McpOauthLoginResponseSchema,
  McpRemoveServerRequestSchema,
  McpSetEnabledRequestSchema,
  McpSetToolOverrideRequestSchema,
  McpUpsertServerRequestSchema,
} from "../mcp.js";

const PROJECT_BINDING = {
  provider: "codex",
  scope: "project",
  scopeRef: "/work/app",
  serverName: "docs",
} as const;
const PRESS_ID = "11111111-1111-4111-8111-111111111111";

describe("the binding a mutation names", () => {
  it("accepts a local binding on Codex, whose local scope the daemon emulates", () => {
    const request = {
      ...PROJECT_BINDING,
      scope: "local",
      clientIdempotencyKey: PRESS_ID,
      enabled: true,
    };
    expect(McpSetEnabledRequestSchema.safeParse(request).success).toBe(true);
  });

  it("switches a plugin's server but never writes or removes its declaration", () => {
    const plugin = { ...PROJECT_BINDING, scope: "plugin", scopeRef: "docs-kit" };
    const keyed = { ...plugin, clientIdempotencyKey: PRESS_ID };
    const config = { transport: "stdio", command: "npx", args: [] };
    expect(McpSetEnabledRequestSchema.safeParse({ ...keyed, enabled: false }).success).toBe(true);
    expect(McpUpsertServerRequestSchema.safeParse({ ...keyed, config }).success).toBe(false);
    expect(McpRemoveServerRequestSchema.safeParse(keyed).success).toBe(false);
    expect(
      McpUpsertServerRequestSchema.safeParse({ ...keyed, scope: "local", config }).success,
    ).toBe(true);
  });

  it("refuses a user binding that names a folder", () => {
    const request = {
      ...PROJECT_BINDING,
      scope: "user",
      clientIdempotencyKey: PRESS_ID,
      enabled: true,
    };
    expect(McpSetEnabledRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("mcp.upsertServer", () => {
  const stdio = { transport: "stdio", command: "npx", args: ["-y", "docs-server"] } as const;

  it("accepts environment and header values on a user and a project binding", () => {
    const withEnv = {
      provider: "claude",
      scope: "user",
      serverName: "docs",
      clientIdempotencyKey: PRESS_ID,
      config: { ...stdio, env: { DOCS_TOKEN: "secret" } },
    };
    const withHeader = {
      ...PROJECT_BINDING,
      clientIdempotencyKey: PRESS_ID,
      config: {
        transport: "http",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: "Bearer secret" },
      },
    };
    expect(McpUpsertServerRequestSchema.safeParse(withEnv).success).toBe(true);
    expect(McpUpsertServerRequestSchema.safeParse({ ...withEnv, ...PROJECT_BINDING }).success).toBe(
      true,
    );
    expect(McpUpsertServerRequestSchema.safeParse(withHeader).success).toBe(true);
  });

  it("refuses an address whose scheme is not http", () => {
    const withAddress = (url: string) => ({
      ...PROJECT_BINDING,
      clientIdempotencyKey: PRESS_ID,
      config: { transport: "http", url },
    });
    expect(
      McpUpsertServerRequestSchema.safeParse(withAddress("ftp://docs.example.com/mcp")).success,
    ).toBe(false);
  });
});

describe("mcp.setToolOverride", () => {
  it("refuses a tool override that sets no facet", () => {
    const request = (override: object) => ({
      ...PROJECT_BINDING,
      clientIdempotencyKey: PRESS_ID,
      override,
    });
    expect(McpSetToolOverrideRequestSchema.safeParse(request({ toolName: "search" })).success).toBe(
      false,
    );
    expect(
      McpSetToolOverrideRequestSchema.safeParse(
        request({ toolName: "search", approvalMode: "prompt" }),
      ).success,
    ).toBe(true);
  });
});

describe("the inventory entry", () => {
  const base = {
    ...PROJECT_BINDING,
    config: { transport: "stdio", command: "npx" },
    status: "connected",
  };
  const answered = { enabled: true, tools: [] };

  it("serves the arm whose binding store answered and the arm whose store did not", () => {
    expect(McpGetResponseSchema.safeParse({ server: { ...base, ...answered } }).success).toBe(true);
    const plugin = { ...base, ...answered, scope: "plugin", scopeRef: "docs-kit" };
    expect(McpGetResponseSchema.safeParse({ server: plugin }).success).toBe(true);
    expect(
      McpGetResponseSchema.safeParse({ server: { ...base, bindingStoreUnavailable: true } })
        .success,
    ).toBe(true);
  });

  it("refuses tool readings on an entry whose binding store did not answer", () => {
    const invented = { ...base, bindingStoreUnavailable: true, tools: [] };
    expect(McpGetResponseSchema.safeParse({ server: invented }).success).toBe(false);
  });

  it("carries a failure reason only on a failed server", () => {
    const failed = { ...base, ...answered, status: "failed", failedReason: "commandNotRunnable" };
    expect(McpGetResponseSchema.safeParse({ server: failed }).success).toBe(true);
    expect(
      McpGetResponseSchema.safeParse({ server: { ...failed, status: "connected" } }).success,
    ).toBe(false);
  });
});

describe("mcp.oauthLogin", () => {
  it("refuses a sign-in page address that is not http or https", () => {
    const parse = (authorizationUrl: string) =>
      McpOauthLoginResponseSchema.safeParse({ authorizationUrl }).success;
    expect(parse("https://auth.example.test/authorize")).toBe(true);
    expect(parse("javascript:alert(1)")).toBe(false);
    expect(parse("file:///etc/passwd")).toBe(false);
  });
});
