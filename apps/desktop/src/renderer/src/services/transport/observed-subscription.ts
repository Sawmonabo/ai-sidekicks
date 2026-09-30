// What a daemon subscription's OPEN tells this window about its transport.
//
// THE CYCLE THIS PREVENTS. `transport-reconnect.ts` beside it emits on one transition,
// `unreachable → reachable`, and the session-event subscriber
// (`services/session-events/session-event-subscriber.ts`) is the only consumer that acts
// on the edge. Were it also the only producer, a window whose ONLY session took a
// transient `daemon.subscribe` failure could never leave the state that failure put it
// in: the subscriber would need a returning edge to retry, and the returning edge a
// successful subscription to exist. That session would stay unbound and degraded until
// somebody closed and reopened it, and no amount of transport recovery could reach it.
//
// SO THE OBSERVATION SITS ON THE ONE CALL EVERY SUBSCRIPTION GOES THROUGH. A window
// takes daemon subscriptions for several unrelated reasons — the node's provider-account
// tail, a run queue, a run's state, a feature's own event — and each of those opens is a
// reading of the same transport. Reporting from all of
// them makes the returning edge a fact about the WIRE rather than a fact about one
// session's binding, which is what a retry needs it to be.
//
// WHAT AN OPEN ACTUALLY PROVES, STATED RATHER THAN ASSUMED. `daemon.subscribe` answers
// with an unsubscribe handle or throws, and that is the whole of what the preload
// contract offers: the handler is a payload sink with no error, end, or close arm, and
// no member of `PreloadApi` reports connection state. So an open that RETURNED is
// direct evidence the wire is there, and an open that THREW is direct evidence it is
// not. Neither is an inference from an unrelated failure, which
// `transport-reconnect.ts` refuses and this module does not do: nothing here probes,
// polls, or reads a call's rejection.
//
// WHAT IT STILL DOES NOT SEE is `transport-reconnect.ts`'s own named gap: a
// subscription that opened and then DIED reaches this module through nothing, because
// there is no arm on the contract to hear it from. This narrows that gap rather than
// closing it — every open is observed, not only the subscriber's — and the re-arm is the same
// one that file names.
//
// UNDER THE FIXTURE THE SCENARIO'S SCRIPT IS STILL THE AUTHORITY, and the one place
// the two could disagree is named rather than left to be discovered. The fixture's
// `daemon.subscribe` cannot fail, so every fixture open reports `reachable`; a scenario
// that opened a stream INSIDE one of its own scripted outages would therefore contradict
// its script for as long as it took the next advance to re-assert it. No scenario does:
// fixture streams open when a view mounts, and the only scripted outage in the tree
// begins well after that. The day a scenario opens a stream mid-outage, the fixture's own
// subscribe arm is what refuses under the script — that is the fixture's half of this
// rule, and it belongs there rather than as a branch here.

import type { Unsubscribe } from "@renderer/lib/emitter.js";
import type { TransportReconnectSignal } from "./transport-reconnect.js";

/**
 * Take one daemon subscription, and report what taking it observed.
 *
 * The open is a THUNK rather than an event name and a handler, because the two
 * callers spell the underlying call differently — the session binder names a stream
 * the daemon's method map lists, and the stream seam names run streams the map does
 * not list yet and so widens the name to `string` — and a signature that took an
 * event name would force that widening on both. What this owns is the observation,
 * and it owns only that.
 *
 * The failure is re-raised unchanged. Every caller already has an arm for an open
 * that threw — a refusal a view renders, a retained session id, an all-or-nothing
 * release — and swallowing it here to report a reading would delete those.
 */
export function openObservedSubscription(
  signal: TransportReconnectSignal,
  open: () => Unsubscribe,
): Unsubscribe {
  let release: Unsubscribe;
  try {
    release = open();
  } catch (openFailure: unknown) {
    signal.observe("unreachable");
    throw openFailure;
  }
  // After the open rather than around it: a signal told `reachable` before the call
  // would be reporting an attempt, and the whole value of this reading is that it
  // reports an answer.
  signal.observe("reachable");
  return release;
}
