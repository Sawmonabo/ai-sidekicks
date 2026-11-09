// The key one MCP server binding is identified by on the MCP servers page.

import type { McpServerBindingRef } from "@ai-sidekicks/contracts/mcp/server";

import { structuralKey } from "#renderer/lib/structural-key.js";

/**
 * The string one binding is keyed by: its provider, scope, scope reference, the distribution its
 * project root is in where it names one, and server name, encoded through the console's one tuple
 * encoder so a separator inside a wire string cannot make two bindings collide.
 */
export function mcpBindingKeyOf(binding: McpServerBindingRef): string {
  switch (binding.scope) {
    case "user":
    case "managed":
      return structuralKey([binding.provider, binding.scope, binding.serverName]);
    case "project":
    case "local":
      return structuralKey(
        binding.place === undefined
          ? [binding.provider, binding.scope, binding.scopeRef, binding.serverName]
          : [
              binding.provider,
              binding.scope,
              binding.scopeRef,
              binding.place.distro,
              binding.serverName,
            ],
      );
    case "plugin":
    case "connector":
      return structuralKey([binding.provider, binding.scope, binding.scopeRef, binding.serverName]);
  }
}
