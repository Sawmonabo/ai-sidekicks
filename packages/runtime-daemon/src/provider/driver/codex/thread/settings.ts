// The settings every Codex conversation is started, resumed and forked with: its folder, model,
// permission level and profile, base instructions, and a `config` carrying its model's window, the
// features it runs with, its tool servers, its connectors' defaults, its commands' environment, its
// helper limit and its helpers' role files. A resume and a fork send them all again, so a
// conversation never falls back to what Codex persisted.

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ToolServerRoute } from "../../../port/tool-server-route.js";
import type { CodexShellEnvironmentPolicy } from "../../../spawn-env.js";
import { DAEMON_TOOL_SERVER_NAME } from "../../../tool-server-name.js";
import type { SessionToolServer, SubagentPolicy } from "../../contract.js";
import type { CodexHelperRole } from "../session/helper-roles.js";
import {
  composeCodexConnectorDefaults,
  composeCodexLevelSettings,
  composeCodexPermissionConfig,
  type CodexProfileFolders,
} from "../permission-level.js";

/**
 * Seconds Codex waits on one call to the daemon's tool server: Codex's own default, above the
 * route's own bound, so the route answers first.
 */
const CODEX_DAEMON_TOOL_TIMEOUT_SECONDS = 300;

/** The largest helper count Codex accepts, sent where the person set no limit. */
const CODEX_UNLIMITED_HELPERS = "9223372036854775807";

// `JSON.rawJSON` keeps a 64-bit integer exact on the wire; the es2024 library types lack it.
const rawJson = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

/** Everything one conversation's thread settings are composed from. */
export interface CodexThreadSettings {
  readonly sessionId: SessionId;
  /** The conversation's working folder, absolute. */
  readonly workingDirectory: string;
  readonly model: string;
  /**
   * The larger window the session chose for its model, in tokens, sent as `model_context_window`;
   * `undefined` runs the model's default window and sends none.
   */
  readonly modelContextWindow: number | undefined;
  readonly level: PermissionLevel;
  readonly profileFolders: CodexProfileFolders;
  /** The environment each command the conversation runs receives. */
  readonly shellEnvironment: CodexShellEnvironmentPolicy;
  readonly subagentPolicy: SubagentPolicy | undefined;
  /** The role file of each helper the policy defines, written before the conversation starts. */
  readonly helperRoles: readonly CodexHelperRole[];
  /** Every tool server the session can reach, each with the person's switch. */
  readonly toolServers: readonly SessionToolServer[];
  /** The instructions the conversation runs under; sent on every start, resume and fork. */
  readonly baseInstructions: string | undefined;
}

/**
 * The members `thread/start`, `thread/resume` and `thread/fork` all carry for `settings`, without
 * the output speed, which the caller resolves per request. With no tool-server route registered
 * yet, the conversation reaches no tool server.
 */
export function composeCodexThreadParams(
  settings: CodexThreadSettings,
  route: ToolServerRoute | undefined,
): Record<string, unknown> {
  return {
    cwd: settings.workingDirectory,
    model: settings.model,
    ...composeCodexLevelSettings(settings.level, settings.profileFolders),
    ...(settings.baseInstructions === undefined
      ? {}
      : { baseInstructions: settings.baseInstructions }),
    config: {
      ...(settings.modelContextWindow === undefined
        ? {}
        : { model_context_window: settings.modelContextWindow }),
      "features.default_mode_request_user_input": true,
      model_reasoning_summary: "auto",
      // The task list tool is off unless enabled, and Codex reads the setting as a table.
      "tools.update_plan.enabled": true,
      ...composeHelperLimit(settings.subagentPolicy),
      ...composeHelperRoles(settings),
      mcp_servers: composeToolServers(settings, route),
      shell_environment_policy: settings.shellEnvironment,
      ...composeCodexLevelConfig(settings.level, settings.profileFolders),
    },
  };
}

/**
 * The `config` members a level sets, which only a start, resume or fork carries, so a level move
 * that changes them reaches the conversation through a fork.
 */
export function composeCodexLevelConfig(
  level: PermissionLevel,
  folders: CodexProfileFolders,
): Record<string, unknown> {
  return {
    ...composeCodexPermissionConfig(level, folders),
    ...composeCodexConnectorDefaults(level),
  };
}

/**
 * The helper limit: Codex counts the lead among the conversations at once, so N helpers is N + 1;
 * Codex refuses zero, so no helpers switches the feature off instead.
 */
function composeHelperLimit(policy: SubagentPolicy | undefined): Record<string, unknown> {
  if (policy === undefined || !policy.enabled) {
    return { "features.multi_agent_v2": false, "agents.enabled": false };
  }
  return {
    "features.multi_agent_v2": {
      enabled: true,
      max_concurrent_threads_per_session:
        policy.helpersAtOnce === null ? rawJson(CODEX_UNLIMITED_HELPERS) : policy.helpersAtOnce + 1,
    },
  };
}

/**
 * Each helper's entry as a nested `agents` table, which Codex merges with the roles the person's
 * own config defines and which carries any name, a dot included; the helper's instructions stay in
 * its file, so none reach the lead.
 */
function composeHelperRoles(settings: CodexThreadSettings): Record<string, unknown> {
  if (
    settings.subagentPolicy === undefined ||
    !settings.subagentPolicy.enabled ||
    settings.helperRoles.length === 0
  ) {
    return {};
  }
  const roles: Record<string, Record<string, string>> = {};
  for (const role of settings.helperRoles) {
    roles[role.name] = { description: role.description, config_file: role.configFile };
  }
  return { agents: roles };
}

/**
 * The whole `mcp_servers` table: every server on the daemon's route, each as switched; empty with
 * no route, so Codex adds none of its own config's.
 */
function composeToolServers(
  settings: CodexThreadSettings,
  route: ToolServerRoute | undefined,
): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  if (route === undefined) {
    return servers;
  }
  for (const toolServer of settings.toolServers) {
    servers[toolServer.serverName] = {
      url: route.urlFor(settings.sessionId, toolServer.serverName),
      enabled: toolServer.enabled,
    };
  }
  servers[DAEMON_TOOL_SERVER_NAME] = {
    url: route.urlFor(settings.sessionId, DAEMON_TOOL_SERVER_NAME),
    enabled: true,
    // The daemon judges each of its own calls itself, so Codex asks nothing first.
    default_tools_approval_mode: "approve",
    tool_timeout_sec: CODEX_DAEMON_TOOL_TIMEOUT_SECONDS,
  };
  return servers;
}
