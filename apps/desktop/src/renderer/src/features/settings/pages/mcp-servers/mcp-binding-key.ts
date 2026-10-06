// The key one MCP server binding is identified by on the MCP servers page.

import type { McpServerBindingRef } from "@ai-sidekicks/contracts/mcp/server";

import { structuralKey } from "#renderer/lib/structural-key.js";

/**
 * The string one binding is keyed by: its provider, scope, scope reference and server
 * name, encoded through the console's one tuple encoder so a separator inside a wire
 * string cannot make two bindings collide.
 */
export function mcpBindingKeyOf(binding: McpServerBindingRef): string {
  return structuralKey(
    binding.scope === "user"
      ? [binding.provider, binding.scope, binding.serverName]
      : [binding.provider, binding.scope, binding.scopeRef, binding.serverName],
  );
}
