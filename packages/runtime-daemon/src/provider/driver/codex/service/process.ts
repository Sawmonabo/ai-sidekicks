// The Codex processes the daemon starts as its children: the long-running service, how it ends,
// with the tail of what it printed, and how the daemon stops it; and a short command run to its
// end for what it prints.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "@ai-sidekicks/contracts/provider/driver/length-limits";

import type { SpawnEnvPair } from "../../../spawn-env.js";

/** What one Codex process runs: a service start or a short command. */
export interface CodexProcessLaunch {
  /** The resolved Codex executable, absolute. */
  readonly command: string;
  readonly args: readonly string[];
  /** The whole environment; nothing is inherited from the daemon. */
  readonly environment: readonly SpawnEnvPair[];
  readonly workingDirectory: string;
}

/** One running service process. */
export interface CodexServiceProcess {
  /**
   * Settles when the process ends, with its code or signal and the tail of its output. Rejects
   * when it could not start at all.
   */
  readonly exited: Promise<ProcessExit>;
  /** Asks the process to stop; `exited` settles when it has. */
  stop(): void;
  /** Ends the process at once, for one that did not stop when asked. */
  kill(): void;
}

/** Starts one service process. */
export type CodexServiceLauncher = (launch: CodexProcessLaunch) => CodexServiceProcess;

/** Starts the service with `child_process`, keeping the last stretch of what it prints. */
export const launchCodexServiceProcess: CodexServiceLauncher = (launch) => {
  const child = spawn(launch.command, [...launch.args], {
    cwd: launch.workingDirectory,
    env: Object.fromEntries(launch.environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputTail = "";
  const keepTail = (chunk: Buffer): void => {
    outputTail = (outputTail + chunk.toString("utf8")).slice(-DRIVER_FAILURE_DETAIL_MAX_LEN);
  };
  child.stdout.on("data", keepTail);
  child.stderr.on("data", keepTail);
  const exited = new Promise<ProcessExit>((resolve, reject) => {
    child.once("error", reject);
    // On `close`, after the output streams ended, so the tail holds the last words printed.
    child.once("close", (exitCode, signal) => {
      // Never empty on the wire: a process that printed nothing says so.
      const tail = outputTail.trim().length > 0 ? outputTail : "(no output)";
      resolve(
        signal === null
          ? { exitCode: exitCode ?? 0, outputTail: tail }
          : { signal, outputTail: tail },
      );
    });
  });
  // Marked handled here: the supervisor reads it, and a start that failed must not crash the
  // daemon before it does.
  exited.catch(() => undefined);
  return {
    exited,
    stop: () => {
      child.kill("SIGTERM");
    },
    kill: () => {
      child.kill("SIGKILL");
    },
  };
};

/**
 * Runs one short Codex command to its end and resolves with its standard output. Rejects on a
 * non-zero exit, a signal, the deadline (`timeoutMs`, milliseconds) or output past the cap.
 */
export type CodexCommandRunner = (run: CodexProcessLaunch, timeoutMs: number) => Promise<string>;

// The catalog dump carries every model's full instructions, measured near 660 KB.
const CODEX_COMMAND_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const runProgram = promisify(execFile);

/** Runs a short Codex command with `child_process`, on the launch's own environment. */
export const runCodexCommand: CodexCommandRunner = async (run, timeoutMs) => {
  const { stdout } = await runProgram(run.command, [...run.args], {
    cwd: run.workingDirectory,
    env: Object.fromEntries(run.environment),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: CODEX_COMMAND_MAX_OUTPUT_BYTES,
  });
  return stdout;
};
