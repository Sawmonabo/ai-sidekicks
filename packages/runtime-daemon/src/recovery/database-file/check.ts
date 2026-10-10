// The start's structural check of the database file: `PRAGMA quick_check`, run in the daemon's own
// `sqlite3` shell as a child process, so the check holds neither the main thread nor any thread
// that serves a write or a search, and a stop ends it at once. A binding call could not be cut
// short: a thread inside one ends only when the call returns, which on a large file outlasts the
// stop's drain bound. The shell reads the file read-only, waiting out a writer's lock, and answers
// as it stood when the check began.

import { spawn } from "node:child_process";

import { refuseUnfitShell, SQLITE_SHELL_BUSY_TIMEOUT_MS } from "./sqlite-shell.js";

/**
 * What the check found: the file is sound, or damaged, with what SQLite reported; or `stopped`
 * when a stop ended it first.
 */
export type DatabaseFileCheckAnswer =
  | { readonly outcome: "sound" }
  | { readonly outcome: "damaged"; readonly damage: string }
  | { readonly outcome: "stopped" };

// The tail of the shell's output kept for a damage or a failure's message.
const OUTPUT_KEPT_BYTES = 4_096;

// SQLite's own texts for SQLITE_CORRUPT and SQLITE_NOTADB, which the shell prints when the file is
// too damaged to open or to walk; any other failure means the check could not run.
const DAMAGE_ERROR_TEXTS = ["database disk image is malformed", "file is not a database"];

/** One run of the check on the daemon's database file. Start it with {@link start}. */
export class DatabaseFileCheck {
  /**
   * Resolves with what the check found. Rejects when the shell is unfit or could not check the
   * file.
   */
  readonly answer: Promise<DatabaseFileCheckAnswer>;

  readonly #stopRequest = new AbortController();

  private constructor(databasePath: string, shellProgram: string) {
    this.answer = this.#run(databasePath, shellProgram).catch((error: unknown) => {
      if (this.#stopRequest.signal.aborted) {
        return { outcome: "stopped" } as const;
      }
      throw error;
    });
  }

  /**
   * Starts the check of the file at `databasePath`, which exists, in the shell at `shellProgram`;
   * returns at once.
   */
  static start(databasePath: string, shellProgram: string): DatabaseFileCheck {
    return new DatabaseFileCheck(databasePath, shellProgram);
  }

  /** Ends the shell if it still runs; the answer then settles `stopped` once it has exited. */
  stop(): void {
    this.#stopRequest.abort();
  }

  async #run(databasePath: string, shellProgram: string): Promise<DatabaseFileCheckAnswer> {
    await refuseUnfitShell(shellProgram);
    this.#stopRequest.signal.throwIfAborted();
    const shell = spawn(
      shellProgram,
      [
        "-readonly",
        "-cmd",
        `.timeout ${String(SQLITE_SHELL_BUSY_TIMEOUT_MS)}`,
        databasePath,
        "PRAGMA quick_check",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        signal: this.#stopRequest.signal,
        killSignal: "SIGKILL",
      },
    );
    let output = "";
    let errorOutput = "";
    shell.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output = (output + chunk).slice(-OUTPUT_KEPT_BYTES);
    });
    shell.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errorOutput = (errorOutput + chunk).slice(-OUTPUT_KEPT_BYTES);
    });
    // A stop's kill raises an error too; the check still waits for the shell's exit, so its read
    // of the file has ended once the answer comes.
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        shell.once("error", (error) => {
          if (shell.pid === undefined) {
            reject(error);
          }
        });
        shell.once("close", (code, signal) => {
          resolve({ code, signal });
        });
      },
    );
    this.#stopRequest.signal.throwIfAborted();
    const found = output.trim();
    // A damage the walk can step past is printed as rows and the shell still exits cleanly.
    if (found !== "" && found !== "ok") {
      return { outcome: "damaged", damage: found };
    }
    if (DAMAGE_ERROR_TEXTS.some((text) => errorOutput.includes(text))) {
      return { outcome: "damaged", damage: errorOutput.trim() };
    }
    if (exit.code === 0 && found === "ok") {
      return { outcome: "sound" };
    }
    throw new Error(
      `The database file's check could not run (${exit.signal ?? `exit ${String(exit.code)}`}): ` +
        errorOutput.trim(),
    );
  }
}
