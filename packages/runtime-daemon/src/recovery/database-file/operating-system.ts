// What the database file's check, repair and copies aside take from the operating system the
// daemon runs on: its own `sqlite3` shell, named as the system names a program, and a copy of a
// file that a stop ends at once, as a clone where the file system can make one. Every copy runs in
// a child process, since a copy in the daemon's own process cannot be cut short. Each system's
// module picks the copy: a program of the system's own, or Node's copy in a child process of its
// own, which clones where the file system offers it and copies elsewhere.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { moduleUrlBeside } from "../../worker/module-url.js";

/** What the database file's check, repair and copies aside take from the operating system. */
export interface DatabaseFileOperatingSystem {
  /** The daemon's own `sqlite3` shell, which its install builds. */
  readonly sqliteShellProgram: string;
  /**
   * Copies `sourcePath` to `destinationPath`, replacing it, as a clone where the file system can
   * make one. Rejects with the copy's error, and when `stopSignal` aborts, once the copy has ended.
   */
  copyFile(sourcePath: string, destinationPath: string, stopSignal: AbortSignal): Promise<void>;
}

const COPY_CHILD_PATH = fileURLToPath(moduleUrlBeside(import.meta.url, "child"));

/** The `sqlite3` shell the daemon's install builds, its file named as `executableFileName` says. */
export function builtSqliteShellProgram(executableFileName: (base: string) => string): string {
  return fileURLToPath(
    new URL(
      `../../../sqlite-shell/build/Release/${executableFileName("sqlite3")}`,
      import.meta.url,
    ),
  );
}

/**
 * Runs `program` with `args` to make a copy, settling once its process has exited, so nothing
 * still writes the copy when it does. Rejects with its failure, and when `stopSignal` aborts.
 */
export async function runCopyProgram(
  program: string,
  args: readonly string[],
  stopSignal: AbortSignal,
): Promise<void> {
  await promisify(execFile)(program, args, { signal: stopSignal, killSignal: "SIGKILL" });
}

/** A copy by Node's own copy, in a child process of its own so a stop can end it. */
export function copyFileInChildProcess(
  sourcePath: string,
  destinationPath: string,
  stopSignal: AbortSignal,
): Promise<void> {
  return runCopyProgram(
    process.execPath,
    [...process.execArgv, COPY_CHILD_PATH, sourcePath, destinationPath],
    stopSignal,
  );
}
