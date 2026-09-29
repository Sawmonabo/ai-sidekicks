// The `mcp.*` wire the settings page and the daemon share. Every governance
// mutation carries a caller-minted idempotency key, so the daemon can replay a
// retried press from its receipt instead of applying it twice; the reconnect
// carries none. A binding keeps its scope rules on every request, a project
// binding never carries a secret value, and a read-back never invents trust facts
// the store did not answer.
import { describe, expect, it } from "vitest";

import {
  MCP_REQUEST_TEXT_MAX_LEN,
  McpGetResponseSchema,
  McpOauthLogoutRequestSchema,
  McpReconnectRequestSchema,
  McpRegistrySearchRequestSchema,
  McpRegistrySearchResponseSchema,
  McpSetEnabledRequestSchema,
  McpSetToolOverrideRequestSchema,
  McpSetTrustRequestSchema,
  McpUpsertServerRequestSchema,
} from "../mcp.js";

const PROJECT_BINDING = {
  provider: "codex",
  scope: "project",
  scopeRef: "/work/app",
  serverName: "docs",
} as const;
const PRESS_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const DIGEST = "b3:9f2c";

describe("MCP governance mutation requests", () => {
  it("refuses a mutation without an idempotency key", () => {
    expect(
      McpSetEnabledRequestSchema.safeParse({ ...PROJECT_BINDING, enabled: true }).success,
    ).toBe(false);
    expect(McpSetTrustRequestSchema.safeParse({ ...PROJECT_BINDING, trusted: true }).success).toBe(
      false,
    );
  });

  it("refuses a key that is not a UUID", () => {
    const request = { ...PROJECT_BINDING, clientIdempotencyKey: "press-1", enabled: true };
    expect(McpSetEnabledRequestSchema.safeParse(request).success).toBe(false);
  });

  it("accepts a local binding on Codex, whose local scope the daemon emulates", () => {
    const request = {
      ...PROJECT_BINDING,
      scope: "local",
      clientIdempotencyKey: PRESS_ID,
      trusted: true,
    };
    expect(McpSetTrustRequestSchema.safeParse(request).success).toBe(true);
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

  it("accepts a keyed mutation on a well-formed binding", () => {
    const enable = { ...PROJECT_BINDING, clientIdempotencyKey: PRESS_ID, enabled: false };
    const trust = { ...PROJECT_BINDING, clientIdempotencyKey: PRESS_ID, trusted: true };
    expect(McpSetEnabledRequestSchema.safeParse(enable).success).toBe(true);
    expect(McpSetTrustRequestSchema.safeParse(trust).success).toBe(true);
  });
});

describe("mcp.upsertServer", () => {
  const stdio = { transport: "stdio", command: "npx", args: ["-y", "docs-server"] } as const;

  it("accepts a user binding carrying environment values", () => {
    const request = {
      provider: "claude",
      scope: "user",
      serverName: "docs",
      clientIdempotencyKey: PRESS_ID,
      config: { ...stdio, env: { DOCS_TOKEN: "secret" } },
    };
    expect(McpUpsertServerRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses an environment or header value on a project binding", () => {
    const withEnv = {
      ...PROJECT_BINDING,
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
    expect(McpUpsertServerRequestSchema.safeParse(withEnv).success).toBe(false);
    expect(McpUpsertServerRequestSchema.safeParse(withHeader).success).toBe(false);
  });

  it("accepts a project binding that names its variables and carries no value", () => {
    const request = {
      ...PROJECT_BINDING,
      clientIdempotencyKey: PRESS_ID,
      config: {
        transport: "http",
        url: "https://docs.example.com/mcp",
        bearerTokenEnvVar: "DOCS_TOKEN",
      },
    };
    expect(McpUpsertServerRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses an address with credentials in it or a scheme other than http", () => {
    const withAddress = (url: string) => ({
      ...PROJECT_BINDING,
      clientIdempotencyKey: PRESS_ID,
      config: { transport: "http", url },
    });
    expect(
      McpUpsertServerRequestSchema.safeParse(withAddress("https://me:pw@docs.example.com/mcp"))
        .success,
    ).toBe(false);
    expect(
      McpUpsertServerRequestSchema.safeParse(withAddress("ftp://docs.example.com/mcp")).success,
    ).toBe(false);
  });

  it("refuses a command past the request bound", () => {
    const request = {
      ...PROJECT_BINDING,
      clientIdempotencyKey: PRESS_ID,
      config: { transport: "stdio", command: "x".repeat(MCP_REQUEST_TEXT_MAX_LEN + 1) },
    };
    expect(McpUpsertServerRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("tool overrides, sign-out, reconnect and the registry search", () => {
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

  it("signs out of a server by its address, not a binding", () => {
    expect(
      McpOauthLogoutRequestSchema.safeParse({ serverId: "https://docs.example.com/mcp" }).success,
    ).toBe(true);
    expect(McpOauthLogoutRequestSchema.safeParse({ serverId: "docs" }).success).toBe(false);
    expect(McpOauthLogoutRequestSchema.safeParse(PROJECT_BINDING).success).toBe(false);
  });

  it("reconnects without a key and refuses one", () => {
    expect(
      McpReconnectRequestSchema.safeParse({ ...PROJECT_BINDING, sessionId: SESSION_ID }).success,
    ).toBe(true);
    expect(
      McpReconnectRequestSchema.safeParse({ ...PROJECT_BINDING, clientIdempotencyKey: PRESS_ID })
        .success,
    ).toBe(false);
  });

  it("searches the registry by query and answers a page of servers", () => {
    expect(McpRegistrySearchRequestSchema.safeParse({ query: "github" }).success).toBe(true);
    expect(McpRegistrySearchRequestSchema.safeParse({ cursor: "next" }).success).toBe(false);
    const page = {
      servers: [
        {
          name: "io.github.example/docs",
          description: "Searches the docs.",
          version: "1.2.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/docs-server",
              runtimeHint: "npx",
              runtimeArguments: ["-y"],
            },
          ],
          remotes: [],
          environmentVariables: [{ name: "DOCS_TOKEN", isRequired: true }],
        },
      ],
      nextCursor: "page-2",
    };
    expect(McpRegistrySearchResponseSchema.safeParse(page).success).toBe(true);
  });
});

describe("the inventory entry", () => {
  const base = {
    ...PROJECT_BINDING,
    effectiveInRuns: true,
    config: { transport: "stdio", command: "npx" },
    status: "connected",
    scopeRefDigest: DIGEST,
  };
  const trusted = { enabled: true, trusted: true, configHash: DIGEST, toolOverrides: [] };

  it("serves the trusted arm and the arm whose trust store did not answer", () => {
    expect(McpGetResponseSchema.safeParse({ server: { ...base, ...trusted } }).success).toBe(true);
    expect(
      McpGetResponseSchema.safeParse({ server: { ...base, trustUnavailable: true } }).success,
    ).toBe(true);
  });

  it("refuses a trust verdict on an entry whose trust store did not answer", () => {
    const invented = { ...base, trustUnavailable: true, trusted: false };
    expect(McpGetResponseSchema.safeParse({ server: invented }).success).toBe(false);
  });

  it("carries a failure reason only on a failed server", () => {
    const failed = { ...base, ...trusted, status: "failed", failedReason: "commandNotRunnable" };
    expect(McpGetResponseSchema.safeParse({ server: failed }).success).toBe(true);
    expect(
      McpGetResponseSchema.safeParse({ server: { ...failed, status: "connected" } }).success,
    ).toBe(false);
  });
});
