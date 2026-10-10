// Registers `daemon.status.read`: the service's own facts in one reply, for Settings › Runtime and
// `sidekicks daemon status`. Processor and memory are read on each call, never on a timer; a call
// whose reading fails still answers, with both `null` and the failure in the service log.

import type { DaemonRecoveryStatus } from "@ai-sidekicks/contracts/daemon/recovery";
import {
  DAEMON_STATUS_METHOD_DESCRIPTORS,
  type DaemonProcessState,
} from "@ai-sidekicks/contracts/daemon/status";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import { registerDescribedMethod } from "../ipc/handlers/register-described-method.js";
import type { ProcessTreeUsage } from "./process-tree-usage.js";
import { describeRejection } from "../rejection.js";

/** The running daemon's facts the status read reports. */
export interface StatusMethodsDeps {
  /** The daemon's own process as the system knows it, read once at its start. */
  readonly processIdentity: ProcessIdentity;
  /** Where the daemon is in its own life at the moment of the call. */
  readonly readProcessState: () => DaemonProcessState;
  /** Where the node stands in its recovery from the last restart, at the moment of the call. */
  readonly readRecovery: () => DaemonRecoveryStatus;
  /** The service's own release version. */
  readonly version: string;
  /** The socket the daemon listens on. */
  readonly transportEndpoint: string;
  /** The data folder this daemon holds. */
  readonly dataDirectory: string;
  readonly startedAt: Date;
  readonly now: () => Date;
  /** Reads the daemon's process and every process under it. */
  readonly readProcessTreeUsage: () => Promise<ProcessTreeUsage>;
  /** Writes one line to the service log. */
  readonly writeServiceLog: (line: string) => void;
}

/** Registers `daemon.status.read`, a read-only query. */
export function registerStatusMethods(registry: MethodRegistry, deps: StatusMethodsDeps): void {
  registerDescribedMethod(
    registry,
    DAEMON_STATUS_METHOD_DESCRIPTORS["daemon.status.read"],
    async () => {
      const usage = await readUsageOrNull(deps);
      const readAt = deps.now();
      return {
        processState: deps.readProcessState(),
        processIdentity: deps.processIdentity,
        version: deps.version,
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        transportEndpoint: deps.transportEndpoint,
        startedAt: deps.startedAt.toISOString(),
        uptimeMs: Math.max(0, readAt.getTime() - deps.startedAt.getTime()),
        dataDirectory: deps.dataDirectory,
        processor:
          usage === null ? null : { percent: usage.processorPercent, readAt: readAt.toISOString() },
        memory:
          usage === null
            ? null
            : { residentBytes: usage.residentBytes, readAt: readAt.toISOString() },
        recovery: deps.readRecovery(),
      };
    },
  );
}

// The reading is the reply's `null` when it fails, so a reader learns it was not taken; the cause
// goes to the service log.
async function readUsageOrNull(deps: StatusMethodsDeps): Promise<ProcessTreeUsage | null> {
  try {
    return await deps.readProcessTreeUsage();
  } catch (failure) {
    const reason = describeRejection(failure);
    deps.writeServiceLog(`The processor and memory reading failed: ${reason}`);
    return null;
  }
}
