/**
 * Composes the settings a Claude session is spawned with: the callback tool server and the
 * sandbox.
 */

import type {
  ExecutionPosture,
  SessionCallbackTool,
} from "@ai-sidekicks/contracts/provider/driver/driver";
import { CLAUDE_SUPERVISED_ALLOWS_UNSANDBOXED_COMMANDS } from "./subagent-policy.js";

/** The server every callback tool is served under; the provider namespaces tools by server. */
const CLAUDE_CALLBACK_MCP_SERVER_NAME: string = "sessions";

/** Why the registry is withheld: the bound transport does not write the `--mcp-config` for it. */
export const CLAUDE_CALLBACK_TOOL_TRANSPORT_UNAVAILABLE_DETAIL: string =
  "the bound Claude transport declares it does not realize the callback-tool --mcp-config " +
  "registration, so no invocation could arrive; the registry is withheld rather than offered " +
  "undeliverable";

/**
 * Composes the provider-facing name `mcp__<server>__<tool>`. It is never parsed back, since a tool
 * name containing the separator would be ambiguous; the descriptor carries a reverse map instead.
 */
function composeClaudeProviderToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** The daemon-hosted ephemeral MCP server one session's callback tools ride. */
export interface ClaudeCallbackMcpServerDescriptor {
  readonly serverName: string;
  /** The admitted registry, in registration order and de-duplicated by name. */
  readonly tools: readonly SessionCallbackTool[];
  /** Provider-facing name -> registry name. */
  readonly registryNamesByProviderName: ReadonlyMap<string, string>;
}

/** Builds the MCP descriptor for a registry; duplicate names collapse last-wins, like the host. */
export function composeClaudeCallbackMcpServer(
  tools: readonly SessionCallbackTool[],
): ClaudeCallbackMcpServerDescriptor {
  const admittedByName = new Map<string, SessionCallbackTool>();
  for (const tool of tools) {
    admittedByName.set(tool.name, tool);
  }
  const registryNamesByProviderName = new Map<string, string>();
  for (const name of admittedByName.keys()) {
    registryNamesByProviderName.set(
      composeClaudeProviderToolName(CLAUDE_CALLBACK_MCP_SERVER_NAME, name),
      name,
    );
  }
  return {
    serverName: CLAUDE_CALLBACK_MCP_SERVER_NAME,
    tools: [...admittedByName.values()],
    registryNamesByProviderName,
  };
}

/**
 * The `--settings` sandbox document one posture composes to; the transport resolves
 * `credentialPolicyRef` into `permissions.deny` `Read` rules beside the environment scrub, so the
 * driver never sees the denied names and the deny holds on both the filesystem and the environment.
 */
export interface ClaudeSandboxSettings {
  readonly sandbox: {
    readonly enabled: boolean;
    readonly failIfUnavailable: boolean;
    readonly allowUnsandboxedCommands: boolean;
    readonly filesystem: { readonly allowWrite: readonly string[] };
  };
  readonly credentialPolicyRef: string;
}

/**
 * Composes the sandbox settings document for a posture. Every permission level but `yolo` runs in
 * the sandbox, and `readonly` writes nowhere. `failIfUnavailable` is `true` on every level: a
 * sandboxed level must refuse to start rather than run unsandboxed. The credential policy is
 * handed over on every level.
 */
export function composeClaudeSandboxSettings(posture: ExecutionPosture): ClaudeSandboxSettings {
  const sandboxed = posture.mode !== "yolo";
  return {
    sandbox: {
      enabled: sandboxed,
      failIfUnavailable: true,
      allowUnsandboxedCommands: sandboxed ? CLAUDE_SUPERVISED_ALLOWS_UNSANDBOXED_COMMANDS : true,
      filesystem: {
        // Empty, not omitted: an omitted list asks for the provider's default.
        allowWrite: posture.mode === "readonly" ? [] : posture.writableRoots,
      },
    },
    credentialPolicyRef: posture.credentialPolicyRef,
  };
}
