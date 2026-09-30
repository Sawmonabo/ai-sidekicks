// The `mcp.*` wire the settings page and the daemon share. A project binding travels with the
// repository, so it never carries a secret value; a server address carries no credentials; a tool
// override sets something; and a read-back never invents trust facts the store did not answer.
import { describe, expect, it } from "vitest";

import {
  McpGetResponseSchema,
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
const DIGEST = "b3:9f2c";

describe("mcp.upsertServer", () => {
  const stdio = { transport: "stdio", command: "npx", args: ["-y", "docs-server"] } as const;

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
