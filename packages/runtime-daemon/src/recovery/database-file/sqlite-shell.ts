// SQLite's own recovery, `sqlite3_recover`, run through the `sqlite3` shell's `.recover`: the
// shell reads the damaged file read-only and writes the SQL that rebuilds every row it can reach,
// and a second shell runs that SQL into a fresh file. The binding the daemon links is built
// without the page virtual table the recovery reads through and exposes no recovery call, so the
// shell, which is built with both, is the way in.

import { spawn, type ChildProcess } from "node:child_process";

/** The shell, found on the search path. */
const SQLITE_SHELL_PROGRAM = "sqlite3";

// The tail of a shell's error output kept for the failure's message.
const ERROR_OUTPUT_KEPT_BYTES = 4_096;

/**
 * Recovers what `damagedPath` holds into `freshPath`, which must not exist. Rejects when either
 * shell cannot start or exits with a failure, naming its error output.
 */
export async function recoverIntoFreshFile(damagedPath: string, freshPath: string): Promise<void> {
  const reader = spawn(SQLITE_SHELL_PROGRAM, ["-readonly", damagedPath, ".recover"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const writer = spawn(SQLITE_SHELL_PROGRAM, ["-bail", freshPath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  reader.stdout.pipe(writer.stdin);
  await Promise.all([
    waitForSuccess(reader, "reading the damaged file"),
    waitForSuccess(writer, "writing the fresh file"),
  ]);
}

function waitForSuccess(child: ChildProcess, step: string): Promise<void> {
  let errorOutput = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    errorOutput = (errorOutput + chunk).slice(-ERROR_OUTPUT_KEPT_BYTES);
  });
  // A shell that exits early breaks the pipe into it; its own exit says why, with this beside it.
  child.stdin?.on("error", (error) => {
    errorOutput = `${errorOutput}\n${error.message}`.slice(-ERROR_OUTPUT_KEPT_BYTES);
  });
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new Error(`The SQLite shell could not start ${step}: ${error.message}`, { cause: error }),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `The SQLite shell failed ${step} (${signal ?? `exit ${String(exitCode)}`}): ` +
            errorOutput.trim(),
        ),
      );
    });
  });
}
