// Main's own files under the user-data folder (the keyboard map, the appearance record, the
// window places) are written whole and readable only by the person. A write goes through a
// flushed temporary file renamed over the real one, so a reader sees the old file or the new and
// a crash mid-save never leaves half a file.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_FOLDER_MODE = 0o700;

/**
 * Write `value` as pretty-printed JSON to `filePath`, atomically and readable only by the
 * person, making the folder if it is missing. Rejects with the file system's error.
 */
export async function writeOwnerOnlyJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: OWNER_ONLY_FOLDER_MODE });
  const temporaryPath = temporaryPathFor(filePath);
  try {
    const handle = await open(temporaryPath, "wx", OWNER_ONLY_FILE_MODE);
    try {
      await handle.writeFile(jsonText(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * The same write, finished before it returns: for a moment the process may end right after,
 * such as a window's close during a quit, where a pending write would be cut off. Throws the
 * file system's error.
 */
export function writeOwnerOnlyJsonFileSync(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: OWNER_ONLY_FOLDER_MODE });
  const temporaryPath = temporaryPathFor(filePath);
  try {
    const descriptor = openSync(temporaryPath, "wx", OWNER_ONLY_FILE_MODE);
    try {
      writeFileSync(descriptor, jsonText(value), "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function temporaryPathFor(filePath: string): string {
  return `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
