// The engine that plays a scenario, and the one frozen clock it plays it on: the only clock the
// renderer reads in fixture mode. `dispose()` is final; a later tick is dropped and reported on
// the tripwire, never delivered into a torn-down subscriber.
//
// The engine decides what is due; `event-delivery.fixture.ts` decides who gets it (fan-out, replay
// and the delivered log) and `held-reply-queue.fixture.ts` schedules parked replies against
// engine time. Each reach that delivers (`advance`, `appendEvent`) is guarded here by the disposed
// flag. Attaching a sink needs no guard, since `dispose()` clears the emitters and closes every
// producing path. `appendEvent` puts a frame the script does not carry on the stream now and is
// not a clock move. An advance is published even when no beat is due, so a frame scheduled in a
// quiet stretch of the script (a transport outage) reaches `subscribeToAdvances`.

import { ManualClock, type Clock } from "@renderer/lib/clock.js";
import { parseInstant } from "@renderer/lib/instant.js";
import { reportTripwire } from "@renderer/lib/tripwires.js";
import { type EmitterSink, type Unsubscribe } from "@renderer/lib/emitter.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { HeldReplyQueue, type ScenarioReplyOutcome } from "./held-reply-queue.fixture.js";
import {
  ScenarioDelivery,
  type ScenarioSink,
  type ScenarioSubscribeOptions,
} from "./event-delivery.fixture.js";
import type { UnpositionedSessionEvent } from "./session-log.fixture.js";
import type { ScenarioReply } from "./scenario-reply.fixture.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";

/**
 * The fixture scenario clock's tick, in milliseconds of scenario time. Every scenario's
 * script is expressed in whole ticks, so a pinned frame is one exact tick and a capture
 * target is byte-stable.
 */
export const SCENARIO_TICK_MS = 50;

/**
 * Scripted replies the engine holds waiting for the frozen clock. A held reply is one
 * in-flight request from one view, so a handful is the whole working set; the clock moves
 * only when a caller moves it, so past the cap the engine refuses the call rather than
 * parking it for a driver that will never release any of it.
 */
export const SCENARIO_PENDING_REPLY_CAP = 64;

/** Where a scenario's playback has got to. Rendered by the fixture picker. */
export interface ScenarioProgress {
  readonly scenarioId: string;
  readonly elapsedMs: number;
  readonly deliveredBeatCount: number;
  readonly totalBeatCount: number;
  readonly isComplete: boolean;
}

/** How a `ScenarioEngine` is built: the scenario to play, and optionally its clock and tick. */
export interface ScenarioEngineOptions {
  readonly scenario: Scenario;
  /** Defaults to a `ManualClock`, which is what makes the fixture deterministic. */
  readonly clock?: Clock & { advance?: (deltaMs: number) => void };
  /** How far each `tick()` moves the frozen clock. */
  readonly tickMs?: number;
}

/** Plays one scenario on a frozen clock, delivering each beat to subscribers as it falls due. */
export class ScenarioEngine {
  readonly #scenario: Scenario;
  readonly #clock: Clock & { advance?: (deltaMs: number) => void };
  readonly #tickMs: number;
  // Who is listening, and the record of what has landed.
  readonly #delivery = new ScenarioDelivery();
  readonly #heldReplies = new HeldReplyQueue(SCENARIO_PENDING_REPLY_CAP);
  // How many computed answers this playback has produced for each call name.
  readonly #computedRepliesByCall = new Map<string, number>();
  #elapsedMs = 0;
  #deliveredBeatCount = 0;
  #disposed = false;
  #droppedTickCount = 0;

  public constructor(options: ScenarioEngineOptions) {
    this.#scenario = options.scenario;
    // Not `Date.parse`: it answers `NaN` for a start that is not an instant, so no beat would
    // ever be due. The epoch is a visibly wrong start; silence is an invisible one.
    const declaredStart = parseInstant(options.scenario.startedAtIso);
    this.#clock = options.clock ?? new ManualClock(declaredStart.epochMilliseconds ?? 0);
    this.#tickMs = options.tickMs ?? SCENARIO_TICK_MS;
  }

