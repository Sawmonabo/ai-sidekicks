// The hooks the daemon registers on the wire in each Claude Code process's `initialize`: each one
// is answered over the same channel as a `hook_callback`, so nothing is written to any settings
// file and the person's own hooks are untouched.

import { DAEMON_TOOL_SERVER_NAME } from "../../../tool-server-name.js";
import type { SubagentDefinition, SubagentPolicy } from "../../contract.js";
import { CLAUDE_QUESTION_TOOL_NAME } from "../event-normalizer.js";
import type {
  ClaudeAgentDefinition,
  ClaudeControlRequest,
  ClaudeHookMatcher,
} from "../session/transport.js";

/** The callback ids the daemon's hooks are registered under; each names what answers it. */
export const CLAUDE_HOOK_CALLBACK_IDS = {
  pauseBeforeTool: "sidekicks-pause-before-tool",
  pauseAfterBatch: "sidekicks-pause-after-batch",
  helperLimit: "sidekicks-helper-limit",
  questionBridge: "sidekicks-question-bridge",
  permissionDenied: "sidekicks-permission-denied",
} as const;

/**
 * How long Claude Code waits on a held callback, in seconds: one day. Without it a callback left
 * unanswered is canceled after Claude Code's own ten minutes.
 */
const CLAUDE_HOOK_HOLD_TIMEOUT_SECONDS = 86_400;

/**
 * The helper tool's name on the wire. The process's `system/init` advertises it as `Task`, but a
 * matcher written against that name never fires.
 */
const CLAUDE_HELPER_TOOL_NAME = "Agent";

// The question tool and every daemon tool, which at Sandboxed run only through this hook's allow.
const CLAUDE_DAEMON_TOOL_PATTERN = `mcp__${DAEMON_TOOL_SERVER_NAME}__.*`;
const CLAUDE_QUESTION_BRIDGE_MATCHER = `^(${CLAUDE_QUESTION_TOOL_NAME}|${CLAUDE_DAEMON_TOOL_PATTERN})$`;

/** The dialog kinds the daemon declares, by the choice each one asks the person. */
export const CLAUDE_DIALOG_KINDS = {
  refusal: "refusal_fallback_prompt",
  usageCredits: "fable_overage_consent_prompt",
} as const;

/** A subagent policy that holds new helpers to a number. */
export type ClaudeHelperLimitedPolicy = Extract<SubagentPolicy, { enabled: true }> & {
  helpersAtOnce: number;
};

/** Whether the session's policy holds new helpers to a number, so the helper hold is registered. */
export function limitsHelpersAtOnce(
  policy: SubagentPolicy | undefined,
): policy is ClaudeHelperLimitedPolicy {
  return policy?.enabled === true && policy.helpersAtOnce !== null;
}

/**
 * The `initialize` request a session's process is brought up with: the daemon's hooks, the
 * session's helper definitions, the two dialogs the console draws, and the per-task stop the
 * console offers.
 */
export function composeClaudeInitializeRequest(
  subagentPolicy: SubagentPolicy | undefined,
): Extract<ClaudeControlRequest, { subtype: "initialize" }> {
  const preToolUse: ClaudeHookMatcher[] = [
    {
      hookCallbackIds: [CLAUDE_HOOK_CALLBACK_IDS.pauseBeforeTool],
      timeout: CLAUDE_HOOK_HOLD_TIMEOUT_SECONDS,
    },
    {
      matcher: CLAUDE_QUESTION_BRIDGE_MATCHER,
      hookCallbackIds: [CLAUDE_HOOK_CALLBACK_IDS.questionBridge],
      timeout: CLAUDE_HOOK_HOLD_TIMEOUT_SECONDS,
    },
  ];
  if (limitsHelpersAtOnce(subagentPolicy)) {
    preToolUse.push({
      matcher: `^${CLAUDE_HELPER_TOOL_NAME}$`,
      hookCallbackIds: [CLAUDE_HOOK_CALLBACK_IDS.helperLimit],
      timeout: CLAUDE_HOOK_HOLD_TIMEOUT_SECONDS,
    });
  }
  return {
    subtype: "initialize",
    hooks: {
      PreToolUse: preToolUse,
      PostToolBatch: [{ hookCallbackIds: [CLAUDE_HOOK_CALLBACK_IDS.pauseAfterBatch] }],
      PermissionDenied: [{ hookCallbackIds: [CLAUDE_HOOK_CALLBACK_IDS.permissionDenied] }],
    },
    ...(subagentPolicy?.enabled === true && subagentPolicy.definitions.length > 0
      ? { agents: composeClaudeAgents(subagentPolicy.definitions) }
      : {}),
    supportedDialogKinds: Object.values(CLAUDE_DIALOG_KINDS),
    perTaskStopAffordance: true,
  };
}

// The helpers as Claude Code's `initialize` takes them; it refuses one with no description or prompt.
function composeClaudeAgents(
  definitions: readonly SubagentDefinition[],
): Record<string, ClaudeAgentDefinition> {
  const agents: Record<string, ClaudeAgentDefinition> = {};
  for (const definition of definitions) {
    agents[definition.name] = {
      description: definition.description,
      prompt: definition.prompt,
      ...(definition.model === undefined ? {} : { model: definition.model }),
      ...(definition.tools === undefined ? {} : { tools: definition.tools }),
      ...(definition.effort === undefined ? {} : { effort: definition.effort }),
      ...(definition.maxTurns === undefined ? {} : { maxTurns: definition.maxTurns }),
    };
  }
  return agents;
}
