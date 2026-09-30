// Claude tool metadata: only the pure local reads are idempotent, and an absent or unrecognized
// class floors at `manual_reconcile_only`, because recovery re-executes a tool its class calls
// safe. MCP server status comes from untrusted output.

import { describe, expect, it } from "vitest";

import type { ProviderToolMetadata } from "@ai-sidekicks/contracts";

import {
  CLAUDE_TOOL_CATALOG,
  closeToolIdempotencyClass,
  normalizeClaudeMcpListProbeOutput,
  normalizeClaudeMcpServerInitCensus,
} from "../tools.js";

describe("Claude tool metadata — the conservative default", () => {
  it("floors an absent, undefined, unrecognized or null class and keeps a recognized one", () => {
    expect(closeToolIdempotencyClass({ name: "SomeUnannotatedTool" })).toStrictEqual({
      name: "SomeUnannotatedTool",
      idempotency_class: "manual_reconcile_only",
    });
    expect(
      closeToolIdempotencyClass({ name: "SomeUnannotatedTool", idempotency_class: undefined })
        .idempotency_class,
    ).toBe("manual_reconcile_only");

    // Types are erased at runtime and MCP-discovered tools route through this helper, so an
    // out-of-vocabulary value is reachable. It declares nothing, so it floors like an absent one.
    const hostile = {
      name: "HostileTool",
      idempotency_class: "idempotent ",
    } as unknown as ProviderToolMetadata;
    expect(closeToolIdempotencyClass(hostile).idempotency_class).toBe("manual_reconcile_only");

    const nulled = {
      name: "NulledTool",
      idempotency_class: null,
    } as unknown as ProviderToolMetadata;
    expect(closeToolIdempotencyClass(nulled).idempotency_class).toBe("manual_reconcile_only");

    expect(
      closeToolIdempotencyClass({ name: "Read", idempotency_class: "idempotent" })
        .idempotency_class,
    ).toBe("idempotent");
  });
});

describe("Claude tool catalog", () => {
  it("annotates exactly the pure local reads as idempotent", () => {
    // `idempotent` means a pure read; adding a name here lets recovery re-execute that tool.
    const idempotent = CLAUDE_TOOL_CATALOG.filter(
      (tool) => tool.idempotency_class === "idempotent",
    ).map((tool) => tool.name);
    expect(idempotent.slice().sort()).toStrictEqual(["Glob", "Grep", "Read"]);
  });

  it("floors every effectful tool, including the plausible-but-unproven ones", () => {
    for (const name of ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "TodoWrite", "Task"]) {
      const entry = CLAUDE_TOOL_CATALOG.find((tool) => tool.name === name);
      expect(entry, `${name} must be cataloged`).toBeDefined();
      expect(entry?.idempotency_class, `${name} must floor`).toBe("manual_reconcile_only");
    }
  });
});

describe("Claude MCP server-status census normalization", () => {
  it("maps every recognized init-census status token into the unified enum", () => {
    const expectations: readonly (readonly [string, string])[] = [
      ["connected", "connected"],
      ["failed", "failed"],
      ["needs_auth", "needs-auth"],
      ["pending", "starting"],
      ["disabled", "unknown"],
    ];
    for (const [wireToken, unified] of expectations) {
      const result = normalizeClaudeMcpServerInitCensus([
        { name: "filesystem", status: wireToken },
      ]);
      expect(result.rejections).toEqual([]);
      expect(result.emissions).toEqual([{ serverName: "filesystem", status: unified }]);
    }
  });

  it("floors unrecognized or absent status tokens at unknown, never a healthy state", () => {
    expect(
      normalizeClaudeMcpServerInitCensus([{ name: "filesystem", status: "hibernating" }]).emissions,
    ).toEqual([{ serverName: "filesystem", status: "unknown" }]);
    expect(normalizeClaudeMcpServerInitCensus([{ name: "filesystem" }]).emissions).toEqual([
      { serverName: "filesystem", status: "unknown" },
    ]);
  });

  it("rejects rows failing the wire bound and keeps the rest", () => {
    const result = normalizeClaudeMcpServerInitCensus([
      { name: "a".repeat(129), status: "connected" },
      { name: "   ", status: "connected" },
      "not-an-object",
      { name: "healthy", status: "connected" },
    ]);
    expect(result.rejections).toHaveLength(3);
    expect(result.emissions).toEqual([{ serverName: "healthy", status: "connected" }]);
  });

  it("rejects a non-array census payload", () => {
    const result = normalizeClaudeMcpServerInitCensus({ filesystem: "connected" });
    expect(result.emissions).toEqual([]);
    expect(result.rejections).toHaveLength(1);
  });

  it("parses claude mcp list glyph lines into bounded emissions", () => {
    const probeOutput = [
      "Checking MCP server health...",
      "",
      "filesystem: npx -y @modelcontextprotocol/server-filesystem - ✓ Connected",
      "broken: some-command --flag - ✗ Failed to connect",
      "authy: another-command - ⚠ Needs authentication",
    ].join("\n");
    const result = normalizeClaudeMcpListProbeOutput(probeOutput);
    expect(result.rejections).toEqual([]);
    expect(result.emissions).toEqual([
      { serverName: "filesystem", status: "connected" },
      { serverName: "broken", status: "failed" },
      { serverName: "authy", status: "needs-auth" },
    ]);
  });

  it("reads the LAST separator, so a command containing ' - ' still parses", () => {
    const result = normalizeClaudeMcpListProbeOutput("srv: run --mode a - b - ✓ Connected");
    expect(result.emissions).toEqual([{ serverName: "srv", status: "connected" }]);
  });

  it("skips headers, prose, and blank lines without minting rejections", () => {
    const result = normalizeClaudeMcpListProbeOutput(
      ["MCP servers", "no separators here", "trailing - dash: but colon after separator"].join(
        "\n",
      ),
    );
    expect(result.emissions).toEqual([]);
    expect(result.rejections).toEqual([]);
  });
});
