// Codex per-tool metadata: a tool authored without an `idempotency_class`, and any MCP-discovered
// tool whatever its annotations claim, floors at `manual_reconcile_only`, so it is never retried.

import type { NormalizedProviderToolMetadata } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { CODEX_TOOL_METADATA, classifyMcpDiscoveredTool } from "../tools.js";
import type { CodexToolName } from "../tools.js";

// Tools authored without an `idempotency_class`; they reach the floor through
// `closeCodexToolDeclaration`. Restated here so the test does not echo the module.
const EXPECTED_FLOOR_TOOLS: readonly CodexToolName[] = [
  "commandExecution",
  "fileChange",
  "collabAgentToolCall",
  "imageGeneration",
];

function findTool(name: string): NormalizedProviderToolMetadata {
  const tool = CODEX_TOOL_METADATA.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Codex tool metadata is missing an expected entry: ${name}`);
  }
  return tool;
}

describe("Codex tool metadata declaration", () => {
  it("closes unannotated (mutating) tools to manual_reconcile_only", () => {
    for (const name of EXPECTED_FLOOR_TOOLS) {
      expect(findTool(name).idempotency_class).toBe("manual_reconcile_only");
    }
  });
});

describe("Codex MCP idempotency floor", () => {
  it("never lets readOnlyHint or idempotentHint self-claims upgrade the class", () => {
    // MCP tool annotations are untrusted; a server advertising itself as maximally safe still
    // lands on the floor.
    expect(
      classifyMcpDiscoveredTool({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      }),
    ).toBe("manual_reconcile_only");
  });
});
