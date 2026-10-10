// The daemon's own `sqlite3` shell, which the start's check runs in, and SQLite's own recovery,
// `sqlite3_recover`, run through the shell's `.recover`: the shell reads the damaged file
// read-only and writes the SQL that rebuilds every row it can reach, and a second shell runs that
// SQL into a fresh file. The binding the daemon links is built without the page virtual table the
// recovery reads through and exposes no recovery call, so the daemon carries its own shell,
// compiled at install from the binding's SQLite source with the page table added
// (`sqlite-shell/binding.gyp`). A shell that is missing, of another release than the binding or
// built without the page table means a damaged install and is refused before it runs, and a
// recovery that runs far past its expected time is stopped. The recovery's SQL passes through the
// daemon on its way to the second shell, and the daemon counts the session events in it.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";

/** The shell the daemon's install builds, in the package folder three levels above this file. */
export const SQLITE_SHELL_PROGRAM: string = fileURLToPath(
  new URL(
    `../../../sqlite-shell/build/Release/sqlite3${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

/** How long a shell reading the file waits out another connection's lock before it fails busy. */
export const SQLITE_SHELL_BUSY_TIMEOUT_MS = 5_000;

// The tail of a shell's error output kept for the failure's message.
const ERROR_OUTPUT_KEPT_BYTES = 4_096;

// Answers a row only for a shell built with the page table `.recover` reads through.
const PAGE_TABLE_OPTION_SQL =
  "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_DBPAGE_VTAB'";

// A 401 MB file recovered in about 10 seconds; the bound allows ten times that rate, after a
// minute for any file.
const RECOVERY_BOUND_FLOOR_MS = 60_000;
const RECOVERY_BOUND_BYTES_PER_MS = 4_000;

// The writing shell's page cache, in KiB. The fresh file's unique indexes take each row as it
// goes in, and with SQLite's default of 2 MiB every insert reads their pages from the disk again.
const RECOVERY_WRITER_CACHE_KIB = 262_144;

// The table whose rows the recovery counts, and how `.recover` starts each row it writes to it.
const COUNTED_TABLE = "session_events";
const COUNTED_ROW_START = Buffer.from(`\nINSERT OR IGNORE INTO '${COUNTED_TABLE}'(`);

/**
 * Recovers what `damagedPath` holds into `freshPath`, which must not exist, calling
 * `onEventsRecovered` with how many session events it has recovered so far as they pass. Rejects
 * when the shell is missing, of another release than the binding or built without the page table,
 * when either shell cannot start or exits with a failure, naming its error output, and when the
 * recovery outlasts its bound, which stops both shells.
 */
export async function recoverIntoFreshFile(
  damagedPath: string,
  freshPath: string,
  onEventsRecovered: (recoveredEvents: number) => void,
): Promise<void> {
  await refuseUnfitShell();
  const boundMs =
    RECOVERY_BOUND_FLOOR_MS + (await stat(damagedPath)).size / RECOVERY_BOUND_BYTES_PER_MS;
  const reader = spawn(SQLITE_SHELL_PROGRAM, ["-readonly", damagedPath, ".recover"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const writer = spawn(SQLITE_SHELL_PROGRAM, ["-bail", freshPath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  writer.stdin.write(`PRAGMA cache_size = -${String(RECOVERY_WRITER_CACHE_KIB)};\n`);
  reader.stdout.pipe(writer.stdin);
  let recoveredEvents = 0;
  // A row's start can straddle two chunks, so each search begins in the last chunk's tail, which
  // is too short to hold a whole one.
  let tail = Buffer.alloc(0);
  reader.stdout.on("data", (chunk: Buffer) => {
    const searched = Buffer.concat([tail, chunk]);
    let found = searched.indexOf(COUNTED_ROW_START);
    let foundInChunk = 0;
    while (found !== -1) {
      foundInChunk += 1;
      found = searched.indexOf(COUNTED_ROW_START, found + COUNTED_ROW_START.length);
    }
    tail = searched.subarray(Math.max(0, searched.length - COUNTED_ROW_START.length + 1));
    if (foundInChunk > 0) {
      recoveredEvents += foundInChunk;
      onEventsRecovered(recoveredEvents);
    }
  });
  let isPastBound = false;
  const bound = setTimeout(() => {
    isPastBound = true;
    reader.kill("SIGKILL");
    writer.kill("SIGKILL");
  }, boundMs);
  // A shell that fails stops the other, and the recovery settles only once both have exited, so
  // no shell still writes beside the fresh file a failed repair removes.
  let firstFailure: unknown;
  const settle = (step: Promise<void>, other: ChildProcess): Promise<void> =>
    step.catch((error: unknown) => {
      firstFailure ??= error;
      other.kill("SIGKILL");
    });
  await Promise.all([
    settle(waitForSuccess(reader, "reading the damaged file"), writer),
    settle(waitForSuccess(writer, "writing the fresh file"), reader),
  ]);
  clearTimeout(bound);
  if (firstFailure !== undefined) {
    throw isPastBound
      ? new Error(
          `The SQLite shell's recovery ran past ${String(Math.round(boundMs / 1_000))} seconds ` +
            "and was stopped",
          { cause: firstFailure },
        )
      : firstFailure;
  }
}

/**
 * How many session events the damaged file at `path` lists, read through the shell so a large
 * file holds no thread of the daemon's. Rejects when the shell cannot read the count, as a
 * damaged index makes it.
 */
export async function countDamagedFileEvents(path: string): Promise<number> {
  // The recovery's reader opens the file beside it, so the count waits out its locks.
  const { stdout } = await promisify(execFile)(SQLITE_SHELL_PROGRAM, [
    "-readonly",
    "-cmd",
    `.timeout ${String(SQLITE_SHELL_BUSY_TIMEOUT_MS)}`,
    path,
    `SELECT count(*) FROM ${COUNTED_TABLE}`,
  ]);
  const count = Number(stdout.trim());
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`The SQLite shell answered the count of session events with ${stdout.trim()}`);
  }
  return count;
}

/**
 * Rejects when the shell is missing, cannot run, is of another SQLite release than the binding or
 * is built without the page table, each of which means a damaged install.
 */
export async function refuseUnfitShell(): Promise<void> {
  let versionOutput: string;
  let pageTableOutput: string;
  try {
    versionOutput = (await promisify(execFile)(SQLITE_SHELL_PROGRAM, ["-version"])).stdout;
    pageTableOutput = (
      await promisify(execFile)(SQLITE_SHELL_PROGRAM, [":memory:", PAGE_TABLE_OPTION_SQL])
    ).stdout;
  } catch (error) {
    throw new Error(
      `The daemon's SQLite shell at ${SQLITE_SHELL_PROGRAM} could not be run, so its install is ` +
        `damaged: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const shellVersion = versionOutput.trim().split(" ")[0];
  const bindingVersion = readBindingVersion();
  if (shellVersion !== bindingVersion) {
    throw new Error(
      `The daemon's SQLite shell is ${String(shellVersion)} but its binding is ${bindingVersion}, ` +
        "so its install is damaged",
    );
  }
  if (pageTableOutput.trim() === "") {
    throw new Error(
      `The daemon's SQLite shell is built without the page table its recovery reads through ` +
        "(SQLITE_ENABLE_DBPAGE_VTAB), so its install is damaged",
    );
  }
}

function readBindingVersion(): string {
  const database = new Database(":memory:");
  try {
    return String(database.prepare<[], string>("SELECT sqlite_version()").pluck().get());
  } finally {
    database.close();
  }
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
