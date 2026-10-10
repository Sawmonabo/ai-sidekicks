// The socket a start answers on while it repairs the database file, which on a large file takes
// minutes: it binds before the repair and answers every hello that carries its session token with
// `daemon.repairing`, so a client knows the service is alive and waits for it rather than ending
// it as one that never answered. It serves nothing else, and goes once the repair has ended, so
// the start binds its own socket over the repaired file.

import type { DaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";

import { withCleanupFailures } from "../cleanup-failures.js";
import { LocalIpcGateway } from "../ipc/local-gateway.js";
import { ProtocolNegotiator } from "../ipc/protocol-negotiation.js";
import { MethodRegistryImpl } from "../ipc/registry.js";
import { bindSocket, mintSessionToken, prepareRunFolder } from "./run-folder.js";

/**
 * Runs `repair` while the run folder's socket answers that the service is repairing, and returns
 * what it returns. Throws `DaemonAlreadyRunningError` when a daemon answers there already.
 */
export async function answerRepairingWhile<T>(
  runFolder: DaemonRunFolder,
  repair: () => Promise<T>,
): Promise<T> {
  const sessionToken = mintSessionToken();
  const negotiator = new ProtocolNegotiator(sessionToken);
  const registry = new MethodRegistryImpl();
  negotiator.registerRepairingHandshakeMethod(registry);
  const gateway = new LocalIpcGateway({ registry });
  await prepareRunFolder(runFolder);
  await bindSocket(gateway, runFolder, sessionToken);
  let repaired: T;
  try {
    repaired = await repair();
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
