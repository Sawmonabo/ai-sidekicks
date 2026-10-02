// The callback-tool host wired to recording sinks, shared by the host's tests and the Codex ask
// responder's tests.

import type { RunId, SessionCallbackTool, SessionId } from "@ai-sidekicks/contracts";

import {
  bindCallbackToolsForSpawn,
  CallbackToolHost,
  type CallbackToolActivityRecord,
  type CallbackToolApprovalOutcome,
  type CallbackToolApprovalRequest,
  type CallbackToolSpawnBinding,
} from "../callback-tool-host.js";
import { DriverDiagnosticsEmitter, type DriverDiagnosticRecord } from "../driver-diagnostics.js";
import type { CallbackToolInvocation, CallbackToolResult } from "../provider-driver.js";

/** The session every harness invocation and ask names. */
export const TEST_SESSION_ID: SessionId = "11111111-1111-4111-8111-111111111111" as SessionId;
/** The run every harness invocation and ask names. */
export const TEST_RUN_ID: RunId = "22222222-2222-4222-8222-222222222222" as RunId;

/** The one callback tool a default spawn registers. */
export const SEARCH_TOOL: SessionCallbackTool = {
  name: "search_workspace",
  description: "Searches the session's mounted workspace.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

/** A host wired to recording sinks, with everything it emitted, recorded and ran. */
export interface CallbackToolHostHarness {
  readonly host: CallbackToolHost;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly emittedDiagnostics: DriverDiagnosticRecord[];
  readonly activityRecords: CallbackToolActivityRecord[];
  readonly evaluatedRequests: CallbackToolApprovalRequest[];
  readonly executedInvocations: CallbackToolInvocation[];
}

/**
 * Builds a host whose approval seam answers `outcome` (allow by default), or none with
 * `withSeam: false`, and whose executor returns `executeResult` or throws `executeThrows`.
 */
export function buildCallbackToolHostHarness(options?: {
  readonly outcome?: CallbackToolApprovalOutcome;
  readonly withSeam?: boolean;
  readonly executeResult?: CallbackToolResult;
  readonly executeThrows?: Error;
  readonly evaluateThrows?: unknown;
}): CallbackToolHostHarness {
  const emittedDiagnostics: DriverDiagnosticRecord[] = [];
  const activityRecords: CallbackToolActivityRecord[] = [];
  const evaluatedRequests: CallbackToolApprovalRequest[] = [];
  const executedInvocations: CallbackToolInvocation[] = [];
  const diagnostics = new DriverDiagnosticsEmitter({
    logSink: { record: (record) => emittedDiagnostics.push(record) },
    counterSink: { increment: () => undefined },
  });
  const outcome: CallbackToolApprovalOutcome = options?.outcome ?? {
    decision: "allow",
    basis: "policy",
  };
  const host = new CallbackToolHost({
    provider: "claude",
    diagnostics,
    executor: {
      execute: async (invocation) => {
        executedInvocations.push(invocation);
        if (options?.executeThrows !== undefined) {
          throw options.executeThrows;
        }
        return await Promise.resolve(
          options?.executeResult ?? { status: "completed", output: { hits: 0 } },
        );
      },
    },
    activitySink: { record: (record) => activityRecords.push(record) },
    ...(options?.withSeam === false
      ? {}
      : {
          approvalSeam: {
            evaluate: async (request) => {
              evaluatedRequests.push(request);
              if (options?.evaluateThrows !== undefined) {
                throw options.evaluateThrows;
              }
              return await Promise.resolve(outcome);
            },
          },
        }),
  });
  return {
    host,
    diagnostics,
    emittedDiagnostics,
    activityRecords,
    evaluatedRequests,
    executedInvocations,
  };
}

/** A spawn's registry request for `requestedTools`, with provider registration available. */
export function searchSpawnRequest(
  requestedTools: readonly SessionCallbackTool[] = [SEARCH_TOOL],
): Parameters<CallbackToolHost["resolveSpawnRegistry"]>[0] {
  return {
    sessionId: TEST_SESSION_ID,
    requestedTools,
    providerRegistrationAvailable: true,
    providerRegistrationUnavailableDetail: "unused",
  };
}

/** Binds one spawn's registry on the harness host. */
export function bindSpawn(
  harness: CallbackToolHostHarness,
  requestedTools: readonly SessionCallbackTool[] = [SEARCH_TOOL],
): CallbackToolSpawnBinding {
  return bindCallbackToolsForSpawn(harness.host, searchSpawnRequest(requestedTools));
}
