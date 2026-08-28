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
  getCodexToolMetadata,
} from "../tools.js";
import type { CodexToolName } from "../tools.js";

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
