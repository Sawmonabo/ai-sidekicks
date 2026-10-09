// Whether a Claude Code process kept the retention the daemon set, read back after each spawn. A
// lower value comes from a setting that outranks the daemon's, so the session notice names the
// managed settings file whose value is in force, where the daemon can read one that sets it.

import { readdir } from "node:fs/promises";
import path from "node:path";

import type { SessionNoticePayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { CLAUDE_CLEANUP_PERIOD_DAYS } from "../spawn/settings.js";
import { isUnreadablePath, readClaudeSettingsFile } from "./settings-file.js";
import type { ClaudeSettingsReadback } from "./transport.js";

// A file or folder the daemon could not read: the notice still goes, naming what could be read.
type ClaudeSettingsReadFailure = (error: unknown) => void;

async function listManagedSettingsFiles(
  managedSettingsFolder: string,
  onReadFailure: ClaudeSettingsReadFailure,
): Promise<string[]> {
  const dropInFolder = path.join(managedSettingsFolder, "managed-settings.d");
  const dropIns = await readdir(dropInFolder).catch((error: unknown): string[] => {
    if (!isUnreadablePath(error)) {
      onReadFailure(error);
    }
    return [];
  });
  return [
    path.join(managedSettingsFolder, "managed-settings.json"),
    ...dropIns
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(dropInFolder, name)),
  ];
}

// The managed file whose retention is in force: drop-ins apply in name order over the base file,
// so the last file that sets the key decides it; named only when it lowers the retention.
async function findLoweringFile(
  managedSettingsFolder: string,
  onReadFailure: ClaudeSettingsReadFailure,
): Promise<string | undefined> {
  let deciding: { readonly filePath: string; readonly value: number } | undefined;
  for (const filePath of await listManagedSettingsFiles(managedSettingsFolder, onReadFailure)) {
    const settings = await readClaudeSettingsFile(filePath).catch((error: unknown) => {
      onReadFailure(error);
      return undefined;
    });
    const value = settings?.["cleanupPeriodDays"];
    if (typeof value === "number") {
      deciding = { filePath, value };
    }
  }
  return deciding !== undefined && deciding.value < CLAUDE_CLEANUP_PERIOD_DAYS
    ? deciding.filePath
    : undefined;
}

/**
 * The `settings_ignored` notice for a session whose process ignored the daemon's retention, or
 * `undefined` when it kept it or said nothing. `managedSettingsFolder` is the system's managed
 * settings folder; a managed file that could not be read is told to `onReadFailure` and the notice
 * still goes, naming no file.
 */
export async function findIgnoredSettingNotice(
  sessionId: SessionId,
  readback: Pick<ClaudeSettingsReadback, "cleanupPeriodDays">,
  managedSettingsFolder: string,
  onReadFailure: ClaudeSettingsReadFailure,
): Promise<SessionNoticePayload | undefined> {
  const effective = readback.cleanupPeriodDays;
  if (effective === null || effective >= CLAUDE_CLEANUP_PERIOD_DAYS) {
    return undefined;
  }
  const file = await findLoweringFile(managedSettingsFolder, onReadFailure);
  return {
    sessionId,
    kind: "settings_ignored",
    provider: "claude",
    key: "cleanupPeriodDays",
    ...(file === undefined ? {} : { file }),
  };
}
