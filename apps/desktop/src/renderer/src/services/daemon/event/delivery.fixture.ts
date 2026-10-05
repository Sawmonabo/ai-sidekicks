// Who is listening to a scenario, and what each of them is handed. The engine decides what is due;
// this decides who gets it, and it holds no clock and no elapsed figure. The delivered log is held
// here because `session.subscribe` is catch up, then follow: a late sink is handed the prefix from
// the record of what was delivered. Liveness stays with the engine: it guards every call, and
// teardown reaches here as `clear()`.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter, type EmitterSink } from "#renderer/lib/emitter.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/entities.js";
import { ScenarioSessionLog } from "../session/log.fixture.js";

/** A subscriber to delivered beats; the emitter's sink type under the scenario's own name. */
export type ScenarioSink = EmitterSink<readonly ProjectedSessionEvent[]>;

/** What one subscriber asks beyond being handed later beats. */
export interface ScenarioSubscribeOptions {
  /**
   * Catch up on the already-delivered prefix on attach, then follow. Only the whole-session
   * stream does this; a narrowed run stream and the relay are live, and catching one up would
   * hand a subscriber transitions it did not open a subscription for.
   */
  readonly catchUp?: boolean;
}

/** The fan-out of a scenario's beats, and the log of what has been delivered. */
export class ScenarioDelivery {
  // The emitter delivers to a snapshot of sinks, so a pane that unsubscribes mid-beat cannot make
  // a sibling miss it, and a throwing sink does not silence the others.
  readonly #beats = new Emitter<readonly ProjectedSessionEvent[]>("scenario beat");
  // The record a late subscriber catches up from.
  readonly #log = new ScenarioSessionLog();

  /**
   * Attach a beat sink, catching it up on the delivered events first when asked. Idempotent
   * unsubscribe.
   *
   * The prefix is delivered synchronously, in log order, before the sink is registered; nothing
   * can advance the clock in between, so no beat is seen twice or missed.
   * `catchUp` arrives already ANDed with the engine's liveness.
   */
  public subscribeToBeats(sink: ScenarioSink, catchUp: boolean): Unsubscribe {
    if (catchUp && this.#log.deliveredCount > 0) {
      sink(this.deliveredEvents());
    }
    return this.#beats.subscribe(sink);
  }

  /** Record one advance's due beats in the log and deliver them. */
  public admitScriptedBeats(events: readonly ProjectedSessionEvent[]): void {
    this.#beats.emit(this.#log.admitScriptedBeats(events));
  }

  /** The frames this playback has already delivered, in log order. */
  public deliveredEvents(): readonly ProjectedSessionEvent[] {
    return this.#log.delivered();
  }

  /** Release every sink. The log is kept; nothing reads it after. */
  public clear(): void {
    this.#beats.clear();
  }
}
