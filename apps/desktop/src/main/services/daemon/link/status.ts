// Main's link to the background service: what main knows about the service and the link, and the
// client main calls through while a link is up. The supervisor is its one writer; main's own callers
// read the client from it, and the service's status topic delivers its state to every window.

import type { DaemonConnection, MainProcessState } from "#shared/daemon/status-topic.js";

import type { MainDaemonClient } from "../client/process.js";

/** What a call that needs the link answers while none is up. */
export const NOT_CONNECTED_MESSAGE = "The background service is not connected.";

/** Told of each new state, the current one first. */
export type DaemonLinkListener = (state: MainProcessState) => void;

/** The state of a link in `connection` with no service linked, so nothing more is known. */
export function unlinkedState(connection: DaemonConnection): MainProcessState {
  return {
    connection,
    negotiation: undefined,
    startedByApp: undefined,
    whileSignedOut: undefined,
    cannotStart: undefined,
    cannotStop: undefined,
  };
}

/** What main has before the supervisor's first report: looking for the service. */
const CONNECTING_STATE: MainProcessState = unlinkedState({ kind: "connecting" });

/** The service's state as main knows it, and the daemon client while a link is up. */
export class DaemonLink {
  #client: MainDaemonClient | undefined;
  #state: MainProcessState = CONNECTING_STATE;
  readonly #listeners = new Set<DaemonLinkListener>();

  /** The client of the link that is up, or `undefined` while none is. */
  public get client(): MainDaemonClient | undefined {
    return this.#client;
  }

  /** What main knows about the service and its link now. */
  public get state(): MainProcessState {
    return this.#state;
  }

  /**
   * Hear every state from now on, the current one delivered at once. The returned function stops
   * the deliveries; calling it again does nothing.
   */
  public subscribe(listener: DaemonLinkListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** A link came up: hold its client and report the state it came up in. */
  public attach(client: MainDaemonClient, state: MainProcessState): void {
    this.#client = client;
    this.#publish(state);
  }

  /** The link is gone: drop its client, so nothing is sent on it, and report why. */
  public detach(state: MainProcessState): void {
    this.#client = undefined;
    this.#publish(state);
  }

  /** A new state with no change to the link, such as a start under way. */
  public report(state: MainProcessState): void {
    this.#publish(state);
  }

  #publish(state: MainProcessState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      listener(state);
    }
  }
}
