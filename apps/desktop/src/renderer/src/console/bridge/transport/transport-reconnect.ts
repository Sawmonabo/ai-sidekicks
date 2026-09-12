// The console's one transport-reconnect signal: the wire went away, and it is back.
//
// The console's refresh policy is fixed: on subscribe, on window focus, on
// reconnect, and on the terminal events the owning wire names — and
// several surfaces restate it in their own words — the mounts inventory and the
// diagnostics page name all three. Two of the three were wired anywhere in the console
// and the third was not: the only producer of `RefreshReason`'s `reconnect` was a
// SESSION store's repair edge, so a window-scoped reading — this node's diagnostics,
// this node's accounts, the shell's own preferences — had no session, no repair edge,
// and no reconnect at all.
//
// ONE EMITTER, AND IT OBSERVES RATHER THAN POLLS
//
// Nothing here asks anything. The signal is TOLD what happened, by every daemon
// subscription this window opens — through `observed-subscription.ts` beside this file,
// which holds the one rule for what an open proves and is reported into by the family's
// stream door, by the seat every view family subscribes through, and by the frame's
// session-event binder — and, under the fixture, by the scenario's own scripted outages.
// There is no timer, no probe, and no retry ladder: a renderer that polled to find out
// whether the wire was back would be the interval polling the design forbids, and a
// renderer that inferred it from a call that happened to succeed would be synthesising a
// connection state the supervisor owns.
//
// NO OBSERVER IS ALSO THE ONLY CONSUMER, which is a property rather than a coincidence.
// The binder used to be the sole live producer AND the sole consumer of the edge, so a
// window whose only session failed to bind could never emit the edge that would retry
// it. The observation belongs to the door every subscription passes, so the edge is a
// fact about the wire rather than about one session's binding.
//
// WHAT THE LIVE HALF IS NOT TOLD, STATED RATHER THAN LEFT TO BE DISCOVERED
//
// It is told about ONE moment: whether `daemon.subscribe` returned or threw when a
// caller opened one. A subscription that opened and then DIED — the daemon exiting, the
// IPC channel closing, the stream ending without another payload — reaches this signal
// through nothing, so a window whose wire goes away after every stream is open stays
// at `reachable` and the returning edge never fires for it. The readings that name
// `reconnect` in their refresh policy are correct about the signal they subscribe to
// and wrong about the transport, on that one path.
//
// THAT IS A MISSING SIGNAL AND NOT A MISSING OBSERVER, which is why nothing here
// compensates for it. `SidekicksBridge.daemon.subscribe` is `(event, handler) =>
// Unsubscribe`: the handler is a payload sink with no error, end, or close arm, the
// handle only cancels, and no member anywhere on that bridge — `daemon`,
// `controlPlane`, `native`, `webAuthn`, `update`, `app` — reports connection state.
// There is nothing an observer could listen to. The alternatives are the two this file
// already refuses: a heartbeat probe is the interval polling the design forbids, and
// treating a failed unrelated call as a loss is a connection state this renderer would
// be inventing rather than observing.
//
// THE RE-ARM IS NAMED. The day the preload contract grows a stream-termination arm —
// a handler that is told the stream ended, or a bridge-level connection observable —
// the subscription door reports `unreachable` from it and this paragraph goes. Until
// then the live half covers the loss it can see, the fixture covers both edges by
// script, and the gap is written down here rather than implied by a header that reads
// as though every loss were observed.
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
// REPEATED OBSERVATIONS OF THE SAME STATE ARE FREE. Every subscription reports, so a
// window with four sessions open and two node-scoped tails reports `reachable` six
// times for one transport; only a state CHANGE is a change, so the five redundant
// reports cost nothing and no reading re-reads for them.
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