  public get scenario(): Scenario {
    return this.#scenario;
  }

  /** The frozen clock. Every console subsystem in fixture mode reads this one. */
  public get clock(): Clock {
    return this.#clock;
  }

  public get progress(): ScenarioProgress {
    return {
      scenarioId: this.#scenario.id,
      elapsedMs: this.#elapsedMs,
      deliveredBeatCount: this.#deliveredBeatCount,
      totalBeatCount: this.#scenario.beats.length,
      isComplete: this.#deliveredBeatCount >= this.#scenario.beats.length,
    };
  }

  /** Ticks refused because the engine was already torn down. Asserted by tests. */
  public get droppedTickCount(): number {
    return this.#droppedTickCount;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Subscribe to delivered beats. Returns an idempotent unsubscribe.
   *
   * Tail by default, replay-then-tail on request, because the two are different registered
   * subscriptions (named in `session-event-streams.ts`). A disposed engine replays nothing, as a
   * replay is a delivery; the sink still attaches.
   */
  public subscribe(sink: ScenarioSink, options?: ScenarioSubscribeOptions): Unsubscribe {
    return this.#delivery.subscribeToBeats(
      sink,
      options?.replayDeliveredPrefix === true && !this.#disposed,
    );
  }

  /**
   * Subscribe to every advance of the frozen clock. Returns an idempotent unsubscribe.
   *
   * The sink is handed the tick the clock now stands at and applies its own due rule. It runs
   * on every advance, including one that delivered no beat or moved the clock by zero, after that
   * advance's beats have landed; a disposed engine never calls it. There is no replay: an advance
   * is a moment, and a late subscriber reads the standing tick off `progress` at attach.
   */
  public subscribeToAdvances(sink: EmitterSink<number>): Unsubscribe {
    return this.#delivery.subscribeToAdvances(sink);
  }

  /**
   * Append one frame this scenario's script does not carry, and deliver it now.
   *
   * The one entry a fixture namespace uses to put an act's consequence on the session's stream.
   * It takes its position from the log (see `session-log.fixture.ts`), so an appended frame
   * shifts the beats after it. A disposed engine appends nothing and reports it.
   */
  public appendEvent(event: UnpositionedSessionEvent): ProjectedSessionEvent | undefined {
    if (this.#disposed) {
      reportTripwire(
        "apply-chokepoint-bypass",
        `ScenarioEngine(${this.#scenario.id})`,
        `a "${event.kind}" frame was appended after teardown; the engine dropped it rather than delivering into a disposed store`,
      );
      return undefined;
    }
    return this.#delivery.appendEvent(event);
  }

  /**
   * The frames this playback has already delivered, in log order. The log's answer, not a slice
   * of the script: an appended frame is in no slice and later beats sit at positions their
   * author did not write. Public so a read the daemon derives from the log can be answered from
   * it here too, instead of serving the opening state for the whole playback.
   */
  public deliveredEvents(): readonly ProjectedSessionEvent[] {
    return this.#delivery.deliveredEvents();
  }

