/**
 * Plan-005 T3.9 — Claude tool metadata (I-005-3).
 *
 * These tests drive THIS module's closing helper, deliberately not the
 * contract's `ProviderToolMetadataSchema` default: the schema's
 * `.optional().default("manual_reconcile_only")` is a second, independent
 * application of the same rule at the write seam, and asserting on it would
 * prove the contract works while proving nothing about the driver.
 */

import { describe, expect, it } from "vitest";

import {
  ProviderToolMetadataSchema,
  type IdempotencyClass,
  type ProviderToolMetadata,
} from "@ai-sidekicks/contracts";

import {
  CLAUDE_TOOL_CATALOG,
  CLAUDE_TOOL_DECLARATIONS,
  DEFAULT_CLAUDE_TOOL_IDEMPOTENCY_CLASS,
  MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS,
  classifyMcpDiscoveredTool,
  closeToolIdempotencyClass,
  closeToolIdempotencyClasses,
  extractMcpTaskId,
  getClaudeToolMetadata,
  normalizeClaudeMcpListProbeOutput,
  normalizeClaudeMcpServerInitCensus,
  observeMcpTaskAcceptance,
} from "../tools.js";
import type { McpTaskHandleObservation } from "../tools.js";

const RECOGNIZED_CLASSES: readonly IdempotencyClass[] = [
  "idempotent",
  "compensable",
  "manual_reconcile_only",
];

describe("Claude tool metadata — the conservative default (I-005-3)", () => {
  it("fixes the default at manual_reconcile_only", () => {
    expect(DEFAULT_CLAUDE_TOOL_IDEMPOTENCY_CLASS).toBe("manual_reconcile_only");
  });

  it("closes an unannotated declaration to the floor", () => {
    const closed = closeToolIdempotencyClass({ name: "SomeUnannotatedTool" });
    expect(closed).toStrictEqual({
      name: "SomeUnannotatedTool",
      idempotency_class: "manual_reconcile_only",
    });
  });

  it("closes an explicitly-undefined class to the floor", () => {
    const closed = closeToolIdempotencyClass({
      name: "SomeUnannotatedTool",
      idempotency_class: undefined,
    });
    expect(closed.idempotency_class).toBe("manual_reconcile_only");
  });

  it("floors an UNRECOGNIZED class rather than passing it through or throwing", () => {
    // The static type is erased at runtime; T3.13 routes MCP-discovered tools
    // through this helper, so an out-of-vocabulary value is reachable. A value
    // outside the vocabulary declares nothing, so it takes absence's treatment.
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
  });

  it("preserves an explicitly-declared recognized class", () => {
    const closed = closeToolIdempotencyClass({ name: "Read", idempotency_class: "idempotent" });
    expect(closed.idempotency_class).toBe("idempotent");
  });

  it("never mutates the caller's declaration and never shares its reference", () => {
    const declaration: ProviderToolMetadata = { name: "Bash" };
    const closed = closeToolIdempotencyClass(declaration);
    expect(declaration.idempotency_class).toBeUndefined();
    expect(Object.is(closed, declaration)).toBe(false);
  });

  it("carries a description only when one was declared", () => {
    const withDescription = closeToolIdempotencyClass({
      name: "Described",
      description: "provider-supplied text",
    });
    expect(withDescription.description).toBe("provider-supplied text");

    const withoutDescription = closeToolIdempotencyClass({ name: "Undescribed" });
    expect(Object.hasOwn(withoutDescription, "description")).toBe(false);
  });

  it("closes a whole table, preserving order and length", () => {
    const closed = closeToolIdempotencyClasses([
      { name: "Alpha", idempotency_class: "idempotent" },
      { name: "Beta" },
    ]);
    expect(closed.map((tool) => tool.name)).toStrictEqual(["Alpha", "Beta"]);
    expect(closed.map((tool) => tool.idempotency_class)).toStrictEqual([
      "idempotent",
      "manual_reconcile_only",
    ]);
  });
});

