// The session log one scenario has delivered: the record a late `session.subscribe` sink catches up
// from. Beats are delivered at their authored sequences, which stay monotonic and dense as
// `store/session/sequence-reconciler.ts` requires (it drops anything at or below its cursor as a
// duplicate and records a skip as a gap). The script itself is never rewritten, so `scenario.beats`
// stays the authored record the contract check reads.

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** What one scenario playback has delivered. */
export class ScenarioSessionLog {
  readonly #delivered: ProjectedSessionEvent[] = [];

  /**
   * Everything delivered so far, in log order. A fresh array per call, so a later delivery cannot
   * mutate a batch a store already reconciled.
   */
  public delivered(): readonly ProjectedSessionEvent[] {
    return [...this.#delivered];
  }

  /** How many frames have been delivered. The engine's catch-up predicate reads this. */
  public get deliveredCount(): number {
    return this.#delivered.length;
  }

  /**
   * Records one batch of scripted beats and returns the recorded copies, so the engine decides
   * what reaches a sink and no sink holds the script's own objects.
   */
  public admitScriptedBeats(
    events: readonly ProjectedSessionEvent[],
  ): readonly ProjectedSessionEvent[] {
    const recorded = events.map((event) => ({ ...event }));
    this.#delivered.push(...recorded);
    return recorded;
  }
}
