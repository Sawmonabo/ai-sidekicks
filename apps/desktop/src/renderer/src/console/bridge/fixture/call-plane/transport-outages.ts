// The fixture's half of the transport-reconnect signal: a scenario's scripted outages,
// played on the frozen clock.
//
// The live half is an observation — `../transport/observed-subscription.ts` reports what
// happened when a subscription was opened. There is no LOSS to observe under the
// fixture, because the fixture's `daemon.subscribe` cannot fail, so a scenario SCRIPTS
// the outage instead and this module walks the script. The script is the fixture's
// authority: a fixture open reports `reachable` like any other, so a scenario that opened
// a stream inside its own outage would contradict itself until the next advance re-asserts
// the script — none does, because fixture streams open when a surface composes and the one
// scripted outage in the tree begins well after that.
//
// WHY IT RIDES THE ENGINE'S ADVANCE AND NOT ITS BEATS
//
// A transport outage is not an event in the session's log — no `SessionEventType` says
// "the wire went away", and inventing a beat kind for one would put a fabricated row in
// the store every surface reads. What an outage IS is a fact about scenario time, so it
// rides `ScenarioEngine.subscribeToAdvances`, which reports the clock rather than the log
// and fires on advances that carry no beat at all. An outage scheduled between two beats
// is exactly the case a beat-driven schedule would miss.
//
// EVERY CROSSED EDGE IS PLAYED, NOT JUST THE ONE THE ADVANCE LANDED ON
//
// The pass used to ask only what the script said the state should be at the instant the
// advance landed on, and report THAT. One `advance(10_000)` over an outage from 100 to
// 400 therefore sampled `reachable` and reported `reachable` — the state was right and
// the EDGE was gone, so the signal never saw `unreachable`, never emitted a returning
// edge, and every reading wired to `reconnect` stayed exactly as stale as it was before
// the wire went away. A single advance across a whole outage is not an exotic case: it
// is what a screenshot step, an endurance step and `runToCompletion` all do.
//
// So the crossed BOUNDARIES are walked in order — each surviving outage's loss and then
// its restore — and each is reported, before the endpoint is sampled. The walk is the
// contiguous due-prefix shape `ScenarioEngine.advance` uses over its beats and
// `HeldReplyQueue.releaseThrough` uses over its parked replies: an ascending list, a
// prefix that has fallen due, and the prefix REMOVED rather than compared against a
// remembered cursor. Removal is what makes a boundary at tick zero playable at all — a
// cursor starting at zero would need a sentinel below it to admit one — and the fixture
// bridge binds this player before anything can advance the clock precisely so that a
// scenario scripting an outage at tick zero is observed rather than stepped over.
//
// AND THE ENDPOINT IS STILL SAMPLED, which is not a second walk saying the same thing.
// The boundaries answer what CHANGED inside this advance; the sample answers where the
// advance LEFT the transport, which is the only reading available on an advance that
// crossed nothing — the first advance of a scenario whose outage is still ahead of it
// reports `reachable` from the sample and from nothing else. The two agree by
// construction: the intervals are merged below, so the last boundary crossed always
// states the state the sample then restates, and a restatement of the same state is
// free (`transport-reconnect.ts`: only a CHANGE is a change).
//
// THE INTERVALS ARE MERGED, AND THAT IS WHAT KEEPS THE TWO READINGS ONE CLAIM.
// `isTransportLostAt` answers membership of the UNION of the scripted outages — it is a
// `.some` — so the edges of that union are the transitions, and edges derived per outage
// would disagree with it wherever two outages overlap or meet: the walk would report a
// restore the sample says never happened, and the sample would then correct it, emitting
// a returning edge for a wire that never came back. Merging derives the edges from the
// same union the predicate reads, so no such correction exists to make. An outage whose
// restore is not strictly after its loss is dropped in the same pass, because the
// predicate says the transport was never away for it and a pair of transitions around an
// interval nobody was ever inside is a reconnect nothing lost.

