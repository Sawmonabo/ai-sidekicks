// Hands a live Claude Code process its session's standing rules: a session rule by resending the
// session's whole permissions document in its flag settings, which apply from the next call, and
// a project rule through the project's own local settings file.

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ProviderAskRule, ProviderPermissionAnswer } from "../../../port/permission-ask.js";
import type { PortRegistration } from "../../../port/registration.js";
import type { SessionRulePort } from "../../../port/session-rules.js";
import { composeClaudePermissions } from "../spawn/settings.js";
import { removeClaudeProjectRule, writeClaudeProjectBlock } from "./rules.js";
import type { LiveClaudeSession } from "./state.js";
import { sendClaudeControlRequest } from "./transport.js";

/** The session's own standing rules, none while the approval pipeline has not registered them. */
export function readClaudeSessionRules(
  registration: PortRegistration<SessionRulePort>,
  sessionId: SessionId,
): readonly ProviderAskRule[] {
  return registration.port?.readSessionRules(sessionId) ?? [];
}

// Sends the session's whole permissions document at `level` with its own `sessionRules`, from the
// process's next call; throws `ClaudeControlRequestRefusedError` when the process refuses it.
async function sendClaudePermissions(
  live: LiveClaudeSession,
  level: PermissionLevel | undefined,
  sessionRules: readonly ProviderAskRule[],
): Promise<void> {
  await sendClaudeControlRequest(live.channel, {
    subtype: "apply_flag_settings",
    settings: {
      permissions: composeClaudePermissions(
        live.spawnBoundLegs,
        live.executionPosture?.writableRoots ?? [],
        level,
        sessionRules,
      ),
    },
  });
}

/**
 * Hands Claude Code the rule an answer made, before the answer goes: a session rule (already among
 * `sessionRules`) by resending the permissions document, a host's project block by writing it into
 * the project's local settings. A project allow rides the answer itself, so nothing is sent here.
 */
export async function keepClaudeAnswerRule(
  live: LiveClaudeSession,
  answer: ProviderPermissionAnswer,
  sessionRules: readonly ProviderAskRule[],
): Promise<void> {
  const rule = answer.rule;
  if (rule?.kind === "session") {
    await sendClaudePermissions(live, live.executionPosture?.mode, sessionRules);
  } else if (rule?.kind === "project" && rule.sense === "block") {
    await writeClaudeProjectBlock(live.spawnBoundLegs.workingDirectory, rule);
  }
}

/**
 * Takes a revoked rule out of force: out of `projectFolder`'s local settings when one is given,
 * else out of the live process's rules by resending the permissions document with the rules in
 * force, `sessionRules`; a process started later reads the rules then.
 */
export async function revokeClaudeRule(
  live: LiveClaudeSession | undefined,
  rule: ProviderAskRule,
  projectFolder: string | undefined,
  sessionRules: readonly ProviderAskRule[],
): Promise<void> {
  if (projectFolder !== undefined) {
    await removeClaudeProjectRule(projectFolder, rule);
  } else if (live !== undefined) {
    await sendClaudePermissions(live, live.executionPosture?.mode, sessionRules);
  }
}
