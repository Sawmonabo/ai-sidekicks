// The console's one transport-reconnect signal: the wire went away, and it is back. A window-scoped
// reading (this node's diagnostics or accounts, the machine's settings) has no session and no
// repair edge, so this is where its `reconnect` refresh reason comes from.
//
// The signal observes rather than polls. It is told what happened by every daemon subscription the
// window opens, through `observed-subscription.ts` (reported into by
// `services/daemon/daemon-streams.ts` and the session-event subscriber), and under the fixture by
// the scenario's scripted outages.
// There is no timer, probe or retry ladder, and no connection state is inferred from an unrelated
// call, since the supervisor owns that. No single consumer is also the only producer, or a window
// whose only session failed to bind could never emit the edge that retries it.
//
// The live half sees one moment: whether `daemon.subscribe` returned or threw. A subscription that
// opened and then died (daemon exit, IPC closing, stream ending) reaches this signal through
// nothing, so a window whose wire goes away after every stream is open stays `reachable` and no
// edge fires. That is a missing signal, not a missing observer: the handler has no error, end or
// close arm and no bridge member reports connection state, and the alternatives, a heartbeat probe
// or treating a failed unrelated call as a loss, are the ones this design refuses. When the
// preload contract grows a stream-termination arm, `openObservedSubscription` reports
// `unreachable` from it.
//
// The signal has three states and only `unreachable → reachable` emits. `unknown` is where a
// window starts, and a first `reachable` is the transport coming up, not back; a reading's own
// `subscribe` reason already covers that, and firing too would put two reads behind every mounting
// view. Repeated observations of the same state are free, since every subscription reports. It is
// not on `PreloadApi` because the preload exposes no connection state; it sits on `PlatformBridge`.

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
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

  /** How many readings are listening. Asserted by tests, never rendered. */
  public get listenerCount(): number {
    return this.#reconnects.sinkCount;
  }

  /** Release every listener. Terminal for a window whose bridge is being torn down. */
  public dispose(): void {
    this.#reconnects.clear();
  }
}
