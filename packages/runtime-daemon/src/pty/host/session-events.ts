import type { PtyHost } from "./contract.js";

/** One PTY session's own output and exit listeners. */
export interface PtySessionListeners {
  readonly onData: (chunk: Uint8Array) => void;
  readonly onExit: (exitCode: number, signalCode?: number) => void;
}

/**
 * Follows one PTY session's output and exit until the returned call; the host's listeners serve
 * every session, so the daemon hands each session's events to its own.
 */
export type FollowPtySession = (sessionId: string, listeners: PtySessionListeners) => () => void;

/**
 * Hands each PTY session's output and exit to that session's own listeners, so a session's shells
 * and every provider process share the host's one output listener and one exit listener.
 */
export class PtySessionEvents {
  readonly #listeners = new Map<string, PtySessionListeners>();

  constructor(host: Pick<PtyHost, "setOnData" | "setOnExit">) {
    // A session no one follows any more, closed while its last event was on the way, has no
    // listener left to hand the event to.
    host.setOnData((sessionId, chunk) => {
      this.#listeners.get(sessionId)?.onData(chunk);
    });
    host.setOnExit((sessionId, exitCode, signalCode) => {
      const listeners = this.#listeners.get(sessionId);
      this.#listeners.delete(sessionId);
      listeners?.onExit(exitCode, signalCode);
    });
  }

  /** Follows one session's output and exit until the returned call, or until it exits. */
  follow(sessionId: string, listeners: PtySessionListeners): () => void {
    this.#listeners.set(sessionId, listeners);
    return () => {
      if (this.#listeners.get(sessionId) === listeners) {
        this.#listeners.delete(sessionId);
      }
    };
  }
}