describe("Claude tool catalog", () => {
  it("keeps the floor LOAD-BEARING on shipped declarations", () => {
    // Guards against a vacuous version of the test above: if every shipped
    // declaration were annotated, the default would be untested in production
    // data. At least one real Claude tool must rely on it, and every such
    // tool must appear floored in the catalog.
    const unannotated = CLAUDE_TOOL_DECLARATIONS.filter(
      (declaration) => declaration.idempotency_class === undefined,
    );
    expect(unannotated.length).toBeGreaterThan(0);
    for (const declaration of unannotated) {
      const entry = CLAUDE_TOOL_CATALOG.find((tool) => tool.name === declaration.name);
      expect(entry?.idempotency_class).toBe("manual_reconcile_only");
    }
  });

  it("classifies every entry with a recognized class", () => {
    expect(CLAUDE_TOOL_CATALOG.length).toBe(CLAUDE_TOOL_DECLARATIONS.length);
    for (const tool of CLAUDE_TOOL_CATALOG) {
      expect(RECOGNIZED_CLASSES).toContain(tool.idempotency_class);
    }
  });

  it("annotates exactly the pure local reads as idempotent", () => {
    // Spec-005 §Tool Metadata defines `idempotent` as a pure read. Adding a
    // name here is a decision to re-execute that tool during recovery.
    const idempotent = CLAUDE_TOOL_CATALOG.filter(
      (tool) => tool.idempotency_class === "idempotent",
    ).map((tool) => tool.name);
    expect(idempotent.slice().sort()).toStrictEqual(["Glob", "Grep", "Read"]);
  });

  it("declares no compensable tool (no Claude built-in honors a dedupe_key)", () => {
    expect(CLAUDE_TOOL_CATALOG.some((tool) => tool.idempotency_class === "compensable")).toBe(
      false,
    );
  });

  it("floors every effectful tool, including the plausible-but-unproven ones", () => {
    for (const name of ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "TodoWrite", "Task"]) {
      const entry = CLAUDE_TOOL_CATALOG.find((tool) => tool.name === name);
      expect(entry, `${name} must be catalogued`).toBeDefined();
      expect(entry?.idempotency_class, `${name} must floor`).toBe("manual_reconcile_only");
    }
  });

  it("declares no duplicate tool names (the write seam rejects duplicates)", () => {
    const names = CLAUDE_TOOL_CATALOG.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is accepted verbatim by the contract's tool-metadata schema", () => {
    // The write seam parses each entry; a name that violates the contract's
    // bounds would be rejected there, so it must be rejected here first.
    for (const tool of CLAUDE_TOOL_CATALOG) {
      const parsed = ProviderToolMetadataSchema.safeParse(tool);
      expect(parsed.success, `${tool.name} must parse`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.idempotency_class).toBe(tool.idempotency_class);
      }
    }
  });

  it("is frozen at both levels, so a reader cannot re-class a tool process-wide", () => {
    expect(Object.isFrozen(CLAUDE_TOOL_CATALOG)).toBe(true);
    expect(Object.isFrozen(CLAUDE_TOOL_DECLARATIONS)).toBe(true);
    for (const tool of CLAUDE_TOOL_CATALOG) {
      expect(Object.isFrozen(tool)).toBe(true);
    }
    for (const declaration of CLAUDE_TOOL_DECLARATIONS) {
      expect(Object.isFrozen(declaration)).toBe(true);
    }
  });

  it("hands out fresh, mutable rows through getClaudeToolMetadata()", () => {
    // `GetCapabilitiesResult.tools` is mutable on the contract, so the accessor
    // — not the constant — is what may cross the driver boundary.
    const first = getClaudeToolMetadata();
    const second = getClaudeToolMetadata();

    expect(first).toStrictEqual([...CLAUDE_TOOL_CATALOG]);
    expect(Object.is(first, second)).toBe(false);
    for (const [index, tool] of first.entries()) {
      expect(Object.isFrozen(tool)).toBe(false);
      expect(Object.is(tool, CLAUDE_TOOL_CATALOG[index])).toBe(false);
    }

    first[0] = { name: "Corrupted", idempotency_class: "idempotent" };
    expect(second[0]?.name).not.toBe("Corrupted");
    expect(CLAUDE_TOOL_CATALOG[0]?.name).not.toBe("Corrupted");
  });

  it("carries no daemon-invented descriptions", () => {
    for (const tool of CLAUDE_TOOL_CATALOG) {
      expect(Object.hasOwn(tool, "description")).toBe(false);
    }
  });
});

