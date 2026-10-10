// The permission profile a Codex thread runs under, as the daemon asked for it and as Codex reports
// it on `thread/settings/updated`. A report naming a profile the daemon never asked the thread for,
// or none, is a drift: something other than the daemon moved the conversation's posture.

import { isPlainObject } from "../../../record-readers.js";
import { CODEX_THREAD_SETTINGS_UPDATED_METHOD } from "../event-normalizer.js";
import { composeCodexLevelSettings, composeCodexProfileName } from "../permission-level.js";
import type { CodexSessionRecord } from "../session/state.js";
import { normalizeProviderFailureDetail } from "../session/errors.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import type { CodexThreadSettings } from "./settings.js";

/** The profile Codex last reported for a thread, and the ones asked for since, oldest first. */
export interface CodexThreadPermissionProfiles {
  confirmed: string;
  readonly pending: string[];
}

/** The profiles of a thread just established: its reply ran the level's profile, checked as it came. */
export function composeCodexThreadPermissionProfiles(
  settings: Pick<CodexThreadSettings, "level" | "profileFolders">,
): CodexThreadPermissionProfiles {
  return {
    confirmed: composeCodexProfileName(settings.level, settings.profileFolders),
    pending: [],
  };
}

/** Records a profile about to be asked for, before its request is sent, once per change. */
export function noteCodexPermissionProfileAsked(
  profiles: CodexThreadPermissionProfiles,
  profile: string,
): void {
  if (profile !== (profiles.pending.at(-1) ?? profiles.confirmed)) {
    profiles.pending.push(profile);
  }
}

/**
 * Checks the profile a `thread/settings/updated` for the session's thread reports, and when the
 * daemon never asked for it reports the drift and asks Codex for the session's own posture again,
 * which holds from the next turn. A failed ask is reported, the drift standing until the next turn
 * names its posture.
 */
export function correctCodexPermissionProfileDrift(
  record: Pick<
    CodexSessionRecord,
    "service" | "threadId" | "threadSettings" | "permissionProfiles"
  >,
  method: string,
  params: unknown,
  reportDiagnostic: CodexDiagnosticSink,
): void {
  if (
    method !== CODEX_THREAD_SETTINGS_UPDATED_METHOD ||
    !isPlainObject(params) ||
    params["threadId"] !== record.threadId
  ) {
    return;
  }
  const activeProfile = readCodexPermissionProfileDrift(record.permissionProfiles, params);
  if (activeProfile === undefined) {
    return;
  }
  const threadId = record.threadId;
  const posture = composeCodexLevelSettings(
    record.threadSettings.level,
    record.threadSettings.profileFolders,
  );
  reportDiagnosticFromDetachedFrame(reportDiagnostic, {
    kind: "permission-profile-drifted",
    threadId,
    activeProfile,
    expectedProfile: posture.permissions,
  });
  noteCodexPermissionProfileAsked(record.permissionProfiles, posture.permissions);
  record.service
    .request("thread/settings/update", { threadId, ...posture })
    .catch((cause: unknown) => {
      reportDiagnosticFromDetachedFrame(reportDiagnostic, {
        kind: "permission-profile-restore-failed",
        threadId,
        detail: normalizeProviderFailureDetail(cause),
      });
    });
}

// The profile one `thread/settings/updated` reports: `undefined` when the daemon asked for it, the
// record moving on to it, else the drifted profile's id, `"none"` when it names none.
function readCodexPermissionProfileDrift(
  profiles: CodexThreadPermissionProfiles,
  params: unknown,
): string | undefined {
  const settings = isPlainObject(params) ? params["threadSettings"] : undefined;
  const active = isPlainObject(settings) ? settings["activePermissionProfile"] : undefined;
  const activeId =
    isPlainObject(active) && typeof active["id"] === "string" ? active["id"] : "none";
  if (activeId === profiles.confirmed) {
    return undefined;
  }
  const askedAt = profiles.pending.indexOf(activeId);
  if (askedAt === -1) {
    return activeId;
  }
  profiles.confirmed = activeId;
  profiles.pending.splice(0, askedAt + 1);
  return undefined;
}