import type { Unsubscribe } from "../../../core/index.js";
import type { ScenarioEngine, ScenarioTransportOutage } from "../../scenario-runtime/index.js";
import type {
  TransportReachability,
  TransportReconnectSignal,
} from "../../transport/transport-reconnect.js";

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
  outages: readonly ScenarioTransportOutage[],
  elapsedMs: number,
): boolean {
  return outages.some((outage) => elapsedMs >= outage.lostAtMs && elapsedMs < outage.restoredAtMs);
}

/** One state the script says the transport enters, and the instant it enters it. */
interface ScheduledTransportTransition {
  readonly atMs: number;
  readonly reachability: Exclude<TransportReachability, "unknown">;
}

/**
 * A scenario's transitions, ascending, each handed out exactly once.
 *
 * A class with a private field rather than a cursor closed over by the sink, per
 * `apps/desktop/AGENTS.md`: what a played boundary is is STATE, one instance belongs to
 * one window's player, and a module-level list would make two fixture windows in one
 * process share a script only one of them was walking.
 *
 * It reads no clock. Every method takes the instant it is judging against, exactly as
 * `HeldReplyQueue` does and for the same reason: the engine holds the only clock in
 * fixture mode, and a second reader of it here would be a second opinion about what
 * time it is.
 */
class ScenarioTransportBoundaries {
  #pending: readonly ScheduledTransportTransition[];

  public constructor(outages: readonly ScenarioTransportOutage[]) {
    this.#pending = transitionsAcross(outages);
  }

  /**
   * Every transition at or before `elapsedMs`, in order, removed as it is handed out.
   *
   * The CONTIGUOUS due prefix, which is what makes handing one out twice
   * unrepresentable rather than merely unlikely: the list is ascending, so stopping at
   * the first entry still ahead leaves exactly the entries that have not been played,
   * and the next pass starts where this one stopped without anything remembering where
   * that was.
   */
  public crossedThrough(elapsedMs: number): readonly ScheduledTransportTransition[] {
    const firstStillAhead = this.#pending.findIndex((transition) => transition.atMs > elapsedMs);
    if (firstStillAhead === 0) {
      return [];
    }
    const crossed =
      firstStillAhead === -1 ? this.#pending : this.#pending.slice(0, firstStillAhead);
    this.#pending = firstStillAhead === -1 ? [] : this.#pending.slice(firstStillAhead);
    return crossed;
  }
}

/**
 * The outages a scenario is actually away for, merged into non-overlapping intervals.
 *
 * Sorted by loss and folded left, so two outages that overlap or meet become one and an
 * interval the transport is never inside is dropped. This is the union
 * `isTransportLostAt` tests membership of, computed once so the boundaries below and
 * that predicate cannot disagree.
 */
function mergedOutages(
  outages: readonly ScenarioTransportOutage[],
): readonly ScenarioTransportOutage[] {
  const merged: ScenarioTransportOutage[] = [];
  const away = outages
    .filter((outage) => outage.restoredAtMs > outage.lostAtMs)
    .toSorted((left, right) => left.lostAtMs - right.lostAtMs);
  for (const outage of away) {
    const open = merged.at(-1);
    if (open === undefined || outage.lostAtMs > open.restoredAtMs) {
      merged.push(outage);
      continue;
    }
    merged[merged.length - 1] = {
      lostAtMs: open.lostAtMs,
      restoredAtMs: Math.max(open.restoredAtMs, outage.restoredAtMs),
    };
  }
  return merged;
}

/** The merged intervals as an ascending, strictly alternating transition list. */
function transitionsAcross(
  outages: readonly ScenarioTransportOutage[],
): readonly ScheduledTransportTransition[] {
  return mergedOutages(outages).flatMap((outage) => [
    { atMs: outage.lostAtMs, reachability: "unreachable" as const },
    { atMs: outage.restoredAtMs, reachability: "reachable" as const },
  ]);
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
  const boundaries = new ScenarioTransportBoundaries(outages);
  return engine.subscribeToAdvances((elapsedMs) => {
    for (const transition of boundaries.crossedThrough(elapsedMs)) {
      signal.observe(transition.reachability);
    }
    signal.observe(isTransportLostAt(outages, elapsedMs) ? "unreachable" : "reachable");
  });
}
