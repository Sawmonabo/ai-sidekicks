// Who is listening to a scenario, and what each of them is handed.
//
// SPLIT OUT OF `scenario-engine.ts` ON THAT FILE'S OWN SEAM. The engine's module prose
// names two jobs in one breath: it owns scenario TIME — the frozen clock, the elapsed
// tick, which beats an advance made due — and it also answers a subscription that
// arrives LATE, publishes an advance that crossed no beat, and appends a frame the
// script does not carry. The first is a computation over the script; the second is a
// fan-out over subscribers plus the record of what has actually landed. They met at
// three statements and were otherwise independent, and one file carrying both was over
// the size the structure rules set.
//
// SO THE DIVIDING LINE IS: THE ENGINE DECIDES WHAT IS DUE, THIS DECIDES WHO GETS IT.
// Nothing here reads a clock, holds an elapsed figure, or knows what a beat's `atMs`
// means; nothing in the engine holds a sink, a position, or the delivered log. The
// engine is this class's only caller, and it calls it at exactly five moments — attach
// a beat sink, attach an advance sink, admit the beats one advance made due, publish
// that advance, and append a frame an act produced.
//
// TWO EMITTERS AND NOT ONE, which is the reason this class exists as a pair rather than
// as one sink list. Beats carry the events that fell due, so a subscriber interested in
// the CLOCK rather than in the log would have to be handed an empty array on every
// advance that carried none — a delivery of nothing wearing a delivery's clothes, and
// it would reach every beat subscriber in the console. What rides the advance emitter
// is the elapsed scenario time after the advance, which is what a scripted schedule of
// non-event facts (a transport outage) is written against, and each such subscriber
// walks its OWN due rule against it — there is no second table of what is due for whom.
//
// AND THE LOG IS HELD HERE RATHER THAN IN THE ENGINE. `session.subscribe` is registered
// replay-then-tail — the whole log, then what follows — so a sink attaching late has to
// be handed the prefix before it is registered, which is a delivery decision made from
// the record of what was delivered. Holding the record beside the sinks is what makes
// that one statement rather than a reach back across the seam on every attach.
//
// LIVENESS IS THE ENGINE'S, DELIBERATELY. This class has no disposed flag: a delivery
// after teardown is dropped and REPORTED on the tripwire, and the report names the
// scenario, which is the engine's vocabulary. Teardown reaches here as `clear()`, and
// every guard that decides whether to call at all stays on the one side that knows the
// engine is gone.

import { Emitter, type EmitterSink, type Unsubscribe } from "../../core/index.js";
import type { ConsoleSessionEvent } from "../../store/index.js";
import { ScenarioSessionLog, type UnpositionedSessionEvent } from "./scenario-log.js";

/**
 * A subscriber to delivered beats.
 *
 * `core/emitter.ts`'s sink type rather than a fourth hand-written one — that module
 * names the engine's flat sink `Set` as one of the three copies it exists to
 * replace, and the alias keeps the scenario's own vocabulary readable at call sites.
 */
export type ScenarioSink = EmitterSink<readonly ConsoleSessionEvent[]>;

/** What one subscriber asks beyond being handed later beats. */
export interface ScenarioSubscribeOptions {
  /**
   * Deliver the already-delivered prefix on attach, then tail.
   *
   * The registered behaviour of the whole-session stream and of nothing else. A
   * narrowed run stream and the relay are live streams: replaying a projection into
   * one would hand a runs surface transitions it is not opening a subscription for.
   */
  readonly replayDeliveredPrefix?: boolean;
}

export class ScenarioDelivery {
  // The subscribe / emit / unsubscribe idiom is `core/emitter.ts`'s. Two of its
  // behaviours matter here specifically: delivery iterates a SNAPSHOT, so a pane
  // that unsubscribes during a beat cannot make a sibling pane miss the beat it was
  // still subscribed for; and a throwing sink does not silence the others, so one
  // broken surface does not stop a scenario delivering to the rest.
  readonly #beats = new Emitter<readonly ConsoleSessionEvent[]>("scenario beat");
  readonly #advances = new Emitter<number>("scenario advance");
  // Where a delivered frame's position comes from, and the record a late subscriber is
  // replayed. One line for scripted beats and appended frames alike.
  readonly #log = new ScenarioSessionLog();

  /**
   * Attach a beat sink, replaying the delivered prefix first when asked. Idempotent
   * unsubscribe.
   *
   * The prefix is delivered synchronously, in log order, in one batch, BEFORE the
   * sink is registered. Ordering it that way is what makes a beat impossible to see
   * twice or miss: nothing can advance the frozen clock between the two statements
   * (the caller is the only thing that moves it), so the sink is attached to a stream
   * standing exactly where the replay left off.
   *
   * Keyed on what the LOG holds and never on a consumed script prefix: an appended
   * frame advances the first and not the second, so a scenario appended to before its
   * first advance would replay nothing and hand a late subscriber a log it reads as
   * starting at a gap.
   *
   * `replayDeliveredPrefix` arrives already ANDed with the engine's liveness, because
   * a replay is a delivery and a disposed engine delivers nothing — the sink still
   * attaches and still receives nothing, which is what it would have done before.
   */
  public subscribeToBeats(sink: ScenarioSink, replayDeliveredPrefix: boolean): Unsubscribe {
    if (replayDeliveredPrefix && this.#log.deliveredCount > 0) {
      sink(this.deliveredEvents());
    }
    return this.#beats.subscribe(sink);
  }

  /** Attach an advance sink. Returns an idempotent unsubscribe. */
  public subscribeToAdvances(sink: EmitterSink<number>): Unsubscribe {
    return this.#advances.subscribe(sink);
  }

  /**
   * Stamp one advance's due beats into the log and deliver them.
   *
   * Stamped on the way out rather than read off the script: an appended frame has
   * already taken a position, and a beat delivered at the number its author wrote
   * would be a duplicate the store drops.
   */
  public admitScriptedBeats(events: readonly ConsoleSessionEvent[]): void {
    this.#beats.emit(this.#log.admitScriptedBeats(events));
  }

  /**
   * Append one frame the script does not carry, at the next free position, and
   * deliver it now.
   *
   * It goes through the log rather than through a sequence of its own, so the position
   * it takes and the positions the beats after it take are one decision — see
   * `scenario-log.ts` for why an appended frame shifts the rest.
   */
  public appendEvent(event: UnpositionedSessionEvent): ConsoleSessionEvent {
    const appended = this.#log.appendEvent(event);
    this.#beats.emit([appended]);
    return appended;
  }

  /** Publish the tick the frozen clock now stands at to every advance sink. */
  public publishAdvance(elapsedMs: number): void {
    this.#advances.emit(elapsedMs);
  }

  /**
   * The frames this playback has already delivered, in log order.
   *
   * The LOG's answer rather than a slice of the script: an appended frame is in no
   * slice, and every scripted beat after one is delivered at a position its author did
   * not write.
   */
  public deliveredEvents(): readonly ConsoleSessionEvent[] {
    return this.#log.delivered();
  }

  /** How many beat sinks are attached. Read by tests and by the diagnostics surface. */
  public get beatSinkCount(): number {
    return this.#beats.sinkCount;
  }

  /** Release every sink on either emitter. The log is kept; nothing reads it after. */
  public clear(): void {
    this.#beats.clear();
    this.#advances.clear();
  }
}
