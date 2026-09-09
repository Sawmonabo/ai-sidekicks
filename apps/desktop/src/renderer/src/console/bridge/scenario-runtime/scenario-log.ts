// The session log one scenario has actually delivered, and the one place a position in
// it is allocated.
//
// SPLIT FROM `scenario-engine.ts` when the log stopped being derivable from the script.
// That file owns the CLOCK — which beats are due, when a held reply is released, what a
// teardown drops — and this owns POSITIONS: what has been delivered, in what order, and
// what sequence the next frame takes. Two jobs, and the second one only became a job at
// all when the engine gained a way to append a frame the script does not carry.
//
// WHY THE SCRIPT CAN NO LONGER ANSWER IT. The engine used to serve its replay prefix by
// slicing `scenario.beats` at the consumed count, which is exact for as long as every
// delivered frame is a scripted one and its delivered sequence is the sequence its
// author wrote. An APPENDED frame breaks both halves: it is in no slice of the script,
// and it takes a position the beats after it can no longer also take. So the delivered
// log becomes a record rather than a derivation — not a second copy of the beats, but
// the only statement of what was delivered and at which position.
//
// ONE SEQUENCE LINE, AND APPENDING SHIFTS THE REST. A session's sequence is monotonic
// and dense: `store/session/sequence-reconciler.ts` refuses anything at or below its cursor as a
// duplicate and records everything skipped as a gap, so a fixture that numbered appended
// frames above the whole script would make every later scripted beat a duplicate the
// store drops, and one that reused a scripted number would collide outright. What a
// daemon does instead is append at the head of the log and carry on, which is exactly
// what this does: an appended frame takes the position after the last one delivered, and
// every scripted beat after it is delivered at its authored sequence plus the number of
// appends that preceded it. With no appends the shift is zero and every scenario is
// delivered at the sequences it was written with, byte for byte.
//
// THE SCRIPT IS NEVER REWRITTEN. Stamping happens on the way out, so `scenario.beats`
// stays the authored record that `scenarios/wire-truth.ts` checks and that a reader
// reasons about — the shift is a property of one playback, not of the scenario.

import type { ConsoleSessionEvent } from "../../store/index.js";

/** An event to append, before the log has told it where it lands. */
export type UnpositionedSessionEvent = Omit<ConsoleSessionEvent, "sequence">;

/** What one scenario playback has delivered, and where the next frame goes. */
export class ScenarioSessionLog {
  readonly #delivered: ConsoleSessionEvent[] = [];
  #appendedCount = 0;

  /**
   * Everything delivered so far, in log order.
   *
   * A fresh array per call: the replay hands it to a sink that may hold it, and
   * lending out the log's own array would let the next delivery mutate a batch a
   * store has already reconciled.
   */
  public delivered(): readonly ConsoleSessionEvent[] {
    return [...this.#delivered];
  }

  /**
   * How many frames have been delivered, appended ones included.
   *
   * The engine's replay predicate reads THIS rather than its own consumed-script
   * count, and the difference is the whole reason the accessor exists: the two agree
   * only while every delivered frame is a scripted beat, so a scenario appended to
   * before its first advance has a non-empty log and a consumed prefix of zero — and a
   * subscriber attaching there was handed nothing to catch up on.
   */
  public get deliveredCount(): number {
    return this.#delivered.length;
  }

  /**
   * Record one batch of scripted beats, stamped with the positions they are delivered
   * at.
   *
   * The batch is returned rather than emitted: what reaches a sink is the engine's
   * decision, and a log that emitted would be a second delivery path.
   */
  public admitScriptedBeats(
    events: readonly ConsoleSessionEvent[],
  ): readonly ConsoleSessionEvent[] {
    return events.map((event) =>
      this.#record({ ...event, sequence: event.sequence + this.#appendedCount }),
    );
  }

  /**
   * Append one frame the script does not carry, at the next free position.
   *
   * The next free position is the one after the last frame delivered, so the line
   * stays dense whether or not any beat has been delivered yet — a scenario appended
   * to before its first advance starts at one, which is where its own first beat
   * would have started.
   */
  public appendEvent(event: UnpositionedSessionEvent): ConsoleSessionEvent {
    this.#appendedCount += 1;
    return this.#record({ ...event, sequence: this.#lastDeliveredSequence() + 1 });
  }

  /** The highest position handed out, or zero before anything has been delivered. */
  #lastDeliveredSequence(): number {
    return this.#delivered.at(-1)?.sequence ?? 0;
  }

  #record(event: ConsoleSessionEvent): ConsoleSessionEvent {
    this.#delivered.push(event);
    return event;
  }
}
