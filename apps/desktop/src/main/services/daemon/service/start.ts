// Starting the background service as the person's own process, never the app's child: detached
// into its own session, its standard streams connected to nothing, and the handle released, so
// the service, its runs and its shells keep running when the app quits, is killed, or crashes.
// Main reaches it only through its socket, and ends it only through the client's ending.

import { spawn } from "node:child_process";

import type { ServiceProgram } from "./program.js";

/**
 * How a started service process ended: its exit code or the signal that ended it, as the system
 * reports the exit of main's own child.
 */
export interface ServiceExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A service process main started, whose exit it hears while it runs. */
export interface StartedService {
  /** The process id the operating system gave it. */
  readonly processId: number;
  /** Whether the process has exited. */
  hasExited(): boolean;
  /** Resolves once the process has exited. */
  whenExited(): Promise<ServiceExit>;
}

/**
 * Start the service program detached and resolve once the process exists. Rejects with the
 * operating system's error when it cannot start, an absent program included.
 */
export function startServiceDetached(
  program: ServiceProgram,
  environment: NodeJS.ProcessEnv,
): Promise<StartedService> {
  return new Promise<StartedService>((resolve, reject) => {
    const child = spawn(program.command, [...program.args], {
      detached: true,
      stdio: "ignore",
      env: environment,
    });
    let hasExited = false;
    const exited = Promise.withResolvers<ServiceExit>();
    child.once("exit", (code, signal) => {
      hasExited = true;
      exited.resolve({ code, signal });
    });
    // Only a failed start reaches here: main never signals this child, and it has no channel.
    child.once("error", reject);
    child.once("spawn", () => {
      const processId = child.pid;
      if (processId === undefined) {
        reject(new Error(`The background service ${program.command} started with no process id`));
        return;
      }
      // Released only once it exists: an unref'd handle still reports its exit while main runs.
      child.unref();
      resolve({ processId, hasExited: () => hasExited, whenExited: () => exited.promise });
    });
  });
}
