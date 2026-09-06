// The fixture's half of the transport-reconnect signal: a scenario's scripted outages,
// played on the frozen clock.
//
// The live half is an observation — `frame/session-event-binder.ts` reports what
// happened to the one subscription this window takes. There is nothing to observe under
// the fixture, because the fixture's `daemon.subscribe` cannot fail, so a scenario
// SCRIPTS the outage instead and this module walks the script.
//
// WHY IT RIDES THE ENGINE'S ADVANCE AND NOT ITS BEATS
//
// A transport outage is not an event in the session's log — no `SessionEventType` says
// "the wire went away", and inventing a beat kind for one would put a fabricated row in
// the store every surface reads. What an outage IS is a fact about scenario time, so it
// rides `ScenarioEngine.subscribeToAdvance`, which reports the clock rather than the log
// and fires on advances that carry no beat at all. An outage scheduled between two beats
// is exactly the case a beat-driven schedule would miss.
//
// EDGES ARE COMPUTED, NEVER COUNTED. Each pass asks what the scenario says the state
// should be at the current instant and reports THAT, rather than tracking which outages
// have already been played. A single `advance(10_000)` therefore crosses a whole outage
// and settles on `reachable`, which is what the clock actually did — and the signal
// itself is what decides whether that crossing was an edge, because it is the one place
// in the console allowed to decide a reconnect happened.

import type { Unsubscribe } from "../../core/index.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";
import type { TransportReconnectSignal } from "../transport/transport-reconnect.js";

/**
 * Whether the scenario's script says the transport is away at one instant.
 *
 * Half-open on the restore edge — `lostAtMs <= now < restoredAtMs` — so an outage
 * scripted to end at 400 is over at 400 rather than at 401. That matters because a
 * screenshot or an endurance step advances to an exact tick and the boundary is where
 * the interesting frame is; an inclusive end would put the restore one tick beyond
 * every instant an author wrote down.
 *
 * Exported so the player and its test read one rule rather than two.
 */
export function isTransportLostAt(
  outages: readonly { readonly lostAtMs: number; readonly restoredAtMs: number }[],
  elapsedMs: number,
): boolean {
  return outages.some((outage) => elapsedMs >= outage.lostAtMs && elapsedMs < outage.restoredAtMs);
}

/**
 * Bind one scenario's scripted outages to one window's transport signal.
 *
 * Returns the release, which the fixture bridge owns: nothing here holds a timer, and
 * the only resource is the engine subscription.
 *
 * A scenario that scripts no outage takes no subscription at all — there is nothing to
 * wake for, and a sink attached to every advance of every fixture window is a cost paid
 * by scenarios that never asked for it.
 */
export function playScenarioTransportOutages(
  engine: ScenarioEngine,
  signal: TransportReconnectSignal,
): Unsubscribe {
  const outages = engine.scenario.transportOutages ?? [];
  if (outages.length === 0) {
    return () => undefined;
  }
  return engine.subscribeToAdvance((elapsedMs) => {
    signal.observe(isTransportLostAt(outages, elapsedMs) ? "unreachable" : "reachable");
  });
}
