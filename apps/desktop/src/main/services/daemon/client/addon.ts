// What the client helper uses of the daemon client's Node-API addon: its one connect, the wait for
// a daemon that is starting, the client a connect answers with, the client's ending of the
// service, a process's identity, the status file's place and the client's bounds.

import type {
  DaemonClient,
  DaemonEndingOutcome,
  DaemonEndingRequest,
} from "@ai-sidekicks/client-sdk";
import type { DaemonRepairingDetails } from "@ai-sidekicks/contracts/daemon/recovery";
import type { DaemonCannotStart } from "@ai-sidekicks/contracts/daemon/service-status";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { ConnectionInitializeResponse } from "@ai-sidekicks/contracts/jsonrpc/negotiation";

/** What the helper uses of the daemon client the addon connects. */
export type ClientHelperDaemonClient = Pick<
  DaemonClient,
  "call" | "cancelCall" | "subscribe" | "cancelStream" | "openShellInput" | "close"
>;

/**
 * A connect's answer from the addon: the client and the daemon's handshake answer, or the error
 * and, when the failure says, why the service cannot start.
 */
export interface ClientHelperConnectAnswer {
  readonly client?: ClientHelperDaemonClient;
  readonly initializeResponse?: ConnectionInitializeResponse;
  readonly error?: JsonRpcError;
  readonly cannotStart?: DaemonCannotStart;
}

/**
 * What the helper uses of the addon: its one connect, its wait for a daemon that is starting, which
 * hands each answer that the daemon is repairing to `onRepairing`, the client's ending, the read of
 * a process's identity, the status file's place, and the client's two bounds.
 */
export interface ClientHelperAddon {
  connect(
    presentsToken: boolean,
    onState: (state: string) => void,
  ): Promise<ClientHelperConnectAnswer>;
  waitForDaemon(
    presentsToken: boolean,
    onState: (state: string) => void,
    onRepairing: (details: DaemonRepairingDetails) => void,
  ): Promise<ClientHelperConnectAnswer>;
  endDaemon(request: DaemonEndingRequest, presentsToken: boolean): Promise<DaemonEndingOutcome>;
  /** Takes the identity as the JSON the addon reads. */
  endDaemonProcess(processIdentityJson: string): Promise<DaemonEndingOutcome>;
  /** The identity as JSON, or `null` when no process holds the id; throws the system's error. */
  readProcessIdentity(processId: number): string | null;
  /** Throws when this system has no run folder. */
  daemonStatusFilePath(): string;
  readonly HANDSHAKE_DEADLINE_MS: number;
  readonly DAEMON_FLUSH_WAIT_MS: number;
}
