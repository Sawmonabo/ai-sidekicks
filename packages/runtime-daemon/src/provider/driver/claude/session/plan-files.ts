// The plan files Claude Code keeps for one conversation: `<slug>.md`, its `<slug>.workshop.md`, and
// each helper's `<slug>-agent-<agent id>.md`, in the plans folder its `plansDirectory` setting
// names, relative to the project and inside it, else `<config folder>/plans`.

import { readdir } from "node:fs/promises";
import path from "node:path";

import { isUnreadablePath, readClaudeSettingsFile } from "./settings-file.js";

// Where Claude Code reads `plansDirectory`, lowest precedence first: the home's settings, the
// project's shared settings, then its local settings.
function settingsFilesFor(configFolder: string, projectFolder: string): string[] {
  return [
    path.join(configFolder, "settings.json"),
    path.join(projectFolder, ".claude", "settings.json"),
    path.join(projectFolder, ".claude", "settings.local.json"),
  ];
}

// The folder the settings name, or `undefined` when none names one inside the project, which
// Claude Code also refuses.
async function readConfiguredPlansFolder(
  configFolder: string,
  projectFolder: string,
): Promise<string | undefined> {
  let configured: string | undefined;
  for (const filePath of settingsFilesFor(configFolder, projectFolder)) {
    const value = (await readClaudeSettingsFile(filePath))?.["plansDirectory"];
    if (typeof value === "string" && value !== "") {
      configured = value;
    }
  }
  if (configured === undefined) {
    return undefined;
  }
  const folder = path.resolve(projectFolder, configured);
  const relative = path.relative(projectFolder, folder);
  return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : folder;
}

/**
 * The plan files of the conversation named `planSlug`, in the configured plans folder and the
 * default one, since the setting may have changed while the conversation lived.
 */
export async function findClaudePlanFiles(
  configFolder: string,
  projectFolder: string,
  planSlug: string,
): Promise<string[]> {
  const defaultFolder = path.join(configFolder, "plans");
  const configuredFolder = await readConfiguredPlansFolder(configFolder, projectFolder);
  const folders = new Set([defaultFolder, configuredFolder ?? defaultFolder]);
  const found: string[] = [];
  for (const folder of folders) {
    const entries = await readdir(folder).catch((error: unknown): string[] => {
      if (isUnreadablePath(error)) {
        return [];
      }
      throw error;
    });
    found.push(
      ...entries
        .filter(
          (entry) =>
            entry === `${planSlug}.md` ||
            entry === `${planSlug}.workshop.md` ||
            (entry.startsWith(`${planSlug}-agent-`) && entry.endsWith(".md")),
        )
        .map((entry) => path.join(folder, entry)),
    );
  }
  return found;
}
