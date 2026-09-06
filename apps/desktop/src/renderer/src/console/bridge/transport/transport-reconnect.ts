// The console's one transport-reconnect signal: the wire went away, and it is back.
//
// `Spec-023 §Console Design (Meridian)` fixes the refresh policy as "on subscribe, on
// window focus, on reconnect, and on the terminal events the owning spec names", and
// several surfaces restate it in their own words — the mounts inventory and the
// diagnostics page name all three. Two of the three were wired anywhere in the console
// and the third was not: the only producer of `RefreshReason`'s `reconnect` was a
// SESSION store's repair edge, so a window-scoped reading — this node's diagnostics,
// this node's accounts, the shell's own preferences — had no session, no repair edge,
// and no reconnect at all.
//
// ONE EMITTER, AND IT OBSERVES RATHER THAN POLLS
//
// Nothing here asks anything. The signal is TOLD what happened, by the one thing in
// the console that talks to the transport (`frame/session-event-binder.ts`, which owns
// every `daemon.subscribe` this window takes) and, under the fixture, by the scenario's
// own scripted outages. There is no timer, no probe, and no retry ladder: a renderer
// that polled to find out whether the wire was back would be the interval polling the
// design forbids, and a renderer that inferred it from a call that happened to succeed
// would be synthesising a connection state the supervisor owns.
//
// WHAT AN EDGE IS, AND WHY A FIRST CONNECTION IS NOT ONE
//
// The signal holds three states, and only one transition emits. `unknown` is where a
// window starts — nothing has been observed, so nothing is claimed. `unreachable` is
// a loss somebody observed. `reachable` is the wire working. The emit is
// `unreachable → reachable` and nothing else: a first `reachable` is the transport
// coming up rather than coming back, and a reading's own `subscribe` reason already
// covers the moment it opens. Firing there too would put two reads behind every
// surface that mounts, on a signal whose whole justification is that it costs nothing
// when nothing happened.
//
// REPEATED OBSERVATIONS OF THE SAME STATE ARE FREE. The binder reports `reachable`
// once per bound session, so a window with four sessions open reports it four times
// for one transport; only a state CHANGE is a change, so the three redundant reports
// cost nothing and no reading re-reads for them.
//
// WHY IT IS NOT ON `SidekicksBridge`
//
// The preload contract is what the preload actually exposes, and it exposes no
// connection state. Putting one there would make the fixture shape-identical to a
// lie — the same reasoning that keeps the growth port beside the bridge rather than
// inside it. This sits on `ConsoleBridge` beside the port, where the console's own
// seams live.

import { Emitter, type TransportReconnectObservable, type Unsubscribe } from "../../core/index.js";

/**
 * What this window has observed about its transport. Three states, one of which is
 * the honest "nobody has said".
 *
 * Exported because the tests that drive the signal name the states they drive it
 * through, and a test spelling them as bare strings would be a second vocabulary.
 * Deliberately NOT published on the observable a reading consumes: a surface that
 * could read the current state would render it.
 */
export type TransportReachability = "unknown" | "unreachable" | "reachable";

/**
 * The signal, with both halves: the observers report, the readings subscribe.
 *
 * A class with a private field rather than a module-level flag, per
 * `apps/desktop/AGENTS.md`: the reachability is state, one instance is held per
 * bridge, and a module-level one would make two windows in one process share a
 * transport reading that only one of them observed.
 */
export class TransportReconnectSignal implements TransportReconnectObservable {
  readonly #reconnects = new Emitter<void>("transport reconnect");
  #reachability: TransportReachability = "unknown";

  /** What has been observed so far. Read by tests and by nothing that renders. */
  public get reachability(): TransportReachability {
    return this.#reachability;
  }

  /**
   * Record what an observer saw. Emits exactly on the returning edge.
   *
   * One entry point for both states rather than a `reportLoss` / `reportReturn`
   * pair, because the edge is a property of the TRANSITION and an observer that had
   * to choose which method to call would be deciding, at the call site, something
   * this class exists to decide once.
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
