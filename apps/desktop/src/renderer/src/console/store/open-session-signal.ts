// Every open session's projection, as one change signal — and the one fold the frame
// takes over it.
//
// TWO CALLERS, ONE MECHANISM, AND THAT IS WHY IT IS HERE. The attention read wakes on
// this signal (a session store that moved is the honest reason to re-read a
// projection derived from canonical session state), and the frame's honest chrome
// folds the stores' own degraded causes off it. Those are different jobs over one
// piece of machinery: bind the registry, bind every store it currently holds, rebind
// as sessions open and close, release everything on teardown. Written twice it would
// be two answers to "which stores am I watching", and the second copy would go quiet
// for exactly the sessions a person had just opened — which is the bug the rebinding
// rule exists to prevent.
//
// It lives in `store/` because that is the lowest family that owns both inputs: the
// registry and the stores are this family's, and the two callers sit above it on
// opposite sides of the console DAG — `frame/` and a view family — so neither could
// have hosted it for the other.
//
// NOTHING HERE POLLS AND NOTHING HERE READS A WIRE. The signal is a subscription over
// values the window already holds.

import { useCallback, useSyncExternalStore } from "react";

import type { Unsubscribe } from "@ai-sidekicks/contracts";

import { worstDegradedCause, type SessionDegradedCause } from "./degradation.js";
import type { SessionStoreRegistry } from "./session-store-registry.js";

/**
 * Every session projection this window holds, as one opaque change signal.
 *
 * A class rather than a closure over a `Map`, because it owns two kinds of
 * subscription with a rebinding rule between them: the registry's own open/close
 * emitter, and one subscription per open session store. A session opened after this
 * signal started has to be bound, and a session closed has to be released.
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

/**
 * Watch every open session's projection as one signal.
 *
 * The shape both callers take: opened once, answered by calling back, released by the
 * handle it returns. Nothing about which store moved travels with the call, because
 * neither caller asks — one re-reads a whole projection and the other re-folds a
 * whole window.
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
 * The worst degraded cause standing across this window's open sessions.
 *
 * `store/degradation.ts` decides which of several standing causes survives; the
 * stores decide when one is standing; this is the fold that lets the frame render the
 * answer. A window with no open session, or one whose stores are all whole, answers
 * `undefined` — which is "nothing is recovering", not "nothing was checked", because
 * the stores this reads are the ones the window itself holds.
 *
 * `useSyncExternalStore` rather than state plus an effect: the snapshot is a primitive
 * compared by `Object.is`, so a window whose stores move without the WORST cause
 * moving re-renders nothing at all — which matters because this drives frame chrome
 * and a stream of ordinary events would otherwise repaint the rail on every batch.
 */
export function useWorstOpenSessionRecovery(
  registry: SessionStoreRegistry,
): SessionDegradedCause | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToOpenSessions(registry, onStoreChange),
    [registry],
  );
  const getSnapshot = useCallback(() => worstOpenSessionRecovery(registry), [registry]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The fold itself, so a caller outside React can take it too. */
export function worstOpenSessionRecovery(
  registry: SessionStoreRegistry,
): SessionDegradedCause | undefined {
  const causes = registry.openSessionIds.map(
    (sessionId) => registry.peek(sessionId)?.readable.getState().degradedCause,
  );
  return worstDegradedCause(...causes);
}
