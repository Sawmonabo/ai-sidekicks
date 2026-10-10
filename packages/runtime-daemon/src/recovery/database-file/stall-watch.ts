// The watch that stops a recovery whose shells have both stopped working: once no byte has passed
// between them for a whole window it reads each running shell's processor time, and once a further
// window passes in which no byte passed, no shell exited and none used the processor, it ends both.
// A shell that works, however slowly, uses some processor time in every window, while one blocked
// for good uses none, so a recovery that is only slow, on a busy machine or a large file, goes on
// however long it takes.

import type { ChildProcess } from "node:child_process";

import pidusage from "pidusage";

/** How long the recovery may pass no byte before the shells' processor time is read. */
export const RECOVERY_STALL_WINDOW_MS = 60_000;

/** The shells a watch reads, and how. */
export interface RecoveryStallWatchOptions {
  /** How long a window lasts, in milliseconds. */
  readonly windowMs: number;
  /**
   * Each running shell's processor time, in milliseconds by process id, or `undefined` when one
   * ended between the listing and the reading. Rejects when the reading fails.
   */
  readonly readProcessorMs: (
    shells: readonly ChildProcess[],
  ) => Promise<ReadonlyMap<number, number> | undefined>;
  readonly writeServiceLog: (line: string) => void;
}

/** Watches a recovery's shells for a stall, from its construction until {@link end}. */
export class RecoveryStallWatch {
  readonly #shells: readonly ChildProcess[];
  readonly #options: RecoveryStallWatchOptions;
  readonly #timer: NodeJS.Timeout;
  // Each running shell's processor time at the last reading since a byte last passed, in
  // milliseconds by process id.
  #lastReading: ReadonlyMap<number, number> | undefined;
  #isStalled = false;
  #hasEnded = false;

  constructor(shells: readonly ChildProcess[], options: RecoveryStallWatchOptions) {
    this.#shells = shells;
    this.#options = options;
    this.#timer = setTimeout(() => {
      void this.#readProgress();
    }, options.windowMs);
  }

  /** Whether the watch ended the shells as stalled. */
  get isStalled(): boolean {
    return this.#isStalled;
  }

  /** Starts the window again: bytes passed between the shells. */
  notePassedBytes(): void {
    this.#lastReading = undefined;
    this.#timer.refresh();
  }

  /** Stops watching; the shells have exited. */
  end(): void {
    this.#hasEnded = true;
    clearTimeout(this.#timer);
  }

  // A reading that fails never counts as a stall: the log says why, and the next window reads
  // again.
  async #readProgress(): Promise<void> {
    let reading: ReadonlyMap<number, number> | undefined;
    try {
      reading = await this.#options.readProcessorMs(this.#shells);
    } catch (error) {
      this.#options.writeServiceLog(
        "The recovery's processor time could not be read, so its progress is read again after " +
          `the next window: ${error instanceof Error ? error.message : String(error)}`,
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

/**
 * Each running shell's processor time through the system's process table, in milliseconds by
 * process id, or `undefined` when one ended between the listing and the reading. Rejects when the
 * reading fails.
 */
export async function readShellProcessorMs(
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