  /** Advance one tick. A no-op after teardown, reported rather than silent. */
  public tick(): void {
    this.advance(this.#tickMs);
  }

  /**
   * Advance the frozen clock and deliver every beat that falls due. After `dispose()` it drops
   * the advance and fires the tripwire, since a timer that outlives its pane is a real bug.
   */
  public advance(deltaMs: number): void {
    if (this.#disposed) {
      this.#droppedTickCount += 1;
      reportTripwire(
        "apply-chokepoint-bypass",
        `ScenarioEngine(${this.#scenario.id})`,
        `a scenario tick of ${String(deltaMs)}ms arrived after teardown; the engine dropped it rather than delivering into a disposed store`,
      );
      return;
    }
    const target = this.#elapsedMs + deltaMs;
    // The contiguous due prefix: stopping at the first beat not yet due keeps
    // `deliveredBeatCount` and the set actually delivered the same claim whatever order the
    // script is written in. A filter would skip an earlier beat and re-emit a later one.
    // `tests/helpers/scenario-contract-check/beat-order.ts` holds shipped scripts to
    // nondecreasing `atMs`; this makes a disordered script cost a late beat, not a duplicate.
    const remainingBeats = this.#scenario.beats.slice(this.#deliveredBeatCount);
    const firstNotYetDueIndex = remainingBeats.findIndex((beat) => beat.atMs > target);
    const due =
      firstNotYetDueIndex === -1 ? remainingBeats : remainingBeats.slice(0, firstNotYetDueIndex);
    this.#elapsedMs = target;
    if (this.#clock.advance !== undefined) {
      this.#clock.advance(deltaMs);
    }
    // Held replies are released before this advance's beats, so a caller cannot observe a beat
    // delivered by an advance whose own reply it is still waiting on.
    this.#heldReplies.releaseThrough(this.#elapsedMs);
    if (due.length > 0) {
      this.#deliveredBeatCount += due.length;
      this.#delivery.admitScriptedBeats(due.map((beat) => beat.event));
    }
    // Last, so a subscriber sees the beats for this tick already landed; unconditional, because
    // an advance crossing no beat still moved the clock and a scripted outage between two beats
    // is due exactly then.
    this.#delivery.publishAdvance(this.#elapsedMs);
  }

  /**
   * Hold one scripted reply until the frozen clock has moved `afterMs` further. The request
   * parks and the clock stays put, so the loading state is observable and no beat is delivered
   * as a side effect of a request.
   *
   * Never rejects: the outcome says only that the reply came due, was abandoned or found the
   * backlog full, and `scripted-reply.fixture.ts` turns a due rejecting reply into a rejection,
   * since the wire's error shape is the bridge's vocabulary and not the engine's.
   */
  public holdReply(afterMs: number): Promise<ScenarioReplyOutcome> {
    if (this.#disposed) {
      return Promise.resolve("abandoned");
    }
    const dueAtMs = this.#elapsedMs + afterMs;
    return new Promise<ScenarioReplyOutcome>((resolve) => {
      if (!this.#heldReplies.hold(dueAtMs, resolve)) {
        resolve("backlog-full");
      }
    });
  }

  /** Replies parked on the clock right now. Asserted by tests, read by diagnostics. */
  public get pendingReplyCount(): number {
    return this.#heldReplies.heldCount;
  }

  /** Advance until every beat has been delivered. The screenshot tier's entry point. */
  public runToCompletion(): void {
    const lastBeat = this.#scenario.beats.at(-1);
    if (lastBeat === undefined) {
      return;
    }
    this.advance(Math.max(0, lastBeat.atMs - this.#elapsedMs));
  }

  /** The canned reply for one call, or `undefined` if the scenario scripts none. */
  public replyFor(call: string): ScenarioReply | undefined {
    return this.#scenario.replies.find((reply) => reply.call === call);
  }

  /**
   * The ordinal of the computed answer about to be produced for `call`, from one.
   *
   * Lets a computed reply mint a distinct identity each time: two calls parked together are
   * released by one advance and read the same instant, so an instant cannot tell them apart.
   * Engine state, so the same calls in the same order get the same ordinals and a playback
   * stays replayable.
   */
  public nextComputedReplyOrdinal(call: string): number {
    const ordinal = (this.#computedRepliesByCall.get(call) ?? 0) + 1;
    this.#computedRepliesByCall.set(call, ordinal);
    return ordinal;
  }

  /** How many sinks are attached. Read by tests. */
  public get sinkCount(): number {
    return this.#delivery.beatSinkCount;
  }

  /**
   * Final. Later ticks are dropped and counted; sinks are released and held replies abandoned,
   * since an unsettled promise would leave its view loading for the life of the window.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#delivery.clear();
    this.#heldReplies.abandonAll();
  }
}
