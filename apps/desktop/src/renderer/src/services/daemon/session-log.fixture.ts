// The session log one scenario has delivered, and the one place a log position is allocated.
// `engine.fixture.ts` owns the clock (which beats are due); this owns positions.
//
// The engine can append a frame the script does not carry, so the delivered log is a record, not a
// slice of `scenario.beats`. Sequences stay monotonic and dense, which
// `store/session/sequence-reconciler.ts` requires (it drops anything at or below its cursor as a
// duplicate and records a skip as a gap). An appended frame takes the position after the last one
// delivered, and each later scripted beat is delivered at its authored sequence plus the number of
// appends before it; with no appends every scenario keeps its authored sequences. The script itself
// is never rewritten, so `scenario.beats` stays the authored record the contract check reads.

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/** An event to append, before the log has told it where it lands. */
export type UnpositionedSessionEvent = Omit<ProjectedSessionEvent, "sequence">;

/** What one scenario playback has delivered, and where the next frame goes. */
export class ScenarioSessionLog {
  readonly #delivered: ProjectedSessionEvent[] = [];
  #appendedCount = 0;

  /**
   * Everything delivered so far, in log order. A fresh array per call, so a later delivery cannot
   * mutate a batch a store already reconciled.
   */
  public delivered(): readonly ProjectedSessionEvent[] {
    return [...this.#delivered];
  }

  /**
   * How many frames have been delivered, appended ones included. The engine's replay predicate
   * reads this rather than its consumed-script count, which is zero for a scenario appended to
   * before its first advance.
   */
  public get deliveredCount(): number {
    return this.#delivered.length;
  }

  /**
   * Records one batch of scripted beats at the positions they are delivered at, and returns it
   * rather than emitting it, so the engine alone decides what reaches a sink.
   */
  public admitScriptedBeats(
    events: readonly ProjectedSessionEvent[],
  ): readonly ProjectedSessionEvent[] {
    return events.map((event) =>
      this.#record({ ...event, sequence: event.sequence + this.#appendedCount }),
    );
  }

  /**
   * Appends one frame the script does not carry, at the position after the last one delivered
   * (one for a fresh log).
   */
  public appendEvent(event: UnpositionedSessionEvent): ProjectedSessionEvent {
    this.#appendedCount += 1;
    return this.#record({ ...event, sequence: this.#lastDeliveredSequence() + 1 });
  }

  /** The highest position handed out, or zero before anything has been delivered. */
  #lastDeliveredSequence(): number {
    return this.#delivered.at(-1)?.sequence ?? 0;
  }

  #record(event: ProjectedSessionEvent): ProjectedSessionEvent {
    this.#delivered.push(event);
    return event;
  }
}
