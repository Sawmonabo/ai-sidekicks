// Main's link to the background service: what main knows about the service and the link, and the
// daemon client while a link is up. The supervisor is its one writer; the bridge reads it for every
// call the renderer forwards, and the service's status topic delivers it to every window.

import type { JsonRpcClient } from "@ai-sidekicks/client-sdk";

import type { MainProcessState } from "@shared/daemon/daemon-status-topic.js";

/** Told of each new state, the current one first. */
export type DaemonLinkListener = (state: MainProcessState) => void;

/** What main has before the supervisor's first report: looking for the service. */
const CONNECTING_STATE: MainProcessState = {
  connection: { kind: "connecting" },
  negotiation: undefined,
  startedByApp: undefined,
  whileSignedOut: undefined,
  cannotStart: undefined,
};

/** The service's state as main knows it, and the daemon client while a link is up. */
export class DaemonLink {
  #client: JsonRpcClient | undefined;
  #state: MainProcessState = CONNECTING_STATE;
  readonly #listeners = new Set<DaemonLinkListener>();

  /** The client of the link that is up, or `undefined` while none is. */
  public get client(): JsonRpcClient | undefined {
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
  public attach(client: JsonRpcClient, state: MainProcessState): void {
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
