// The permission levels a Claude Code session can run at, and the live move between them: the
// level's permission mode, then the session's whole permission rules and its Bash sandbox for that
// level, all from the process's next request, with no relaunch.

import type {
  ExecutionPosture,
  ProviderMode,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";

import { CURATED_CREDENTIAL_POLICY_REF } from "../../../../policy/execution-posture-service.js";
import type { ProviderOperatingSystem } from "../../../operating-system/contract.js";
import { CLAUDE_PERMISSION_MODE_BY_LEVEL } from "../spawn/arguments.js";
import { composeClaudePermissions, composeClaudeSandboxSettings } from "../spawn/settings.js";
import { ClaudeSessionUnavailableError } from "./errors.js";
import type { LiveClaudeSession } from "./state.js";
import { sendClaudeControlRequest, type ClaudeInitializeDeclaration } from "./transport.js";

/** The system fact the Claude levels depend on: Sandboxed needs Claude Code's Bash sandbox. */
type ClaudeLevelSystem = Pick<ProviderOperatingSystem, "canRunClaudeBashSandbox">;

function isLevelOfferedOn(level: PermissionLevel, operatingSystem: ClaudeLevelSystem): boolean {
  return level !== "sandboxed" || operatingSystem.canRunClaudeBashSandbox;
}

/** The levels a Claude Code session can run at on this system, each with the mode it runs in. */
export function listClaudeModes(operatingSystem: ClaudeLevelSystem): ProviderMode[] {
  return Object.entries(CLAUDE_PERMISSION_MODE_BY_LEVEL)
    .filter(([level]) => isLevelOfferedOn(level as PermissionLevel, operatingSystem))
    .map(([level, mode]) => ({ id: level, name: mode }));
}

/**
 * Whether a process on `runningModel` can run at `level` on this system: Reviewed only on a model
 * whose `initialize` reply offered auto mode, Sandboxed only where the Bash sandbox runs.
 */
export function canRunClaudeLevel(
  level: PermissionLevel,
  runningModel: string,
  initialize: Pick<ClaudeInitializeDeclaration, "autoModeModels">,
  operatingSystem: ClaudeLevelSystem,
): boolean {
  return (
    isLevelOfferedOn(level, operatingSystem) &&
    (level !== "reviewed" || initialize.autoModeModels.has(runningModel))
  );
}

/**
 * Moves a live session to `level`: its permission mode, unless the session plans, then its whole
 * permission rules, which add or remove the removal ask rule of Reviewed, and the Bash sandbox, on
 * at Sandboxed and cleared at every other level. Throws `permission_level_unavailable` for
 * Reviewed on a model without auto mode and for a level the system does not run, before
 * anything is sent, and `ClaudeControlRequestRefusedError` when the process refuses either
 * request.
 */
export async function moveClaudePermissionLevel(
  live: LiveClaudeSession,
  level: PermissionLevel,
  operatingSystem: ClaudeLevelSystem,
): Promise<void> {
  if (!canRunClaudeLevel(level, live.runningModel, live.initialize, operatingSystem)) {
    throw new ClaudeSessionUnavailableError("permission_level_unavailable", {
      sessionId: live.sessionId,
      detail: `Level ${level}.`,
    });
  }
  const posture: ExecutionPosture = {
    writableRoots: [],
    credentialPolicyRef: CURATED_CREDENTIAL_POLICY_REF,
    ...live.executionPosture,
    mode: level,
  };
  // A planning session stays in plan mode; the level's own mode returns when it builds again.
  if (live.sessionMode === "build") {
    await sendClaudeControlRequest(live.channel, {
      subtype: "set_permission_mode",
      mode: CLAUDE_PERMISSION_MODE_BY_LEVEL[level],
    });
  }
  await sendClaudeControlRequest(live.channel, {
    subtype: "apply_flag_settings",
    settings: {
      permissions: composeClaudePermissions(live.spawnBoundLegs, posture.writableRoots, level),
      // `null` removes the key from the flag-settings layer, so leaving Sandboxed turns it off.
      sandbox: level === "sandboxed" ? composeClaudeSandboxSettings(posture.writableRoots) : null,
    },
  });
  live.executionPosture = posture;
}
