// The capabilities of the build a Codex service runs, probed on a connection of its own that
// starts no conversation.

import type { CapabilityProbeRequest } from "../../../capability/probe.js";
import type { GetCapabilitiesResult } from "../../contract.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { getCodexCapabilities, readCodexCapabilityDetection } from "../capabilities.js";
import { CodexProviderRequestError, CodexTransportError } from "../session/errors.js";
import type { CodexService } from "./supervisor.js";

/**
 * Starts `service` if it has not started and probes its build's capabilities. Throws when the
 * service cannot start or reported no build.
 */
export async function probeCodexServiceCapabilities(
  service: CodexService,
  diagnostics: DriverDiagnosticsEmitter,
): Promise<GetCapabilitiesResult> {
  await service.ensureStarted();
  const reading = service.versionReading;
  if (reading === undefined) {
    throw new CodexTransportError("The Codex service reported no build at its start.", {
      codexHome: service.home.codexHome,
    });
  }
  const connection = await service.openDetachedConnection();
  try {
    const detection = await readCodexCapabilityDetection(
      reading,
      async (request: CapabilityProbeRequest): Promise<unknown> => {
        // The reply's own shape, as the probe classifier reads it.
        try {
          return { result: await connection.request(request.probeName, {}) };
        } catch (cause) {
          if (cause instanceof CodexProviderRequestError) {
            return { error: { code: cause.providerErrorCode, message: cause.providerMessage } };
          }
          throw cause;
        }
      },
      diagnostics,
    );
    return getCodexCapabilities(reading, detection);
  } finally {
    connection.close();
  }
}
