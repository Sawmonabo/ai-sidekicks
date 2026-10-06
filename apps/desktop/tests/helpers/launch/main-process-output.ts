// What the launched main process said, so a launch that fails before its window is ready says why
// in main's own words, where Playwright reports only that its page or browser has closed. Two
// records: main's own log in the launch's profile, which holds every failure main recorded, and
// the end of its stderr from the spawn on, which holds what main's log never sees, such as a native
// crash. Playwright owns main's spawn and hands its process over only after `ready`, by when a
// startup failure may already be written and gone from the pipe, so the stderr is read from the
// moment Node creates the process, which its `child_process` diagnostics channel announces.

import type { ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import path from "node:path";

import { MAIN_DIAGNOSTIC_LOG_FILE_NAME } from "#main/services/diagnostic-log.js";
import { describeFailure } from "#shared/failure-message.js";
import { PROFILE_LOGS_FOLDER_NAME } from "#main/services/install-profile.js";

/** How much of each record a failed launch carries: its end, where a startup failure is written. */
const RECORD_TAIL_BYTES = 8 * 1024;

/** Node's channel that publishes every child process as it is created. */
const CHILD_PROCESS_CHANNEL = "child_process";

/** How main stood when the launch failed, read before the close ends it and removes its profile. */
export interface MainStanding {
  /** The code or signal main had exited with, or that it was still running. */
  readonly exitStatus: string;
  /** The end of main's log, or what kept it from being read. */
  readonly logTail: string;
}

/** Main's log in a launch's profile, and the end of its stderr read from the spawn on. */
export class MainProcessOutput {
  readonly #logFilePath: string;
  readonly #userDataSwitch: string;
  #child: ChildProcess | undefined;
  #stderrTail: Buffer = Buffer.alloc(0);

  /**
   * Watches for the process launched on `profileDirectory`, reading its stderr from its spawn.
   * Make it before the launch and call `stopWatching` once the launch settles.
   */
  public constructor(profileDirectory: string) {
    this.#userDataSwitch = `--user-data-dir=${profileDirectory}`;
    this.#logFilePath = path.join(
      profileDirectory,
      PROFILE_LOGS_FOLDER_NAME,
      MAIN_DIAGNOSTIC_LOG_FILE_NAME,
    );
    subscribe(CHILD_PROCESS_CHANNEL, this.#onChildCreated);
  }

  /** Stops watching for new processes; the stderr of the one found is still read. */
  public stopWatching(): void {
    unsubscribe(CHILD_PROCESS_CHANNEL, this.#onChildCreated);
  }

  /**
   * Confirms the process Playwright handed over is the one whose spawn was seen. Throws when no
   * spawn was seen, when it was another process, or when main has no stderr, since main's own
   * words would then be missing from a failure.
   */
  public confirmHandover(child: ChildProcess): void {
    if (this.#child === undefined) {
      throw new Error(`no process was seen starting with ${this.#userDataSwitch}`);
    }
    if (this.#child !== child) {
      throw new Error(
        `the launched main process was not the one seen starting with ${this.#userDataSwitch}`,
      );
    }
    if (child.stderr === null) {
      throw new Error("the launched main process has no stderr to read");
    }
  }

  /** How main stands now. Read it before the close, which ends main and removes the profile. */
  public standing(): MainStanding {
    if (this.#child === undefined) {
      return {
        exitStatus: `no process was seen starting with ${this.#userDataSwitch}`,
        logTail: this.#readLogTail(),
      };
    }
    let exitStatus = "main was still running";
    const { exitCode, signalCode } = this.#child;
    if (exitCode !== null) {
      exitStatus = `main exited with code ${String(exitCode)}`;
    } else if (signalCode !== null) {
      exitStatus = `main was ended by ${signalCode}`;
    }
    return { exitStatus, logTail: this.#readLogTail() };
  }

  /** `failure` with main's `standing` and the end of its stderr; `failure` stays as the cause. */
  public failureWith(failure: unknown, standing: MainStanding): Error {
    const failureMessage = describeFailure(failure);
    const stderrTail = this.#stderrTail.toString("utf8").trimEnd();
    return new Error(
      `${failureMessage}\n${standing.exitStatus} when the launch failed.\n` +
        `The end of main's log:\n${standing.logTail}\n` +
        `The end of main's stderr:\n` +
        (stderrTail === "" ? "<nothing>" : stderrTail),
      { cause: failure },
    );
  }

  // The channel publishes the process as it is constructed, before its arguments and pipes are
  // set; they are read on the microtask after the spawn, ahead of any read from the pipe.
  readonly #onChildCreated = (message: unknown): void => {
    const child = (message as { readonly process: ChildProcess }).process;
    queueMicrotask(() => {
      if (!child.spawnargs.includes(this.#userDataSwitch)) {
        return;
      }
      this.#child = child;
      child.stderr?.on("data", (chunk: Buffer) => {
        this.#stderrTail = tailOf(Buffer.concat([this.#stderrTail, chunk]));
      });
    });
  };

  #readLogTail(): string {
    let log: Buffer;
    try {
      log = readFileSync(this.#logFilePath);
    } catch (error: unknown) {
      // A main that stopped before it wrote a line leaves no log; any other failure is said.
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "<no log was written>"
        : `<the log could not be read: ${describeFailure(error)}>`;
    }
    return tailOf(log).toString("utf8").trimEnd();
  }
}

function tailOf(bytes: Buffer): Buffer {
  return bytes.subarray(Math.max(0, bytes.length - RECORD_TAIL_BYTES));
}
