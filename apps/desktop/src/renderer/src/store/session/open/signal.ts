// Every open session's projection, as one change signal. The attention read wakes on it: a
// session store that moved is the reason to re-read a projection derived from session state. It
// binds the registry and every store it holds, rebinds as sessions open and close, and releases
// everything on teardown. Nothing here polls or reads a wire.
import type { Unsubscribe } from "#shared/preload-api.js";

import type { SessionStoreRegistry } from "../registry.js";

/**
 * Watch every open session's projection as one signal, released by the returned handle. Which
 * store moved does not travel with the call, since the caller re-reads a whole projection.
 */
export function subscribeToOpenSessions(
  registry: SessionStoreRegistry,
  onSessionChange: () => void,
): Unsubscribe {
  const signal = new OpenSessionSignal(registry, onSessionChange);
  signal.start();
  return () => {
    signal.dispose();
  };
}

/**
 * Every session projection this window holds, as one opaque change signal. A class because it
 * owns two kinds of subscription with a rebinding rule between them: the registry's open/close
 * emitter, and one subscription per open store.
 */
class OpenSessionSignal {
  readonly #registry: SessionStoreRegistry;
  readonly #onSessionChange: () => void;
  readonly #storeReleasesBySessionId = new Map<string, Unsubscribe>();
  #registryRelease: Unsubscribe | undefined;

  public constructor(registry: SessionStoreRegistry, onSessionChange: () => void) {
    this.#registry = registry;
    this.#onSessionChange = onSessionChange;
  }

  /** Bind the registry and every store it already holds, in that order. */
  public start(): void {
    this.#registryRelease = this.#registry.subscribe(() => {
      this.#bindOpenSessions();
      this.#onSessionChange();
    });
    this.#bindOpenSessions();
  }

  /** Release every subscription this signal opened. Terminal. */
  public dispose(): void {
    this.#registryRelease?.();
    this.#registryRelease = undefined;
    for (const release of this.#storeReleasesBySessionId.values()) {
      release();
    }
    this.#storeReleasesBySessionId.clear();
  }

  #bindOpenSessions(): void {
    const openSessionIds = new Set(this.#registry.openSessionIds);
    for (const [sessionId, release] of [...this.#storeReleasesBySessionId]) {
      if (!openSessionIds.has(sessionId)) {
        release();
        this.#storeReleasesBySessionId.delete(sessionId);
      }
    }
    for (const sessionId of openSessionIds) {
      if (this.#storeReleasesBySessionId.has(sessionId)) {
        continue;
      }
      const store = this.#registry.peek(sessionId);
      if (store === undefined) {
        continue;
      }
      this.#storeReleasesBySessionId.set(
        sessionId,
        store.readable.subscribe(() => {
          this.#onSessionChange();
        }),
      );
    }
  }
}
