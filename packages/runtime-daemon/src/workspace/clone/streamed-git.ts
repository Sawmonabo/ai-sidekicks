// One git run whose stderr is read as it comes, for a command that reports progress (a clone, a
// large-files pull) or one the service's stop must end (the background fetch), with a stop that
// asks git and every helper it started to end, then kills them after a grace.

import { spawn } from "node:child_process";

import { DAEMON_STOP_TERMINAL_DRAIN_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";

import { buildGitEnvironment, gitNotFoundError } from "../../git/process.js";
import { endProcessTree } from "../../process-tree.js";

/**
 * How long git has to end after a person's cancel before it and its helpers are killed: five
 * seconds, long enough for git to remove what it was writing, short enough that a cancel is felt.
 */
export const CANCEL_STOP_GRACE_MS = 5_000;

/** How long git has to end at the service's stop: the window the stop gives its terminals. */
export const SHUTDOWN_STOP_GRACE_MS: number = DAEMON_STOP_TERMINAL_DRAIN_MS;

/** What one streamed git run takes. */
interface StreamedGitOptions {
  /** Layered over the git environment, per run. */
  readonly environmentOverrides?: Readonly<Record<string, string>> | undefined;
  /** Receives git's stderr as it arrives. */
  readonly onStderr: (chunk: string) => void;
  /** Ends git and its helpers when aborted. */
  readonly signal: AbortSignal;
  /** Read when `signal` aborts: how long git has to end before it and its helpers are killed. */
  readonly stopGraceMs: () => number;
}

/** How a streamed git run ended: its exit status, or the signal that ended it. */
export interface StreamedGitExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Runs git with `argv`, never through a shell, its stdout dropped and stdin closed. Resolves when
 * git and its stderr have closed, however it ended; rejects when git could not be started, or when
 * a stop could not signal git and its helpers, so the caller never waits on a close that may not
 * come.
 */
function runStreamedGit(
  executable: string,
  argv: readonly string[],
  options: StreamedGitOptions,
): Promise<StreamedGitExit> {
  return new Promise<StreamedGitExit>((resolve, reject) => {
    const child = spawn(executable, [...argv], {
      env: buildGitEnvironment(options.environmentOverrides),
      stdio: ["ignore", "ignore", "pipe"],
      // Its own process group, so a stop reaches the transport helpers git starts.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hasClosed = false;
    const failStop = (failure: unknown): void => {
      options.signal.removeEventListener("abort", stop);
      reject(new Error("git could not be stopped", { cause: failure }));
    };
    const stop = (): void => {
      if (child.pid === undefined) return;
      const pid = child.pid;
      // Armed before the polite end is sent, so the kill keeps to the grace however long it takes.
      killTimer = setTimeout(() => {
        endProcessTree(pid, "SIGKILL").catch(failStop);
      }, options.stopGraceMs());
      endProcessTree(pid, "SIGTERM").catch((endFailure: unknown) => {
        clearTimeout(killTimer);
        // Git that already closed has ended, so the failed signal changed nothing.
        if (hasClosed) return;
        // Git may still be running, so it is killed at once rather than after the grace.
        endProcessTree(pid, "SIGKILL").then(
          () => {
            failStop(endFailure);
          },
          (killFailure: unknown) => {
            failStop(new AggregateError([endFailure, killFailure], "git could not be ended"));
          },
        );
      });
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", options.onStderr);
    child.once("error", (error) => {
      options.signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("spawn", () => {
      if (options.signal.aborted) stop();
      else options.signal.addEventListener("abort", stop, { once: true });
    });
    child.once("close", (exitCode, signal) => {
      hasClosed = true;
      clearTimeout(killTimer);
      options.signal.removeEventListener("abort", stop);
      resolve({ exitCode, signal });
    });
  });
}

/** Runs one streamed git through the `git` the daemon found at start. */
export type StreamedGitRunner = (
  argv: readonly string[],
  options: StreamedGitOptions,
) => Promise<StreamedGitExit>;

/**
 * The streamed runner for the `git` at `executablePath`. With none found, each run rejects with an
 * `ENOENT` failure, as the daemon's other git runs do.
 */
export function createStreamedGitRunner(executablePath: string | undefined): StreamedGitRunner {
  if (executablePath === undefined) {
    return () => Promise.reject(gitNotFoundError());
  }
  return (argv, options) => runStreamedGit(executablePath, argv, options);
}
