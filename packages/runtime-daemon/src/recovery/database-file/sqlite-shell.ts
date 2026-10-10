// The daemon's own `sqlite3` shell, which the start's check runs in, and SQLite's own recovery,
// `sqlite3_recover`, run through the shell's `.recover`: the shell reads the damaged file
// read-only and writes the SQL that rebuilds every row it can reach, and a second shell runs that
// SQL into a fresh file. The binding the daemon links is built without the page virtual table the
// recovery reads through and exposes no recovery call, so the daemon carries its own shell,
// compiled at install from the binding's SQLite source with the page table added
// (`sqlite-shell/binding.gyp`). A shell that is missing, of another release than the binding or
// built without the page table means a damaged install and is refused before it runs. The
// recovery's SQL passes through the daemon on its way to the second shell, and the daemon counts
// the session events in it. A recovery whose shells have both stopped working, neither passing a
// byte nor using the processor, is stopped; one that is only slow, on a busy machine or a large
// file, goes on however long it takes.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import pidusage from "pidusage";

import { executableFileName } from "../../executable/file-name.js";

/** The shell the daemon's install builds, in the package folder three levels above this file. */
export const SQLITE_SHELL_PROGRAM: string = fileURLToPath(
  new URL(
    `../../../sqlite-shell/build/Release/${executableFileName("sqlite3", process.platform)}`,
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

// How long the recovery may pass no byte before the shells' processor time is read. Each reading
// after that compares with the one before, so a recovery is stopped only after a whole window in
// which neither shell passed a byte or used the processor: a shell that works, however slowly,
// uses some in every minute, while one blocked for good uses none.
const RECOVERY_STALL_WINDOW_MS = 60_000;

// What the writing shell runs before the recovery's SQL. The fresh file is scratch until it is
// synced and marked ready, and a failed repair removes it, so it keeps no rollback journal and
// waits for no sync; defensive mode refuses a journal turned off, and the recovery's own SQL turns
// it off first in any case. Its page cache is fixed at 256 MiB, in KiB: the recovery keeps its
// unique indexes, built before the rows so that a duplicate row is dropped, and the rows reach the
// one on a session and its sequence out of its order, so a cache that index outgrows writes a page
// out for nearly every row; a cache sized to that index grows with the file instead.
const RECOVERY_WRITER_PREAMBLE = `.dbconfig defensive off
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA cache_size = -${String(256 * 1024)};
`;

// The table whose rows the recovery counts, and how `.recover` starts each row it writes to it.
const COUNTED_TABLE = "session_events";
const COUNTED_ROW_START = Buffer.from(`\nINSERT OR IGNORE INTO '${COUNTED_TABLE}'(`);

/** What a recovery reports to, and what stops it. */
export interface RecoveryOptions {
  /** Called with how many session events the recovery has passed so far, as they pass. */
  readonly onEventsRecovered: (recoveredEvents: number) => void;
  /** Ends both shells when it aborts. */
  readonly stopSignal: AbortSignal;
  readonly writeServiceLog: (line: string) => void;
}

/**
 * Recovers what `damagedPath` holds into `freshPath`, which must not exist, calling
 * `onEventsRecovered` with how many session events it has recovered so far as they pass. Rejects
 * when the shell is missing, of another release than the binding or built without the page table,
 * when either shell cannot start or exits with a failure, naming its error output, when both
 * shells stop working, and when `stopSignal` aborts; each of the last two ends both shells first.
 */
export async function recoverIntoFreshFile(
  damagedPath: string,
  freshPath: string,
  options: RecoveryOptions,
): Promise<void> {
  const { stopSignal } = options;
  await refuseUnfitShell();
  const reader = spawn(SQLITE_SHELL_PROGRAM, ["-readonly", damagedPath, ".recover"], {
    stdio: ["ignore", "pipe", "pipe"],
    signal: stopSignal,
    killSignal: "SIGKILL",
  });
  const writer = spawn(SQLITE_SHELL_PROGRAM, ["-bail", freshPath], {
    stdio: ["pipe", "ignore", "pipe"],
    signal: stopSignal,
    killSignal: "SIGKILL",
  });
  writer.stdin.write(RECOVERY_WRITER_PREAMBLE);
  reader.stdout.pipe(writer.stdin);
  let recoveredEvents = 0;
  // A row's start can straddle two chunks, so each search begins in the last chunk's tail, which
  // is too short to hold a whole one.
  let tail = Buffer.alloc(0);
  const stallWatch = new RecoveryStallWatch([reader, writer], options.writeServiceLog);
  reader.stdout.on("data", (chunk: Buffer) => {
    stallWatch.notePassedBytes();
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
      options.onEventsRecovered(recoveredEvents);
    }
  });
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
  stallWatch.end();
  if (firstFailure !== undefined) {
    throw stallWatch.isStalled
      ? new Error(
          `The SQLite shells' recovery passed no byte for ${String(RECOVERY_STALL_WINDOW_MS / 1_000)} ` +
            "seconds and then used no processor time for as long again, so it was stopped",
          { cause: firstFailure },
        )
      : firstFailure;
  }
}

// Watches a recovery's shells for a stall: once no byte has passed for a whole window it reads each
// running shell's processor time, and once a further window passes in which no byte passed, no
// shell exited and none used the processor, it ends both.
class RecoveryStallWatch {
  readonly #shells: readonly ChildProcess[];
  readonly #writeServiceLog: (line: string) => void;
  readonly #timer: NodeJS.Timeout;
  // Each running shell's processor time at the last reading since a byte last passed, in
  // milliseconds by process id.
  #lastReading: ReadonlyMap<number, number> | undefined;
  #isStalled = false;
  #hasEnded = false;

  constructor(shells: readonly ChildProcess[], writeServiceLog: (line: string) => void) {
    this.#shells = shells;
    this.#writeServiceLog = writeServiceLog;
    this.#timer = setTimeout(() => {
      void this.#readProgress();
    }, RECOVERY_STALL_WINDOW_MS);
  }

  /** Whether the watch ended the shells as stalled. */
  get isStalled(): boolean {
    return this.#isStalled;
  }

  notePassedBytes(): void {
    this.#lastReading = undefined;
    this.#timer.refresh();
  }

  end(): void {
    this.#hasEnded = true;
    clearTimeout(this.#timer);
  }

  // A reading that fails never counts as a stall: the log says why, and the next window reads
  // again.
  async #readProgress(): Promise<void> {
    let reading: ReadonlyMap<number, number> | undefined;
    try {
      reading = await readProcessorMs(this.#shells);
    } catch (error) {
      this.#writeServiceLog(
        "The recovery's processor time could not be read, so its progress is read again in a " +
          `minute: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (this.#hasEnded) {
      return;
    }
    if (
      reading !== undefined &&
      this.#lastReading !== undefined &&
      isStill(this.#lastReading, reading)
    ) {
      this.#isStalled = true;
      for (const shell of this.#shells) {
        shell.kill("SIGKILL");
      }
      return;
    }
    this.#lastReading = reading;
    this.#timer.refresh();
  }
}

// Whether the same shells still run and none has used the processor since `before`.
function isStill(before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>): boolean {
  return (
    after.size > 0 &&
    before.size === after.size &&
    [...after].every(([pid, processorMs]) => {
      const earlier = before.get(pid);
      return earlier !== undefined && processorMs <= earlier;
    })
  );
}

// Each running shell's processor time, in milliseconds by process id, or `undefined` when one
// ended between the listing and the reading. Rejects when the reading fails.
async function readProcessorMs(
  shells: readonly ChildProcess[],
): Promise<ReadonlyMap<number, number> | undefined> {
  const running = shells.flatMap((shell) =>
    shell.pid !== undefined && shell.exitCode === null && shell.signalCode === null
      ? [shell.pid]
      : [],
  );
  // On Linux a process that ended between the two reads has a null or missing reading, though the
  // library's types say otherwise; on macOS it is left out.
  const readings: Record<string, pidusage.Status | null | undefined> =
    running.length === 0 ? {} : await pidusage(running);
  const processorMs = new Map<number, number>();
  for (const pid of running) {
    const reading = readings[String(pid)];
    if (reading === null || reading === undefined) {
      return undefined;
    }
    processorMs.set(pid, reading.ctime);
  }
  return processorMs;
}

/**
 * How many session events the damaged file at `path` lists, read through the shell so a large
 * file holds no thread of the daemon's. Rejects when the shell cannot read the count, as a
 * damaged index makes it, and when `signal` aborts, which ends the shell.
 */
export async function countDamagedFileEvents(path: string, signal: AbortSignal): Promise<number> {
  // The recovery's reader opens the file beside it, so the count waits out its locks.
  const { stdout } = await promisify(execFile)(
    SQLITE_SHELL_PROGRAM,
    [
      "-readonly",
      "-cmd",
      `.timeout ${String(SQLITE_SHELL_BUSY_TIMEOUT_MS)}`,
      path,
      `SELECT count(*) FROM ${COUNTED_TABLE}`,
    ],
    { signal, killSignal: "SIGKILL" },
  );
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
    // A stop's abort is told as an error the moment the kill is sent; a shell that started is
    // waited for until it has exited, so nothing still writes when this settles.
    let stopFailure: Error | undefined;
    child.once("error", (error) => {
      if (child.pid === undefined) {
        reject(
          new Error(`The SQLite shell could not start ${step}: ${error.message}`, { cause: error }),
        );
      } else {
        stopFailure = error;
      }
    });
    child.once("close", (exitCode, signal) => {
      if (stopFailure !== undefined) {
        reject(new Error(`The SQLite shell was ended ${step}`, { cause: stopFailure }));
      } else if (exitCode === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `The SQLite shell failed ${step} (${signal ?? `exit ${String(exitCode)}`}): ` +
              errorOutput.trim(),
          ),
        );
      }
    });
  });
}
