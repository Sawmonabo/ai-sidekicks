/**
 * Composes the settings a Claude session is spawned with: the `--settings` document (retention,
 * the agent view switch, the permission rules and the Bash sandbox) and the daemon's tool server.
 */

import path from "node:path";

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionCallbackTool } from "@ai-sidekicks/contracts/provider/driver/tools";
import { CLAUDE_AGENT_VIEW_OFF_SETTINGS } from "../../../../orchestration/native-subagent-governor.js";
import { DAEMON_TOOL_SERVER_NAME } from "../../../tool-server-name.js";
import type { ClaudePermissionsDocument, ClaudeSpawnBoundLegs } from "../session/transport.js";

/**
 * How many days Claude Code keeps a conversation file before cleaning it up: long enough that a
 * session's own history never disappears under it. Written at every spawn and in each account home.
 */
export const CLAUDE_CLEANUP_PERIOD_DAYS = 36_500;

// The shell tool and the command its Reviewed ask rule names.
const CLAUDE_SHELL_TOOL_NAME = "Bash";
const CLAUDE_REMOVAL_COMMAND = "rm";

/** The ask rule held while a session is at Reviewed, so every removal reaches the daemon. */
const CLAUDE_REVIEWED_REMOVAL_ASK_RULE = `${CLAUDE_SHELL_TOOL_NAME}(${CLAUDE_REMOVAL_COMMAND} *)`;

/**
 * Whether a tool ask is a removal the Reviewed ask rule matches: the shell tool running a command
 * that starts with `rm` and its arguments. `input` is untrusted provider output.
 */
export function matchesClaudeReviewedRemovalRule(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): boolean {
  const command = input["command"];
  return (
    toolName === CLAUDE_SHELL_TOOL_NAME &&
    typeof command === "string" &&
    command.trimStart().startsWith(`${CLAUDE_REMOVAL_COMMAND} `)
  );
}

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

/** The daemon-hosted MCP server one session's callback tools ride. */
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
      composeClaudeProviderToolName(DAEMON_TOOL_SERVER_NAME, name),
      name,
    );
  }
  return {
    serverName: DAEMON_TOOL_SERVER_NAME,
    tools: [...admittedByName.values()],
    registryNamesByProviderName,
  };
}

/**
 * The Bash sandbox at Sandboxed. `allowUnsandboxedCommands` is never written, so the person's own
 * setting holds; `excludedCommands` is pinned empty, and a host whose sandbox cannot start refuses.
 */
export interface ClaudeSandboxSettings {
  readonly enabled: true;
  readonly failIfUnavailable: true;
  readonly excludedCommands: readonly string[];
  readonly filesystem: { readonly allowWrite: readonly string[] };
}

/**
 * The `--settings` document every Claude Code spawn carries. `advisorModel` is `""` when the
 * session's advisor is off, which outranks the person's own advisor, and `outputStyle` is absent
 * where the session chose none.
 */
export interface ClaudeSpawnSettings {
  readonly cleanupPeriodDays: number;
  readonly disableAgentView: true;
  readonly permissions: ClaudePermissionsDocument;
  readonly advisorModel: string;
  readonly outputStyle?: string;
  readonly sandbox?: ClaudeSandboxSettings;
}

/**
 * The advisor setting for a session's advisor, `null` when off: `""`, which Claude Code reads as no
 * advisor and which outranks the person's own advisor in their Claude Code settings.
 */
export function claudeAdvisorSetting(advisorModel: string | null): string {
  return advisorModel ?? "";
}

// A permission rule's absolute path is written with a leading `//`, which roots it at `/`.
function absolutePathRule(tool: "Read" | "Edit", absolutePath: string, glob: string): string {
  return `${tool}(/${path.join(absolutePath, glob)})`;
}

/**
 * The session's whole permission rules at `level`: the curated credential paths denied to every
 * file-reading tool, a shared `.git` root's `hooks/` and `config` denied to every editing tool, the
 * removal ask rule at Reviewed, and the memory folder's `.md` files allowed at Sandboxed.
 * `apply_flag_settings` replaces the document whole, so a level move resends all of it.
 */
export function composeClaudePermissions(
  legs: Pick<ClaudeSpawnBoundLegs, "credentialDenyPaths" | "memoryFolders">,
  writableRoots: readonly string[],
  level: PermissionLevel | undefined,
): ClaudePermissionsDocument {
  const deny = legs.credentialDenyPaths.map((denied) => absolutePathRule("Read", denied, "**"));
  for (const root of writableRoots) {
    // The shared `.git` folder of a linked worktree, which the sandbox lets Bash write except its
    // hooks and config; the editing tools get the same exclusions.
    if (path.basename(root) === ".git") {
      deny.push(
        absolutePathRule("Edit", root, "hooks/**"),
        absolutePathRule("Edit", root, "config"),
      );
    }
  }
  const allow =
    level === "sandboxed"
      ? legs.memoryFolders.flatMap((folder) => [
          absolutePathRule("Read", folder, "**/*.md"),
          absolutePathRule("Edit", folder, "**/*.md"),
        ])
      : [];
  return {
    allow,
    ask: level === "reviewed" ? [CLAUDE_REVIEWED_REMOVAL_ASK_RULE] : [],
    deny,
  };
}

/**
 * Composes the `--settings` document for a spawn at the session's current posture, advisor and
 * output style.
 */
export function composeClaudeSpawnSettings(
  legs: Pick<
    ClaudeSpawnBoundLegs,
    "credentialDenyPaths" | "memoryFolders" | "executionPosture" | "advisorModel" | "outputStyle"
  >,
): ClaudeSpawnSettings {
  const posture = legs.executionPosture;
  const settings: ClaudeSpawnSettings = {
    cleanupPeriodDays: CLAUDE_CLEANUP_PERIOD_DAYS,
    ...CLAUDE_AGENT_VIEW_OFF_SETTINGS,
    permissions: composeClaudePermissions(legs, posture?.writableRoots ?? [], posture?.mode),
    advisorModel: claudeAdvisorSetting(legs.advisorModel),
    ...(legs.outputStyle === null ? {} : { outputStyle: legs.outputStyle }),
  };
  if (posture?.mode !== "sandboxed") {
    return settings;
  }
  return { ...settings, sandbox: composeClaudeSandboxSettings(posture.writableRoots) };
}

/**
 * The Bash sandbox block at Sandboxed, writable in `writableRoots` alone: the spawn's `--settings`
 * carries it, and a live move into Sandboxed sends it by `apply_flag_settings {sandbox}`.
 */
export function composeClaudeSandboxSettings(
  writableRoots: readonly string[],
): ClaudeSandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    excludedCommands: [],
    filesystem: { allowWrite: writableRoots },
  };
}
