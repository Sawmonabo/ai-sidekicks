// Readies a repair's fresh file on a thread of its own, which can take minutes on a file of
// several gigabytes, while the main thread goes on answering that the service is repairing.

import { Worker } from "node:worker_threads";

import { rebuildError, type CarriedError } from "../../../worker/carried-error.js";
import { moduleUrlBeside } from "../../../worker/module-url.js";

/** What the fresh file's thread is started with. */
export interface FreshFileWorkerData {
  readonly freshPath: string;
  /** A copy of the newest backup's database beside the file, or `undefined` with none. */
  readonly backupCopyPath: string | undefined;
}

/** A line for the service log, or how the thread ended: the file ready, or why it is refused. */
export type FreshFileReply =
  | { readonly type: "log"; readonly line: string }
  | { readonly type: "prepared"; readonly sessionsFromBackup: number }
  | { readonly type: "failed"; readonly error: CarriedError };

const WORKER_URL = moduleUrlBeside(import.meta.url, "worker");

/**
 * Takes each session the backup copy holds more readable events of from it, then readies the
 * fresh file, and resolves with how many sessions came from the backup. Rejects when the file
 * lacks an object of the schema or fails the full integrity check, or when the thread fails.
 */
export function prepareFreshFile(
  workerData: FreshFileWorkerData,
  writeServiceLog: (line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData });
    let outcome: FreshFileReply | undefined;
    worker.on("message", (reply: FreshFileReply) => {
      if (reply.type === "log") {
        writeServiceLog(reply.line);
      } else {
        outcome = reply;
      }
    });
    worker.once("error", reject);
    // The thread's last message arrives before its exit.
    worker.once("exit", (code) => {
      if (outcome?.type === "prepared") {
        resolve(outcome.sessionsFromBackup);
      } else if (outcome?.type === "failed") {
        reject(rebuildError(outcome.error));
      } else {
        reject(new Error(`The fresh file's thread exited with code ${String(code)} and no answer`));
      }
    });
  });
}
