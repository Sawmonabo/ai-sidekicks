// T3.4 — Codex per-tool metadata declaration.
//
// Coverage targets (audit-derived, not just the plan ACs):
//   * `Spec-005 §Required Behavior` — a driver declares a per-tool
//     `idempotency_class` alongside its tool list.
//   * `Spec-005 §Tool Metadata` — an undeclared class is treated as
//     `manual_reconcile_only`.
//   * I-005-3 — the default is STRUCTURAL: nothing can leave this module
//     unclassified, and the driver-local floor is pinned to the contract's own
//     floor so the two cannot drift apart silently.

import { ProviderToolMetadataSchema } from "@ai-sidekicks/contracts";
import type { IdempotencyClass, NormalizedProviderToolMetadata } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  CODEX_TOOL_METADATA,
  CODEX_TOOL_NAMES,
  DEFAULT_CODEX_TOOL_IDEMPOTENCY_CLASS,
  DORMANT_MCP_TASK_HANDLE_SINK,
  MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS,
  classifyMcpDiscoveredTool,
  extractMcpTaskId,
  getCodexToolMetadata,
  normalizeCodexMcpServerStatusList,
  normalizeCodexMcpServerStatusNotification,
  observeMcpTaskAcceptance,
} from "../tools.js";
import type { CodexToolName, McpTaskHandleObservation } from "../tools.js";

// The tools authored WITHOUT an `idempotency_class`, which therefore reach the
// conservative floor through `closeCodexToolDeclaration`. Restated here
// independently of the module so the floor is proven, not echoed.
const EXPECTED_FLOOR_TOOLS: readonly CodexToolName[] = [
  "commandExecution",
  "fileChange",
  "collabAgentToolCall",
  "imageGeneration",
];

// The tools carrying an explicit non-default classification.
const EXPECTED_IDEMPOTENT_TOOLS: readonly CodexToolName[] = ["webSearch", "imageView", "sleep"];

