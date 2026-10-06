// What the launched main process said, so a launch that fails before its window is ready says why
// in main's own words, where Playwright reports only that its page or browser has closed. Two
// records, because Playwright owns main's spawn and hands its process over only after `ready`,
// once a startup failure may already be written: main's own log in the launch's profile, which
// holds every failure main recorded from its start, and the end of its stderr since the handover,
// which holds what main's log never sees, such as a native crash.

import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { MAIN_DIAGNOSTIC_LOG_FILE_NAME } from "#main/services/diagnostic-log.js";
import { PROFILE_LOGS_FOLDER_NAME } from "#main/services/install-profile.js";

/** How much of each record a failed launch carries: its end, where a startup failure is written. */
const RECORD_TAIL_BYTES = 8 * 1024;

/** How main stood when the launch failed, read before the close ends it and removes its profile. */
export interface MainStanding {
  /** The code or signal main had exited with, or that it was still running. */
  readonly exitStatus: string;
  /** The end of main's log, or what kept it from being read. */
  readonly logTail: string;
}

/** Main's log in a launch's profile, and the end of its stderr read from the handover on. */
export class MainProcessOutput {
  readonly #child: ChildProcess;
  readonly #logFilePath: string;
  #stderrTail: Buffer = Buffer.alloc(0);

  /**
   * Reads `child`'s stderr from now on, and main's log in `profileDirectory` when asked. Throws
   * when the process was handed over with no stderr.
   */
  public constructor(child: ChildProcess, profileDirectory: string) {
    const { stderr } = child;
    if (stderr === null) {
      throw new Error("the launched main process has no stderr to read");
    }
    this.#child = child;
    this.#logFilePath = path.join(
      profileDirectory,
      PROFILE_LOGS_FOLDER_NAME,
      MAIN_DIAGNOSTIC_LOG_FILE_NAME,
    );
    stderr.on("data", (chunk: Buffer) => {
      this.#stderrTail = tailOf(Buffer.concat([this.#stderrTail, chunk]));
    });
  }

  /** How main stands now. Read it before the close, which ends main and removes the profile. */
  public standing(): MainStanding {
    const { exitCode, signalCode } = this.#child;
    let exitStatus = "main was still running";
    if (exitCode !== null) {
      exitStatus = `main exited with code ${String(exitCode)}`;
    } else if (signalCode !== null) {
      exitStatus = `main was ended by ${signalCode}`;
    }
    return { exitStatus, logTail: this.#readLogTail() };
  }

  /** `failure` with main's `standing` and the end of its stderr; `failure` stays as the cause. */
  public failureWith(failure: unknown, standing: MainStanding): Error {
    const failureMessage = failure instanceof Error ? failure.message : String(failure);
    const stderrTail = this.#stderrTail.toString("utf8").trimEnd();
    return new Error(
      `${failureMessage}\n${standing.exitStatus} when the launch failed.\n` +
        `The end of main's log:\n${standing.logTail}\n` +
        `The end of main's stderr since the launch handed it over:\n` +
        (stderrTail === "" ? "<nothing>" : stderrTail),
      { cause: failure },
    );
  }

  #readLogTail(): string {
    let log: Buffer;
    try {
      log = readFileSync(this.#logFilePath);
    } catch (error: unknown) {
      // A main that stopped before it wrote a line leaves no log; any other failure is said.
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "<no log was written>"
        : `<the log could not be read: ${String(error)}>`;
    }
    return tailOf(log).toString("utf8").trimEnd();
  }
}

function tailOf(bytes: Buffer): Buffer {
  return bytes.subarray(Math.max(0, bytes.length - RECORD_TAIL_BYTES));
}
