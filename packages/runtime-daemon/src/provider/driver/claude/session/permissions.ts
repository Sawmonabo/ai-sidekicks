// Hands a live Claude Code process its session's standing rules: a session rule by resending the
// session's whole permissions document in its flag settings, which apply from the next call, and
// a project rule through the local settings file of each of the project's working folders.

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DiskFlush } from "../../../../disk-flush/contract.js";
import { canonicalFolderPath } from "../../../../workspace/folder/canonical-path.js";
import { writeIntoProjectFolders } from "../../../project-rule-folders.js";
import type { ProviderAnswerRule, ProviderAskRule } from "../../../port/permission-ask.js";
import type { PortRegistration } from "../../../port/registration.js";
import type { SessionRulePort } from "../../../port/session-rules.js";
import { composeClaudePermissions } from "../spawn/settings.js";
import { removeClaudeProjectRule, writeClaudeProjectRule } from "./rules.js";
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
 * Hands Claude Code the rule an answer made, once the answer went: a session rule by resending the
 * permissions document with the rules in force, `sessionRules`, it joins in place of any it
 * replaces; a project rule by writing it into each of the project's working folders, except an
 * allow into the session's own, which rode the answer for Claude Code to write, and out of them
 * again when one write fails.
 */
export async function keepClaudeAnswerRule(
  live: LiveClaudeSession,
  made: ProviderAnswerRule,
  sessionRules: readonly ProviderAskRule[],
  diskFlush: DiskFlush,
): Promise<void> {
  const { rule } = made;
  if (rule.kind === "session") {
    const standing = sessionRules.filter(
      (other) =>
        other.kind !== rule.kind || other.action !== rule.action || other.subject !== rule.subject,
    );
    await sendClaudePermissions(live, live.executionPosture?.mode, [...standing, rule]);
    return;
  }
  const ownFolder = await canonicalFolderPath(live.spawnBoundLegs.workingDirectory);
  const folders: string[] = [];
  const writtenByAnswer: string[] = [];
  for (const projectFolder of made.projectFolders) {
    const isOwnAllow =
      rule.sense === "allow" && (await canonicalFolderPath(projectFolder)) === ownFolder;
    (isOwnAllow ? writtenByAnswer : folders).push(projectFolder);
  }
  await writeIntoProjectFolders(
    folders,
    rule,
    (projectFolder, written) => writeClaudeProjectRule(projectFolder, written, diskFlush),
    (projectFolder, removed) => removeClaudeProjectRule(projectFolder, removed, diskFlush),
    writtenByAnswer,
  );
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
  diskFlush: DiskFlush,
): Promise<void> {
  if (projectFolder !== undefined) {
    await removeClaudeProjectRule(projectFolder, rule, diskFlush);
  } else if (live !== undefined) {
    await sendClaudePermissions(live, live.executionPosture?.mode, sessionRules);
  }
}
