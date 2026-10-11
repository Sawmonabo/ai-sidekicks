// The name both providers give a tool server's tool, at their hooks and in their permission rules.

/** The prefix that marks a tool as a tool server's, in every name both providers give one. */
export const TOOL_SERVER_TOOL_PREFIX = "mcp__";

/**
 * Composes `mcp__<server>__<tool>`. The server and the tool are never split back out of it, since
 * a tool name holding the separator would be ambiguous.
 */
export function composeToolServerToolName(serverName: string, toolName: string): string {
  return `${TOOL_SERVER_TOOL_PREFIX}${serverName}__${toolName}`;
}
