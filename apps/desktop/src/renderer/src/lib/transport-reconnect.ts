// What a reading needs of the transport-reconnect signal: only the subscribe view.
//
// A window-scoped reading (this node's diagnostics or accounts, the machine's settings) has no
// session and so no repair edge, and this signal is how it learns of a reconnect. The interface is
// here and the emitter is not: what "the transport came back" means is the wire's fact, owned by
// `services/transport/transport-reconnect.ts`, and `store/` sits below `services/` and cannot
// import it. `lib/` is the layer both reach.
//
// It is one edge (the wire was away and is back), not a connection state: a view that could read
// state would render "connected", a fact the renderer only observes indirectly.

import type { Unsubscribe } from "./emitter.js";

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
