// Codex per-tool metadata: a tool authored without an `idempotency_class` floors at
// `manual_reconcile_only`, so it is never shown as safe to repeat.

import type { NormalizedProviderToolMetadata } from "@ai-sidekicks/contracts/provider/driver/tools";
import { describe, expect, it } from "vitest";

import { CODEX_TOOL_METADATA } from "../tools.js";
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
