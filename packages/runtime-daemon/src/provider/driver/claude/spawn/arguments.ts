// The command line a Claude Code session process starts with: stream-json both ways with the
// person's messages replayed, every permission prompt sent to the daemon, the level's permission
// mode, the session's model and settings, the daemon's one tool server, and how the conversation
// starts.

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";

import type { ClaudeHttpServerEntry, ClaudePermissionMode } from "../session/transport.js";
import type { ClaudeSpawnSettings } from "./settings.js";

/**
 * The permission mode each level runs Claude Code in. Every process carries one, since without it
 * the process takes the person's own `permissions.defaultMode`.
 */
export const CLAUDE_PERMISSION_MODE_BY_LEVEL: Readonly<
  Record<PermissionLevel, ClaudePermissionMode>
> = Object.freeze({
  readonly: "default",
  ask: "acceptEdits",
  reviewed: "auto",
  sandboxed: "dontAsk",
  yolo: "bypassPermissions",
});

/** The mode a spawn at `level` runs in; a spawn naming no level runs at the most careful one's. */
export function resolveClaudePermissionMode(
  level: PermissionLevel | undefined,
): ClaudePermissionMode {
  return CLAUDE_PERMISSION_MODE_BY_LEVEL[level ?? "readonly"];
}

/**
 * How a spawn's conversation starts: a new one, a resume of one, a fork at one message, or one
 * kept nowhere, a throwaway copy of a conversation or a new one.
 */
export type ClaudeConversationStart =
  | { readonly kind: "new"; readonly providerSessionId: string }
  | { readonly kind: "unkept"; readonly resumeHandle: string | undefined }
  | { readonly kind: "resume"; readonly resumeHandle: string }
  | {
      readonly kind: "fork";
      readonly resumeHandle: string;
      /** The id the fork is pinned to, so the transport knows it before any turn. */
      readonly forkedProviderSessionId: string;
      readonly resumeAtMessageUuid: string;
    };

/** What one spawn's command line is composed from. */
export interface ClaudeArgumentsRequest {
  readonly model: string;
  readonly level: PermissionLevel | undefined;
  readonly settings: ClaudeSpawnSettings;
  /**
   * The daemon's one tool server entry, on the session's tool route; `undefined` while no route is
   * registered, and then the process loads no tool server at all.
   */
  readonly toolServer: { readonly name: string; readonly entry: ClaudeHttpServerEntry } | undefined;
  readonly outputSchema: Record<string, unknown> | undefined;
  /** Whether the session's `Helpers at once` is zero, so the helper tool is not offered at all. */
  readonly withholdsHelperTool: boolean;
  readonly conversation: ClaudeConversationStart;
}

function composeConversationArguments(conversation: ClaudeConversationStart): string[] {
  switch (conversation.kind) {
    case "new":
      return ["--session-id", conversation.providerSessionId];
    case "resume":
      return ["--resume", conversation.resumeHandle];
    case "unkept":
      return conversation.resumeHandle === undefined
        ? ["--no-session-persistence"]
        : ["--resume", conversation.resumeHandle, "--fork-session", "--no-session-persistence"];
    case "fork":
      return [
        "--resume",
        conversation.resumeHandle,
        "--fork-session",
        "--session-id",
        conversation.forkedProviderSessionId,
        "--resume-session-at",
        conversation.resumeAtMessageUuid,
      ];
  }
}

/**
 * The arguments after the executable. No budget cap, background run, auto-mode opt-in or
 * prompt opt-out is ever passed, and only the daemon's tool server is loaded.
 */
export function composeClaudeArguments(request: ClaudeArgumentsRequest): string[] {
  const outputSchema = request.outputSchema;
  const outputSchemaArguments =
    outputSchema === undefined ? [] : ["--json-schema", JSON.stringify(outputSchema)];
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    // Streams each response as `stream_event` frames, so its text is stored as it is written.
    "--include-partial-messages",
    // Sends every permission prompt to the daemon as `can_use_tool`; it is also what offers the
    // question tool to a headless process.
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    resolveClaudePermissionMode(request.level),
    "--model",
    request.model,
    "--settings",
    JSON.stringify(request.settings),
    "--mcp-config",
    JSON.stringify({
      mcpServers:
        request.toolServer === undefined
          ? {}
          : { [request.toolServer.name]: request.toolServer.entry },
    }),
    "--strict-mcp-config",
    ...composeConversationArguments(request.conversation),
    ...outputSchemaArguments,
    // The wire names the helper tool `Agent` while `system/init` advertises it as `Task`.
    ...(request.withholdsHelperTool ? ["--disallowedTools", "Agent", "Task"] : []),
  ];
}
