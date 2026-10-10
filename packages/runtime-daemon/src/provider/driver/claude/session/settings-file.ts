// Reading one of Claude Code's settings files the way the daemon can: a file that is absent, not
// the daemon's to read, or not a settings object sets nothing the daemon can name.

import { readFile } from "node:fs/promises";

import { isPlainObject } from "../../../record-readers.js";

// The read failures that mean the daemon cannot read the file: it is absent or not the daemon's.
const UNREADABLE_FILE_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
]);

/** Whether a file-system failure means the daemon cannot read the path, rather than a fault. */
export function isUnreadablePath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    UNREADABLE_FILE_CODES.has(error.code)
  );
}

/**
 * One settings file as its JSON object, or `undefined` when the daemon cannot read it or it holds
 * no settings object. Throws on any other read failure.
 */
export async function readClaudeSettingsFile(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isUnreadablePath(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}
