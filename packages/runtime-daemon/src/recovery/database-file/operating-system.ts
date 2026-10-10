// What the database file's check, repair and copies aside take from the operating system the
// daemon runs on: its own `sqlite3` shell, named as the system names a program, and a copy of a
// file that a stop ends at once, as a clone where the file system can make one. Every copy runs in
// a child process, since a copy in the daemon's own process cannot be cut short. On macOS it is the
// system's `cp -c`, which clones on APFS and copies elsewhere; Node's own copy never clones there.
// Elsewhere it is Node's copy in a child process of its own, which clones where Linux offers it
// (Btrfs, XFS) and copies elsewhere.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { executableFileName } from "../../executable/file-name.js";
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

// The system's own copy, which clones through `clonefile(2)` and copies where it cannot.
const DARWIN_COPY_PROGRAM = "/bin/cp";

const COPY_CHILD_PATH = fileURLToPath(moduleUrlBeside(import.meta.url, "child"));

/** What `platform` supplies to the database file's check, repair and copies aside. */
export function chooseDatabaseFileOperatingSystem(
  platform: NodeJS.Platform,
): DatabaseFileOperatingSystem {
  const sqliteShellProgram = fileURLToPath(
    new URL(
      `../../../sqlite-shell/build/Release/${executableFileName("sqlite3", platform)}`,
      import.meta.url,
    ),
  );
  if (platform === "darwin") {
    return {
      sqliteShellProgram,
      copyFile: (sourcePath, destinationPath, stopSignal) =>
        runCopy(DARWIN_COPY_PROGRAM, ["-c", sourcePath, destinationPath], stopSignal),
    };
  }
  return {
    sqliteShellProgram,
    copyFile: (sourcePath, destinationPath, stopSignal) =>
      runCopy(
        process.execPath,
        [...process.execArgv, COPY_CHILD_PATH, sourcePath, destinationPath],
        stopSignal,
      ),
  };
}

// The copy settles once its process has exited, so nothing still writes the copy when it does.
async function runCopy(
  program: string,
  args: readonly string[],
  stopSignal: AbortSignal,
): Promise<void> {
  await promisify(execFile)(program, args, { signal: stopSignal, killSignal: "SIGKILL" });
}
