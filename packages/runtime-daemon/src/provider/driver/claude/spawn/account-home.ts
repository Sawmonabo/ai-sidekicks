// The retention an account home the app manages keeps: `cleanupPeriodDays` in its own
// `settings.json`, because Claude Code's cleanup judges every file in the home by its age, whatever
// process wrote it. The person's own Claude Code home is never written.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "../../../../file/atomic-write.js";
import { isPlainObject } from "../../../record-readers.js";
import { CLAUDE_CLEANUP_PERIOD_DAYS } from "./settings.js";

async function readHomeSettings(settingsPath: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Parsing a string fails only on its syntax, and the parser's message quotes the file, whose
    // `env` can hold tokens, so neither it nor the parser's error is passed on; the path is named.
    throw new Error(`${settingsPath} is not valid JSON.`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${settingsPath} holds no settings object.`);
  }
  return parsed;
}

/**
 * Sets the home's `cleanupPeriodDays` to the daemon's retention, keeping every other setting, and
 * writes nothing when it already holds it. Throws when the file cannot be read, parsed or written.
 */
export async function writeClaudeHomeRetention(configFolder: string): Promise<void> {
  const settingsPath = path.join(configFolder, "settings.json");
  const settings = await readHomeSettings(settingsPath);
  if (settings["cleanupPeriodDays"] === CLAUDE_CLEANUP_PERIOD_DAYS) {
    return;
  }
  // Readable by the person alone.
  await writeFileAtomically(
    settingsPath,
    `${JSON.stringify({ ...settings, cleanupPeriodDays: CLAUDE_CLEANUP_PERIOD_DAYS }, null, 2)}\n`,
    0o600,
  );
}