function findTool(name: string): NormalizedProviderToolMetadata {
  const tool = CODEX_TOOL_METADATA.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Codex tool census is missing an expected entry: ${name}`);
  }
  return tool;
}

describe("Codex tool metadata declaration (T3.4)", () => {
  it("declares an idempotency_class for EVERY tool in the census (I-005-3)", () => {
    expect(CODEX_TOOL_METADATA.length).toBeGreaterThan(0);
    const permittedClasses: readonly IdempotencyClass[] = [
      "idempotent",
      "compensable",
      "manual_reconcile_only",
    ];
    for (const tool of CODEX_TOOL_METADATA) {
      expect(permittedClasses).toContain(tool.idempotency_class);
    }
  });

  it("closes unannotated (mutating) tools to manual_reconcile_only", () => {
    for (const name of EXPECTED_FLOOR_TOOLS) {
      expect(findTool(name).idempotency_class).toBe("manual_reconcile_only");
    }
  });

  it("carries the explicit idempotent classifications for the read-only tools", () => {
    for (const name of EXPECTED_IDEMPOTENT_TOOLS) {
      expect(findTool(name).idempotency_class).toBe("idempotent");
    }
  });

  it("pins the driver-local floor to the contract schema's own default", () => {
    // The floor exists at two boundaries: this module's closing helper
    // (authoring) and `ProviderToolMetadataSchema`'s `.optional().default(...)`
    // (the untyped write seam). If they ever disagree, a tool authored without
    // a class would persist a class the spec did not intend. Prove they agree
    // by driving the CONTRACT schema with an unannotated tool.
    const parsed = ProviderToolMetadataSchema.parse({ name: "unannotated_probe" });
    expect(parsed.idempotency_class).toBe(DEFAULT_CODEX_TOOL_IDEMPOTENCY_CLASS);
    expect(DEFAULT_CODEX_TOOL_IDEMPOTENCY_CLASS).toBe("manual_reconcile_only");
  });

  it("keeps CODEX_TOOL_NAMES and the emitted census in exact agreement", () => {
    // `CODEX_TOOL_NAMES` is the seam T3.5's normalizer imports. If it drifts
    // from what is actually declared, the normalizer resolves an identity that
    // has no `driver_tools` row and recovery dispatch silently misses.
    expect(CODEX_TOOL_METADATA.map((tool) => tool.name)).toEqual([...CODEX_TOOL_NAMES]);
    expect(new Set(CODEX_TOOL_NAMES).size).toBe(CODEX_TOOL_NAMES.length);
  });

  it("does NOT declare the MCP or dynamic-tool item arms (PR-B / session-registry boundary)", () => {
    // `mcpToolCall` rows are keyed by (server, tool) and are Plan-005 T3.13's;
    // `dynamicToolCall` classes come from the session callback-tool registry.
    // Declaring either here would assert a class for an identity no receipt
    // records. This assertion is the tripwire on that boundary.
    const declaredNames = CODEX_TOOL_METADATA.map((tool) => tool.name);
    expect(declaredNames).not.toContain("mcpToolCall");
    expect(declaredNames).not.toContain("dynamicToolCall");
    expect(declaredNames).not.toContain("subAgentActivity");
  });

  it("emits rows the T2.4 write seam accepts verbatim", () => {
    // `DriverCapabilitiesWriter.declare` runs each tool through this schema
    // before opening its transaction. A census entry that fails here would be
    // rejected at declaration time rather than caught in review.
    for (const tool of CODEX_TOOL_METADATA) {
      const parsed = ProviderToolMetadataSchema.safeParse(tool);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual(tool);
      }
    }
  });

  it("gives every tool an operator-readable description", () => {
    // An operator reconciling a halted `manual_reconcile_only` receipt reads
    // this string; an empty one makes the halt unactionable.
    for (const tool of CODEX_TOOL_METADATA) {
      expect(typeof tool.description).toBe("string");
      expect((tool.description ?? "").length).toBeGreaterThan(0);
    }
  });

  it("hands out fresh, independently-mutable rows on every call", () => {
    const first = getCodexToolMetadata();
    const second = getCodexToolMetadata();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);

    const mutableFirstEntry = first[0];
    expect(mutableFirstEntry).toBeDefined();
    if (mutableFirstEntry !== undefined) {
      mutableFirstEntry.idempotency_class = "idempotent";
      mutableFirstEntry.name = "mutated";
      // Prove the write LANDED. Without this, "the mutation did not leak" and
      // "the row was frozen so the mutation never happened" are the same
      // passing test — and the caller-facing promise is that these rows ARE
      // mutable, since `GetCapabilitiesResult.tools` is a mutable array.
      expect(mutableFirstEntry.name).toBe("mutated");
      expect(mutableFirstEntry.idempotency_class).toBe("idempotent");
    }
    // Neither the frozen census nor a later call observes the mutation.
    expect(getCodexToolMetadata()).toEqual(second);
    expect(CODEX_TOOL_METADATA.map((tool) => tool.name)).toEqual([...CODEX_TOOL_NAMES]);
  });

  it("freezes the exported census so a reader cannot corrupt later declarations", () => {
    expect(Object.isFrozen(CODEX_TOOL_METADATA)).toBe(true);
    for (const tool of CODEX_TOOL_METADATA) {
      expect(Object.isFrozen(tool)).toBe(true);
    }
  });
});

// ==========================================================================
// T3.13 — MCP idempotency floor + dormant task-handle seam + status census
// ==========================================================================

describe("Codex MCP idempotency floor (T3.13 P2-7)", () => {
  it("classifies an MCP-discovered tool manual_reconcile_only with no annotations", () => {
    expect(classifyMcpDiscoveredTool()).toBe("manual_reconcile_only");
    expect(classifyMcpDiscoveredTool(undefined)).toBe("manual_reconcile_only");
  });

  it("LOAD-BEARING NEGATIVE: readOnlyHint/idempotentHint self-claims never upgrade the class", () => {
    // MCP 2025-11-25 binds clients to treat ToolAnnotations as untrusted;
    // Spec-005 §Tool Metadata forbids deriving the class from them. A server
    // advertising itself maximally safe still lands on the floor.
    expect(
      classifyMcpDiscoveredTool({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      }),
    ).toBe("manual_reconcile_only");
  });

  it("pins the MCP floor constant to the spec value and to the driver default", () => {
    // Same VALUE as the unannotated-builtin default, by spec — but a distinct
    // RULE (always, vs default-when-absent). The identity is pinned so a
    // divergence in either direction is loud.
    expect(MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS).toBe("manual_reconcile_only");
    expect(MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS).toBe(DEFAULT_CODEX_TOOL_IDEMPOTENCY_CLASS);
  });
});

describe("Codex dormant MCP task-handle seam (T3.13, T5.1 activates)", () => {
  it("extracts the receiver-generated taskId from a CreateTaskResult acceptance", () => {
    expect(extractMcpTaskId({ task: { taskId: "task-123" } })).toBe("task-123");
  });

  it("yields undefined for every non-acceptance shape (the halt default)", () => {
    expect(extractMcpTaskId(undefined)).toBeUndefined();
    expect(extractMcpTaskId(null)).toBeUndefined();
    expect(extractMcpTaskId("task-123")).toBeUndefined();
    expect(extractMcpTaskId({})).toBeUndefined();
    expect(extractMcpTaskId({ task: null })).toBeUndefined();
    expect(extractMcpTaskId({ task: {} })).toBeUndefined();
    expect(extractMcpTaskId({ task: { taskId: "" } })).toBeUndefined();
    expect(extractMcpTaskId({ task: { taskId: 42 } })).toBeUndefined();
  });

  it("calls the sink exactly once with the observation when a handle exists", () => {
    const observations: McpTaskHandleObservation[] = [];
    observeMcpTaskAcceptance(
      (observation) => observations.push(observation),
      "filesystem",
      "read_file",
      { task: { taskId: "task-9" } },
    );
    expect(observations).toEqual([
      { serverName: "filesystem", toolName: "read_file", mcpTaskId: "task-9" },
    ]);
  });

  it("never calls the sink when the acceptance carries no handle", () => {
    const observations: McpTaskHandleObservation[] = [];
    observeMcpTaskAcceptance(
      (observation) => observations.push(observation),
      "filesystem",
      "read_file",
      { task: {} },
    );
    expect(observations).toEqual([]);
  });

  it("ships a dormant sink that observes and discards", () => {
    // Dormancy is the CONTRACT until T5.1 lands the mcp_task_id ALTER: the
    // sink must be callable at the dispatch seam and must persist nothing.
    // (There is no store to probe — the assertion is that the call is inert.)
    expect(
      DORMANT_MCP_TASK_HANDLE_SINK({ serverName: "s", toolName: "t", mcpTaskId: "task-1" }),
    ).toBeUndefined();
  });
});

describe("Codex MCP server-status census normalization (T3.13 P2-10-L1)", () => {
  const listRow = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    name: "filesystem",
    authStatus: "oAuth",
    resourceTemplates: [],
    resources: [],
    tools: {},
    ...overrides,
  });

  it("maps every schema-published runtimeStatus into the unified enum", () => {
    const expectations: readonly (readonly [string, string])[] = [
      ["notStarted", "starting"],
      ["starting", "starting"],
      ["connected", "connected"],
      ["authenticationRequired", "needs-auth"],
      ["failed", "failed"],
      ["cancelled", "failed"],
      ["disabled", "unknown"],
    ];
    for (const [wireStatus, unified] of expectations) {
      const result = normalizeCodexMcpServerStatusList([listRow({ runtimeStatus: wireStatus })]);
      expect(result.rejections).toEqual([]);
      expect(result.emissions).toEqual([{ serverName: "filesystem", status: unified }]);
    }
  });

  it("falls back to authStatus only for the definite needs-auth observation", () => {
    // runtimeStatus null = "unavailable or the configuration changed". A
    // notLoggedIn authStatus is still a definite needs-auth fact; an auth
    // MODE (oAuth, bearerToken, unsupported) says nothing about liveness.
    const notLoggedIn = normalizeCodexMcpServerStatusList([
      listRow({ runtimeStatus: null, authStatus: "notLoggedIn" }),
    ]);
    expect(notLoggedIn.emissions).toEqual([{ serverName: "filesystem", status: "needs-auth" }]);

    for (const authStatus of ["unknown", "unsupported", "bearerToken", "oAuth"]) {
      const result = normalizeCodexMcpServerStatusList([
        listRow({ runtimeStatus: null, authStatus }),
      ]);
      expect(result.emissions).toEqual([{ serverName: "filesystem", status: "unknown" }]);
    }
  });

  it("floors an unrecognized runtimeStatus at unknown, never a healthy state", () => {
    const result = normalizeCodexMcpServerStatusList([listRow({ runtimeStatus: "hibernating" })]);
    expect(result.emissions).toEqual([{ serverName: "filesystem", status: "unknown" }]);
  });

  it("rejects rows whose serverName fails the wire bound and keeps the rest", () => {
    const result = normalizeCodexMcpServerStatusList([
      listRow({ name: "a".repeat(129), runtimeStatus: "connected" }),
      listRow({ name: "   ", runtimeStatus: "connected" }),
      listRow({ name: "with\0nul", runtimeStatus: "connected" }),
      listRow({ name: "healthy", runtimeStatus: "connected" }),
    ]);
    expect(result.rejections).toHaveLength(3);
    expect(result.emissions).toEqual([{ serverName: "healthy", status: "connected" }]);
  });

  it("rejects a non-array payload and non-object rows without dropping siblings", () => {
    expect(normalizeCodexMcpServerStatusList("nope").rejections).toHaveLength(1);
    expect(normalizeCodexMcpServerStatusList("nope").emissions).toEqual([]);

    const mixed = normalizeCodexMcpServerStatusList([42, listRow({ runtimeStatus: "connected" })]);
    expect(mixed.rejections).toHaveLength(1);
    expect(mixed.emissions).toEqual([{ serverName: "filesystem", status: "connected" }]);
  });

  it("maps every startup-notification state, including the reauth refinement", () => {
    const expectations: readonly (readonly [string, string])[] = [
      ["starting", "starting"],
      ["ready", "connected"],
      ["failed", "failed"],
      ["cancelled", "failed"],
    ];
    for (const [wireState, unified] of expectations) {
      const result = normalizeCodexMcpServerStatusNotification({
        name: "filesystem",
        status: wireState,
      });
      expect(result.emissions).toEqual([{ serverName: "filesystem", status: unified }]);
    }
    // failed + reauthenticationRequired is the one state an operator can fix;
    // collapsing it into `failed` would hide that from the census.
    const reauth = normalizeCodexMcpServerStatusNotification({
      name: "filesystem",
      status: "failed",
      failureReason: "reauthenticationRequired",
    });
    expect(reauth.emissions).toEqual([{ serverName: "filesystem", status: "needs-auth" }]);
  });

  it("floors unrecognized or absent notification states at unknown and rejects a missing name", () => {
    expect(
      normalizeCodexMcpServerStatusNotification({ name: "filesystem", status: "warming" })
        .emissions,
    ).toEqual([{ serverName: "filesystem", status: "unknown" }]);
    expect(normalizeCodexMcpServerStatusNotification({ name: "filesystem" }).emissions).toEqual([
      { serverName: "filesystem", status: "unknown" },
    ]);
    expect(normalizeCodexMcpServerStatusNotification({ status: "ready" }).rejections).toHaveLength(
      1,
    );
    expect(normalizeCodexMcpServerStatusNotification(null).rejections).toHaveLength(1);
  });
});
