// Where a shell the real-shell tests start is installed on this machine, read once at load, so a
// case whose shell is missing is skipped rather than failed.

import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * The absolute path of the program `name` along this process's `PATH`, or `undefined` when no
 * folder on it holds a file of that name this account may run.
 */
export function findInstalledShell(name: string): string | undefined {
  for (const folder of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (folder.length === 0) {
      continue;
    }
    const candidate = path.join(folder, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) {
        throw error;
      }
    }
  }
  return undefined;
}