// ==========================================================================
// T3.13 — MCP idempotency floor + dormant task-handle seam + status census
// ==========================================================================

describe("Claude MCP idempotency floor (T3.13 P2-7)", () => {
  it("classifies an MCP-discovered tool manual_reconcile_only with no annotations", () => {
    expect(classifyMcpDiscoveredTool()).toBe("manual_reconcile_only");
  });

  it("LOAD-BEARING NEGATIVE: readOnlyHint/idempotentHint self-claims never upgrade the class", () => {
    expect(
      classifyMcpDiscoveredTool({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      }),
    ).toBe("manual_reconcile_only");
  });

  it("pins the MCP floor constant to the spec value and the driver default", () => {
    expect(MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS).toBe("manual_reconcile_only");
    expect(MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS).toBe(DEFAULT_CLAUDE_TOOL_IDEMPOTENCY_CLASS);
  });

  it("composes with the closing helper: an MCP row carrying a floor class stays floored", () => {
    // The classifier is the ONLY source of MCP classes, and the closing
    // helper it composes with never widens — belt and braces at two seams.
    const closed = closeToolIdempotencyClass({
      name: "mcp_probe_tool",
      idempotency_class: classifyMcpDiscoveredTool({ readOnlyHint: true }),
    });
    expect(closed.idempotency_class).toBe("manual_reconcile_only");
  });
});

describe("Claude durable MCP task-handle seam (T3.13 observation, T5.1 active)", () => {
  it("extracts the receiver-generated taskId from a CreateTaskResult acceptance", () => {
    expect(extractMcpTaskId({ task: { taskId: "task-123" } })).toBe("task-123");
  });

  it("yields undefined for every non-acceptance shape (the halt default)", () => {
    expect(extractMcpTaskId(undefined)).toBeUndefined();
    expect(extractMcpTaskId(null)).toBeUndefined();
    expect(extractMcpTaskId({})).toBeUndefined();
    expect(extractMcpTaskId({ task: {} })).toBeUndefined();
    expect(extractMcpTaskId({ task: { taskId: "" } })).toBeUndefined();
    expect(extractMcpTaskId({ task: { taskId: 7 } })).toBeUndefined();
  });

  it("hands the sink the dispatch identity with the handle, and nothing otherwise", () => {
    // `commandId` reaches the sink verbatim: it is the `command_receipts` row
    // the handle is written to, and the MCP identity pair names no row. The
    // handle-less dispatch calls nothing, leaving the column NULL and the
    // receipt on the manual_reconcile_only halt (I-005-3).
    const observations: McpTaskHandleObservation[] = [];
    const collectingSink = (observation: McpTaskHandleObservation): void => {
      observations.push(observation);
    };
    const dispatch = {
      commandId: "command-7",
      serverName: "filesystem",
      toolName: "read_file",
    } as const;
    observeMcpTaskAcceptance(collectingSink, dispatch, { task: { taskId: "task-9" } });
    observeMcpTaskAcceptance(collectingSink, dispatch, { task: {} });
    expect(observations).toEqual([
      {
        commandId: "command-7",
        serverName: "filesystem",
        toolName: "read_file",
        mcpTaskId: "task-9",
      },
    ]);
  });
});

describe("Claude MCP server-status census normalization (T3.13 P2-10-L1)", () => {
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

  it("emits unknown for a recognized line whose status text is unrecognized", () => {
    const result = normalizeClaudeMcpListProbeOutput("weird: cmd - ✦ Sparkling");
    expect(result.emissions).toEqual([{ serverName: "weird", status: "unknown" }]);
  });
});
