// The console's one transport-reconnect signal: the wire went away, and it is back. A window-scoped
// reading (the service's diagnostics or accounts, the machine's settings) has no session and no
// repair edge, so this is where its `reconnect` refresh reason comes from.
//
// The signal observes rather than polls. Its authority is main's `daemon.status` topic, which
// `services/daemon/daemon-status.ts` reads into it: the supervisor owns the link, so a loss after
// every stream is open still reaches here, and so does the link coming back. Every daemon
// subscription the window opens also reports, through `observed-subscription.ts` (from
// `services/daemon/daemon-streams.ts` and the session-event subscriber), and under the fixture the
// scenario's scripted outages do. There is no timer, probe or retry ladder, and no connection
// state is inferred from an unrelated call. No single consumer is also the only producer, or a
// window whose only session failed to bind could never emit the edge that retries it.
//
// A subscription that ends is not a loss of the wire: main tells its owner through the end arm,
// and the owner opens it again. Only the status topic says the service is unreachable.
//
// The signal has three states and only `unreachable → reachable` emits. `unknown` is where a
// window starts, and a first `reachable` is the transport coming up, not back; a reading's own
// `subscribe` reason already covers that, and firing too would put two reads behind every mounting
// view. Repeated observations of the same state are free, since every subscription reports. It is
// one edge, not a connection state, so it sits on `PlatformBridge` rather than `PreloadApi`.

import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { type TransportReconnectObservable } from "@renderer/lib/transport-reconnect.js";

/**
 * What this window has observed about its transport: three states, one of which is "nobody has
 * said". Exported so tests name the states they drive. It is not published on the observable a
 * reading consumes, since a view that could read the state would render it.
 */
export type TransportReachability = "unknown" | "unreachable" | "reachable";

/**
 * The signal, with both halves: observers report and readings subscribe. One instance is held per
 * bridge, so two windows in one process do not share a reading only one of them observed.
 */
export class TransportReconnectSignal implements TransportReconnectObservable {
  readonly #reconnects = new Emitter<void>("transport reconnect");
  #reachability: TransportReachability = "unknown";

  /** What has been observed so far. Read by tests and by nothing that renders. */
  public get reachability(): TransportReachability {
    return this.#reachability;
  }

  /**
   * Records what an observer saw and emits exactly on the returning edge. One entry point for both
   * states, since the edge is a property of the transition and this class decides it once.
   */
  public observe(reachability: Exclude<TransportReachability, "unknown">): void {
    const wasUnreachable = this.#reachability === "unreachable";
    this.#reachability = reachability;
    if (wasUnreachable && reachability === "reachable") {
      this.#reconnects.emit();
    }
  }

  public subscribe(onReconnect: () => void): Unsubscribe {
    return this.#reconnects.subscribe(onReconnect);
  }
}
