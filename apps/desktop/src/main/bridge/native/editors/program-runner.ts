// Runs one of the operating system's programs for the editor list and the editor open, and answers
// what it printed. Each run is bounded, so a program that hangs never holds a bridge call open.

import { execFile } from "node:child_process";

/**
 * Runs a program with its arguments and answers its standard output. Rejects when the program
 * cannot start, exits non-zero, or outlives its bound.
 */
export type ProgramRunner = (
  command: string,
  programArguments: readonly string[],
) => Promise<string>;

/**
 * How long one run may take. A launcher hands the file to the editor and returns at once, and the
 * app-register read answers in under half a second on a warm machine, so a run still going at this
 * bound is stuck rather than slow.
 */
const PROGRAM_RUN_BOUND_MS = 10_000;

/** The runner over `child_process.execFile`, with no shell between the call and the program. */
export const runProgram: ProgramRunner = (command, programArguments) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...programArguments],
      { timeout: PROGRAM_RUN_BOUND_MS, encoding: "utf8" },
      (failure, standardOutput) => {
        if (failure === null) {
          resolve(standardOutput);
        } else {
          reject(failure);
        }
      },
    );
  });
