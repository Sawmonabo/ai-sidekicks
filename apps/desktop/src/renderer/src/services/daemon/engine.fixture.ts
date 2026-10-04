// The engine that plays a scenario, and the one frozen clock it plays it on: the only clock the
// renderer reads in fixture mode. `dispose()` is final; a later advance is dropped and reported on
// the tripwire, never delivered into a torn-down subscriber.
//
// The engine decides what is due; `event-delivery.fixture.ts` decides who gets it (fan-out, replay
// and the delivered log) and `held-reply-queue.fixture.ts` schedules parked replies, and the
// machine notices a settled reply pushes, against engine time. `advance`, the one reach that
// delivers, is guarded here by the disposed flag. Attaching a sink needs no guard, since
// `dispose()` clears the emitters.

import { ManualClock, type Clock } from "@renderer/lib/clock.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { parseInstant } from "@renderer/lib/instant.js";
import { reportTripwire } from "@renderer/lib/tripwires.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { HeldReplyQueue, type ScenarioReplyOutcome } from "./held-reply-queue.fixture.js";
import {
  ScenarioDelivery,
  type ScenarioSink,
  type ScenarioSubscribeOptions,
} from "./event-delivery.fixture.js";
import type { ScenarioReply } from "./scenario-reply.fixture.js";
import type { Scenario } from "@fixtures/scenario.js";

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

/** A machine notice as its stream's subscribers are handed it. */
export interface DeliveredNotice {
  /** The stream name it is pushed on. */
  readonly stream: string;
  readonly payload: unknown;
}

/** How a `ScenarioEngine` is built: the scenario to play, and optionally its clock. */
export interface ScenarioEngineOptions {
  readonly scenario: Scenario;
  /** Defaults to a `ManualClock`, which is what makes the fixture deterministic. */
  readonly clock?: Clock & { advance?: (deltaMs: number) => void };
}

/** Plays one scenario on a frozen clock, delivering each beat to subscribers as it falls due. */
export class ScenarioEngine {
  readonly #scenario: Scenario;
  readonly #clock: Clock & { advance?: (deltaMs: number) => void };
  // Who is listening, and the record of what has landed.
  readonly #delivery = new ScenarioDelivery();
  readonly #heldReplies = new HeldReplyQueue(SCENARIO_PENDING_REPLY_CAP);
  // Notices parked on the clock, apart from replies so `pendingReplyCount` counts requests only.
  readonly #heldNotices = new HeldReplyQueue(SCENARIO_PENDING_REPLY_CAP);
  readonly #notices = new Emitter<DeliveredNotice>("scenario notice");
  // How many computed answers this playback has produced for each call name.
  readonly #computedRepliesByCall = new Map<string, number>();
  // The requests each write has been answered for, in settle order.
  readonly #answeredRequestsByCall = new Map<string, unknown[]>();
  #elapsedMs = 0;
  #deliveredBeatCount = 0;
  #disposed = false;

  public constructor(options: ScenarioEngineOptions) {
    this.#scenario = options.scenario;
    // Not `Date.parse`: it answers `NaN` for a start that is not an instant, so no beat would
    // ever be due. The epoch is a visibly wrong start; silence is an invisible one.
    const declaredStart = parseInstant(options.scenario.startedAtIso);
    this.#clock = options.clock ?? new ManualClock(declaredStart.epochMilliseconds ?? 0);
  }

  public get scenario(): Scenario {
    return this.#scenario;
  }

  /** The frozen clock. Every app subsystem in fixture mode reads this one. */
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

  /** Whether `dispose` has run; the bridge provider reads it as the composition's disposal. */
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
      options?.resendDeliveredEvents === true && !this.#disposed,
    );
  }

  /**
   * The frames this playback has already delivered, in log order. Public so a read the daemon
   * derives from the log can be answered from it here too, instead of serving the opening state
   * for the whole playback.
   */
  public deliveredEvents(): readonly ProjectedSessionEvent[] {
    return this.#delivery.deliveredEvents();
  }

  /**
   * Advance the frozen clock and deliver every beat that falls due. After `dispose()` it drops
   * the advance and fires the tripwire, since a timer that outlives its pane is a real bug.
   */
  public advance(deltaMs: number): void {
    if (this.#disposed) {
      reportTripwire(
        "tick-after-teardown",
        `ScenarioEngine(${this.#scenario.id})`,
        `a scenario tick of ${String(deltaMs)}ms arrived after teardown; ` +
          `the engine dropped it rather than delivering into a disposed store`,
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
    // delivered by an advance whose own reply it is still waiting on. Notices follow replies,
    // since each is pushed by a reply that has already settled.
    this.#heldReplies.releaseThrough(this.#elapsedMs);
    this.#heldNotices.releaseThrough(this.#elapsedMs);
    if (due.length > 0) {
      this.#deliveredBeatCount += due.length;
      this.#delivery.admitScriptedBeats(due.map((beat) => beat.event));
    }
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

  /**
   * Record that the write `call` was answered for `request`. Read back by a computed reply through
   * {@link answeredRequests}, so a read can reflect a write the playback has already answered.
   */
  public recordAnsweredRequest(call: string, request: unknown): void {
    const answered = this.#answeredRequestsByCall.get(call);
    if (answered === undefined) {
      this.#answeredRequestsByCall.set(call, [request]);
      return;
    }
    answered.push(request);
  }

  /** The requests the write `call` has been answered for in this playback, oldest first. */
  public answeredRequests(call: string): readonly unknown[] {
    return this.#answeredRequestsByCall.get(call) ?? [];
  }

  /**
   * Push one machine notice once the frozen clock has moved `afterMs` further, or at once for no
   * delay. `composeAtDelivery` is asked for the notice when it comes due and answers `undefined`
   * for none. `false` when the backlog of parked notices is already at its cap. A disposed engine
   * pushes nothing.
   */
  public scheduleNotice(
    afterMs: number,
    composeAtDelivery: () => DeliveredNotice | undefined,
  ): boolean {
    if (this.#disposed) {
      return true;
    }
    const deliver = (): void => {
      const notice = composeAtDelivery();
      if (notice !== undefined) {
        this.#notices.emit(notice);
      }
    };
    if (afterMs <= 0) {
      deliver();
      return true;
    }
    return this.#heldNotices.hold(this.#elapsedMs + afterMs, (outcome) => {
      if (outcome === "due") {
        deliver();
      }
    });
  }

  /**
   * Subscribe to the notices pushed on one stream, by the name a subscriber opened it under.
   * Returns an idempotent unsubscribe.
   */
  public subscribeToNotices(stream: string, deliver: (payload: unknown) => void): Unsubscribe {
    return this.#notices.subscribe((notice) => {
      if (notice.stream === stream) {
        deliver(notice.payload);
      }
    });
  }

  /**
   * Final. Later advances are dropped and reported; sinks are released and held replies abandoned,
   * since an unsettled promise would leave its view loading for the life of the window. A parked
   * notice is dropped, as nothing is left to hear it.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#delivery.clear();
    this.#notices.clear();
    this.#heldReplies.abandonAll();
    this.#heldNotices.abandonAll();
  }
}
