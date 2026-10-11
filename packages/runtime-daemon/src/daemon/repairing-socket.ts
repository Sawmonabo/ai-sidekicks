// The socket a start answers on while it repairs the database file, which on a large file takes
// minutes: it binds before the repair and answers every hello that carries its session token with
// `daemon.repairing`, with how far the repair has come where it can say, so a client knows the
// service is alive and waits for it rather than ending it as one that never answered. On a
// connection whose hello carried the token it serves the lifecycle verbs too, so a stop or a
// restart asked for over the socket ends the repair as a terminate signal does; it serves nothing
// else, and goes once the repair has ended, so the start binds its own socket over the repaired
// file.

import type { DaemonRepairProgress } from "@ai-sidekicks/contracts/daemon/recovery";
import type { DaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";

import { withCleanupFailures } from "../cleanup-failures.js";
import { LocalIpcGateway } from "../ipc/local-gateway.js";
import { ProtocolNegotiator } from "../ipc/protocol-negotiation.js";
import { MethodRegistryImpl } from "../ipc/registry.js";
import { registerLifecycleMethods } from "./lifecycle-methods.js";
import { bindSocket, mintSessionToken, prepareRunFolder } from "./run-folder.js";

/**
 * Runs `repair` while the run folder's socket answers that the service is repairing, with the
 * progress `repair` last reported, and returns what it returns; the signal `repair` is handed
 * aborts once a stop or a restart is asked for over the socket. A connection's or the listener's
 * failure goes to `writeServiceLog`. Throws `DaemonAlreadyRunningError` when a daemon answers
 * there already.
 */
export async function answerRepairingWhile<T>(
  runFolder: DaemonRunFolder,
  repair: (
    reportProgress: (progress: DaemonRepairProgress | undefined) => void,
    stopAsked: AbortSignal,
  ) => Promise<T>,
  writeServiceLog: (line: string) => void,
): Promise<T> {
  const sessionToken = mintSessionToken();
  const negotiator = new ProtocolNegotiator(sessionToken);
  const registry = negotiator.wrap(new MethodRegistryImpl());
  let progress: DaemonRepairProgress | undefined;
  negotiator.registerRepairingHandshakeMethod(registry, () => progress);
  const stopRequest = new AbortController();
  registerLifecycleMethods(registry, {
    // Nothing is open to write while the file is repaired.
    flush: () => Promise.resolve(),
    // The stop starts one turn later, after this call's reply has been handed to the socket.
    acceptStop: () => {
      setImmediate(() => {
        stopRequest.abort(new Error("A stop was asked for over the socket"));
      });
      return Promise.resolve();
    },
  });
  const gateway = new LocalIpcGateway({
    registry,
    hooks: {
      onDisconnect: (transport) => {
        negotiator.cleanupTransport(transport.id);
      },
      onError: (transport, error) => {
        writeServiceLog(`Connection ${String(transport.id)} failed: ${describeError(error)}`);
      },
      onListenerError: (error) => {
        writeServiceLog(`The repairing socket's listener failed: ${describeError(error)}`);
      },
    },
  });
  await prepareRunFolder(runFolder);
  await bindSocket(gateway, runFolder, sessionToken);
  let repaired: T;
  try {
    repaired = await repair((reported) => {
      progress = reported;
    }, stopRequest.signal);
  } catch (repairError) {
    const cleanupFailures: unknown[] = [];
    try {
      await gateway.stop();
    } catch (error) {
      cleanupFailures.push(error);
    }
    throw withCleanupFailures(repairError, cleanupFailures, "The database file's repair");
  }
  await gateway.stop();
  return repaired;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
