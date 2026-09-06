// What a reading needs of the console's transport-reconnect signal, and nothing more.
//
// `Spec-023 §Console Design (Meridian)` fixes the refresh policy under "No interval
// polling": "Reads happen on subscribe, on window focus, on reconnect, and on the
// terminal events the owning spec names". Three of those four were wired and the
// third was not — `RefreshReason` named `reconnect`, one session-scoped producer
// raised it from a session store's own repair edge, and a window-scoped reading (this
// node's diagnostics, this node's accounts, the shell's preferences) had no session,
// therefore no repair edge, and therefore no reconnect at all.
//
// WHY THE INTERFACE IS HERE AND THE EMITTER IS NOT
//
// The producer belongs to `bridge/`: what "the transport came back" MEANS is a fact
// about the wire, and the wire is that family's. The consumer is `store/`, which sits
// BELOW `bridge/` in the console's family DAG precisely so a store cannot reach a wire
// — so the reading hooks cannot import the emitter, and an emitter declared in `store/`
// would put the wire's own vocabulary underneath the layer that owns it.
//
// `core/` is the floor both may reach, and what lives here is the half a consumer
// needs: the subscribe view. It holds no state, decides nothing, and names no
// transport. `bridge/transport/transport-reconnect.ts` is the implementation, and it
// is the only thing in the console allowed to decide that a reconnect happened.
//
// ONE FACT, NOT A CONNECTION STATE. Deliberately not `isConnected` or a three-arm
// reachability enum: a surface that could read the current state would render it, and
// a renderer that painted "connected" would be claiming a fact it observes only
// indirectly (`Spec-023 §Console Design (Meridian)` — the tray's three states are the
// supervisor's, not the renderer's). What crosses this boundary is an EDGE — the wire
// was away and is back — which is the one thing a reading has to act on.

import type { Unsubscribe } from "./emitter.js";

/**
 * The console's transport-reconnect signal, as a consumer sees it.
 *
 * One method, and the sink takes no payload: a reconnect carries no data a reading
 * could read, and a payload would be an invitation to render one.
 */
export interface TransportReconnectObservable {
  /**
   * Called once each time the transport is observed to come back after being away.
   *
   * Never called for a FIRST connection, which is not a reconnect: a reading's own
   * `subscribe` reason already covers the moment it opens, and firing here as well
   * would put two reads behind every surface that mounts.
   */
  subscribe(onReconnect: () => void): Unsubscribe;
}
