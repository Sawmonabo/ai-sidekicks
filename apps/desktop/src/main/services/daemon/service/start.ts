// Starting the background service as the person's own process, never the app's child: detached
// into its own session, its standard streams connected to nothing, and the handle released, so
// the service, its runs and its shells keep running when the app quits, is killed, or crashes.
// Main reaches it only through its socket.

import { spawn } from "node:child_process";

import { serviceProcessOf, type ServiceExit, type ServiceProcess } from "./service-process.js";
import type { ServiceProgram } from "./service-program.js";

/**
 * Start the service program detached and resolve once the process exists. Rejects with the
 * operating system's error when it cannot start, an absent program included.
 */
export function startServiceDetached(
  program: ServiceProgram,
  environment: NodeJS.ProcessEnv,
): Promise<ServiceProcess> {
  return new Promise<ServiceProcess>((resolve, reject) => {
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
    child.once("error", (error) => {
      reject(error);
    });
    child.once("spawn", () => {
      const processId = child.pid;
      if (processId === undefined) {
        reject(new Error(`The background service ${program.command} started with no process id`));
        return;
      }
      // Released only once it exists: an unref'd handle still reports its exit while main runs.
      child.unref();
      // Main's own child keeps its id until main reaps it, so its exit alone says it has gone.
      resolve(
        serviceProcessOf({
          processId,
          hasExited: () => hasExited,
          whenExited: () => exited.promise,
          isRunning: () => Promise.resolve(!hasExited),
          signal: (name) => {
            child.kill(name);
          },
        }),
      );
    });
  });
}
