// A diagnostics emitter for suites that read diagnostics from the emitter, not the console.

import { DriverDiagnosticsEmitter } from "../driver-diagnostics.js";

/**
 * A diagnostics emitter whose log and counter sinks discard: the default log sink writes to the
 * console, which would fill test output. The emitter still retains its records for assertions.
 */
export function makeSilentDriverDiagnostics(): DriverDiagnosticsEmitter {
  return new DriverDiagnosticsEmitter({
    logSink: { record: () => undefined },
    counterSink: { increment: () => undefined },
  });
}
