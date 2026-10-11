// The name both providers give a tool server's tool, at their hooks and in their permission rules.

/**
 * Composes `mcp__<server>__<tool>`. It is never parsed back, since a tool name holding the
 * separator would be ambiguous.
 */
export function composeToolServerToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}
