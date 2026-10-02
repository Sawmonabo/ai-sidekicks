// What a daemon subscription's open tells this window about its transport. `transport-reconnect.ts`
// emits on `unreachable → reachable`, and the session-event subscriber acts on it. If the
// subscriber were also the only producer, a window whose only session hit a transient
// `daemon.subscribe` failure could never leave that state: the retry needs a returning edge and
// the edge needs a successful subscription. So the observation sits on the one call every
// subscription goes through, making the edge a fact about the wire, not one session's binding.
//
// `daemon.subscribe` returns an unsubscribe handle or throws, and no member of `PreloadApi`
// reports connection state, so an open that returned is direct evidence the wire is there and one
// that threw is direct evidence it is not. Nothing here probes, polls or reads a call's rejection.
// A subscription that opened and then died is still unseen (the gap `transport-reconnect.ts`
// names); observing every open narrows it.
//
// Under the fixture, `daemon.subscribe` cannot fail, so every open reports `reachable`; a scenario
// that opened a stream inside one of its scripted outages would contradict its script until the
// next advance. The fixture's own subscribe arm is where that would be refused, not a branch here.

import type { Unsubscribe } from "@renderer/lib/emitter.js";
import type { TransportReconnectSignal } from "./transport-reconnect.js";

/**
 * Takes one daemon subscription and reports what taking it observed. The open is a thunk because
 * callers spell the underlying call differently, and a signature taking an event name would force
 * one spelling. A failure is re-raised unchanged, since every caller has an arm for an open that
 * threw.
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
  // After the open, not around it: a signal told `reachable` before the call would report an
  // attempt, and this reading reports an answer.
  signal.observe("reachable");
  return release;
}
