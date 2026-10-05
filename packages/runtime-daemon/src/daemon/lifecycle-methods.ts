// Registers the service's lifecycle verbs: the flush a quit sends, the stop and restart Settings ›
// Runtime and the command line send, and the answer to the main process's ping on a quiet link.

import { DAEMON_LIFECYCLE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon-lifecycle";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc-registry";

import { registerDescribedMethod } from "../ipc/handlers/register-described-method.js";

/** What the lifecycle verbs act on: the running daemon. */
export interface LifecycleMethodsDeps {
  /** Resolves once every write pending at the call is durable; stops nothing. */
  readonly flush: () => Promise<void>;
  /**
   * Starts the daemon's stop once the current reply is written; the stop waits for the writes
   * already under way within its drain bound. The caller's terminate signal, and the kill after
   * it, end a daemon whose stop hangs.
   */
  readonly acceptStop: () => Promise<void>;
}

/**
 * Registers `daemon.flush`, `daemon.stop`, `daemon.restart` and `daemon.ping`. A stop goes ahead
 * with no wait for the other connected clients; a restart ends the daemon as a stop does, and its
 * caller starts it again.
 */
export function registerLifecycleMethods(
  registry: MethodRegistry,
  deps: LifecycleMethodsDeps,
): void {
  registerDescribedMethod(
    registry,
    DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.flush"],
    async () => {
      await deps.flush();
      return { flushed: true } as const;
    },
  );

  const stop = async (): Promise<{ accepted: true }> => {
    await deps.acceptStop();
    return { accepted: true };
  };
  registerDescribedMethod(registry, DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.stop"], stop);
  registerDescribedMethod(registry, DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.restart"], stop);

  // The answer arriving is the whole of it.
  registerDescribedMethod(registry, DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.ping"], () =>
    Promise.resolve({}),
  );
}
