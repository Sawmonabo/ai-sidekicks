// Registers `daemon.appDiagnostic.record`: what the desktop app records about itself becomes one line
// of the service log, so it is kept, and dropped past its bound, with the service's own lines.

import { DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/app-diagnostic";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import { registerDescribedMethod } from "../ipc/handlers/register-described-method.js";
import type { ServiceLogWriter } from "./service-log.js";

// The words each app diagnostic line starts with, so a reader can pick them out of the log.
const APP_DIAGNOSTIC_LINE_PREFIX = "App diagnostic:";

/** Registers `daemon.appDiagnostic.record`, writing each record to the service log as one JSON line. */
export function registerAppDiagnosticMethods(
  registry: MethodRegistry,
  writeServiceLog: ServiceLogWriter,
): void {
  registerDescribedMethod(
    registry,
    DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS["daemon.appDiagnostic.record"],
    (record) => {
      writeServiceLog(`${APP_DIAGNOSTIC_LINE_PREFIX} ${JSON.stringify(record)}`);
      return Promise.resolve({});
    },
  );
}
