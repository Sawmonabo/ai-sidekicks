// Registers `daemon.appError.record`: an error nothing handled in the desktop app becomes one line
// of the service log, so it is kept, and dropped past its bound, with the service's own lines.

import { DAEMON_APP_ERROR_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/app-error";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import { registerDescribedMethod } from "../ipc/handlers/register-described-method.js";
import type { ServiceLogWriter } from "./service-log.js";

// The words each app error line starts with, so a reader can pick them out of the log.
const APP_ERROR_LINE_PREFIX = "App error:";

/** Registers `daemon.appError.record`, writing each record to the service log as one JSON line. */
export function registerAppErrorMethods(
  registry: MethodRegistry,
  writeServiceLog: ServiceLogWriter,
): void {
  registerDescribedMethod(
    registry,
    DAEMON_APP_ERROR_METHOD_DESCRIPTORS["daemon.appError.record"],
    (record) => {
      writeServiceLog(`${APP_ERROR_LINE_PREFIX} ${JSON.stringify(record)}`);
      return Promise.resolve({});
    },
  );
}
