// What a reading needs of the transport-reconnect signal: only the subscribe view.
//
// A window-scoped reading (this node's diagnostics or accounts, the machine's settings) has no
// session and so no repair edge, and this signal is how it learns of a reconnect. The interface is
// here and the emitter is not: what "the transport came back" means is the wire's fact, owned by
// `services/transport/reconnect.ts`, and `store/` sits below `services/` and cannot
// import it. `lib/` is the layer both reach.
//
// It is one edge (the wire was away and is back), not a connection state: the state is main's
// `daemon.status` topic, held in the window store, and a reading only re-reads on the edge.

import type { Unsubscribe } from "#shared/preload-api.js";

/** The transport-reconnect signal as a consumer sees it. The sink takes no payload. */
export interface TransportReconnectObservable {
  /**
   * Called once each time the transport comes back after being away. Never called for a first
   * connection: a reading's own `subscribe` reason covers that, and firing here too would put two
   * reads behind every mounting view.
   */
  subscribe(onReconnect: () => void): Unsubscribe;
}

/**
 * The signal for a reading that touches no wire, and for a unit probe that drives no outage. It
 * is a named constant, not an optional parameter, so a wire-backed reading cannot quietly default
 * to never re-reading after a reconnect. A case about reconnect drives a real
 * `TransportReconnectSignal` instead.
 */
export const NO_TRANSPORT_RECONNECT: TransportReconnectObservable = {
  subscribe: () => () => undefined,
};
