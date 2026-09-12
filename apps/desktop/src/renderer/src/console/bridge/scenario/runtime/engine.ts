// The engine that plays a scenario, and the one frozen clock it plays it on.
//
// The fixture bridge makes the fixture clock
// the only clock the renderer reads in fixture mode, and this module is where that
// clock lives. The script it plays is `scenario.ts`'s: nothing here declares a
// scenario, and nothing there runs one.
//
// The engine's one sharp edge is teardown. A pane that unmounts mid-scenario leaves
// the engine disposed while a timer callback is still in flight; delivering into a
// torn-down subscriber would either throw inside a React commit or write into a
// store that no longer has a consumer. So `dispose()` is final: every later tick is
// dropped and reported on the tripwire rather than delivered.
//
// WHO IS LISTENING IS `scenario-delivery.ts`, one directory entry away, and the split
// is where the two jobs meet rather than through the middle of either. This file owns
// what is DUE — the frozen clock, the elapsed tick, the contiguous due prefix, and the
// teardown that decides whether anything is delivered at all. That one owns the fan-out
// and the record of what landed: the two emitters, the replay a late subscriber is
// handed, and the log every delivered position comes from.
//
// THE LIVENESS RULE OVER THAT SEAM IS NOT UNIFORM, and stating it as though it were
// would hide the one asymmetry a reader has to know. Every reach that DELIVERS is
// guarded on this side and never on that one: `advance` returns before
// `admitScriptedBeats` and `publishAdvance`, and `appendEvent` returns before its own,
// each dropping onto the tripwire. `subscribe` passes `!#disposed` for the REPLAY
// alone — the sink still attaches, as that method's own doc says — and
// `subscribeToAdvances` passes no flag at all. Neither ATTACH needs one: `dispose()`
// runs `clear()` and closes every producing path in the same act, so a sink registered
// afterwards is attached to an emitter nothing can ever publish to again, which is
// what `bridge/failure-modes.test.ts`'s teardown case and `scenario-engine.test.ts`'s
// late-sink negative control hold between them. The remaining three reaches —
// `deliveredEvents`, `beatSinkCount`, `clear` — are two reads and teardown itself, and
// none of them is a delivery. That is why the disposed flag lives here and not there,
// which `scenario-delivery.ts` states from its own side.
//
// A FRAME CAN BE APPENDED THAT THE SCRIPT DOES NOT CARRY. A scenario is a recording,
// and a person acting on a fixture surface does something the recording does not
// contain: a lifecycle move answers, and against a daemon the event it produced would
// arrive on this session's stream. `appendEvent` is that, and it is the engine's
// because the stream is — a fixture namespace that emitted onto its own feed would be
// a second delivery path into stores this one already owns. It is NOT a clock move: an
// act happens now rather than at a tick, so it delivers to whatever is subscribed and
// is replayed to whatever subscribes later, and no advance is published for it.
//
// The engine holds ONE more thing than the script: the replies a scripted latency
// has parked. A `ScenarioReply` carrying `afterMs` is a request that has not been
// answered yet, and on a frozen clock the only thing that can answer it is the
// caller moving that clock. Holding them on this side rather than in the bridge is
// what keeps the frozen clock the single source of scenario time — a bridge that
// spent the delay itself would be a second clock, and the one property this module
// exists for is that there is only one.
//
// THE QUEUE ITSELF IS `held-reply-queue.ts`, one directory entry away, on the same
// split: this file owns scenario TIME; that one owns SCHEDULING against it, reads no
// clock of its own, and is reached from here at exactly two moments — every advance,
// and teardown.
//
// AND AN ADVANCE IS PUBLISHED EVEN WHEN NO BEAT IS DUE, which is the second thing a
// subscriber may ask for. Beats reach `subscribe`; every other frame a scenario
// schedules against its own tick — the deep link's pending invitations are the first
// — reaches `subscribeToAdvances`. Routing those through the beat emitter is not
// available and would be wrong twice over: the beat emitter carries session events
// and is silent on an advance that crosses no beat, so a frame whose tick fell in a
// quiet stretch of the script would never be delivered. Why they are two emitters
// rather than one widened sink list is `scenario-delivery.ts`'s to state.

import {
  ManualClock,
  SCENARIO_PENDING_REPLY_CAP,
  SCENARIO_TICK_MS,
  parseInstant,
  reportTripwire,
  type ConsoleClock,
  type EmitterSink,
  type Unsubscribe,
} from "../../../core/index.js";
import type { ConsoleSessionEvent } from "../../../store/index.js";
import { HeldReplyQueue, type ScenarioReplyOutcome } from "./held-reply-queue.js";
import { ScenarioDelivery, type ScenarioSink, type ScenarioSubscribeOptions } from "./delivery.js";
import type { UnpositionedSessionEvent } from "./log.js";
import type { ScenarioReply } from "./reply.js";
import type { ConsoleScenario } from "./vocabulary.js";

/** Where a scenario's playback has got to. Rendered by the fixture picker. */
export interface ScenarioProgress {
  readonly scenarioId: string;
  readonly elapsedMs: number;
  readonly deliveredBeatCount: number;
  readonly totalBeatCount: number;
  readonly isComplete: boolean;
}

export interface ScenarioEngineOptions {
  readonly scenario: ConsoleScenario;
  /** Defaults to a `ManualClock`, which is what makes the fixture deterministic. */
  readonly clock?: ConsoleClock & { advance?: (deltaMs: number) => void };
  /** How far each `tick()` moves the frozen clock. */
  readonly tickMs?: number;
}

export class ScenarioEngine {
  readonly #scenario: ConsoleScenario;
  readonly #clock: ConsoleClock & { advance?: (deltaMs: number) => void };
  readonly #tickMs: number;
  // Who is listening, and the record of what has landed. Every delivery this class
  // decides on goes out through it, and it decides no delivery of its own.
  readonly #delivery = new ScenarioDelivery();
  readonly #heldReplies = new HeldReplyQueue(SCENARIO_PENDING_REPLY_CAP);
  // How many computed answers this playback has produced for each call name.
  // `nextComputedReplyOrdinal` below is the whole of the rule.
  readonly #computedRepliesByCall = new Map<string, number>();
  #elapsedMs = 0;
  #deliveredBeatCount = 0;
  #disposed = false;
  #droppedTickCount = 0;

  public constructor(options: ScenarioEngineOptions) {
    this.#scenario = options.scenario;
    // The declared start read through the console's one instant reading rather than
    // `Date.parse`, which answers `NaN` for a manifest whose start is not an instant
    // — and every `dueAt` derived from `NaN` is `NaN`, so no beat is ever due and the
    // fixture silently delivers nothing. The epoch is a visibly wrong start; silence
    // is an invisible one.
    const declaredStart = parseInstant(options.scenario.startedAtIso);
    this.#clock = options.clock ?? new ManualClock(declaredStart.epochMilliseconds ?? 0);
    this.#tickMs = options.tickMs ?? SCENARIO_TICK_MS;
  }

  public get scenario(): ConsoleScenario {
    return this.#scenario;
  }

  /** The frozen clock. Every console subsystem in fixture mode reads this one. */
  public get clock(): ConsoleClock {
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
   * TAIL BY DEFAULT, REPLAY-THEN-TAIL BY REQUEST, because the two are different
   * registered subscriptions rather than a preference. Which one a caller is opening
   * is a fact about the SUBSCRIPTION NAME, and the name vocabulary is
   * `session-event-streams.ts`'s — so the engine takes the answer and holds none of
   * that vocabulary itself.
   *
   * How the prefix is delivered — synchronously, in log order, before the sink is
   * registered — is `scenario-delivery.ts`'s, and so is why that ordering makes a beat
   * impossible to see twice or miss. What is decided HERE is whether it happens at all.
   *
   * A DISPOSED engine replays nothing, on the same rule as `advance`: a delivery into
   * a torn-down subscriber is the failure this module's teardown exists to prevent,
   * and a replay is a delivery. The sink still attaches and still receives nothing,
   * which is what it would have done before.
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
   * The sink is handed the tick the clock now stands at, and walks its own rule for
   * what that made due. It is called on EVERY advance, including one that delivered
   * no beat and one that moved the clock by zero — a caller that advanced by nothing
   * is asking what is due now, and answering it costs one comparison. It is called
   * AFTER that advance's beats have landed, and a disposed engine calls it not at
   * all, both on `advance`'s own rule.
   *
   * THE ONE ADVANCE SUBSCRIPTION, and singular for the shared-code rule's reason: a
   * second method over this same emitter split the fixture's callers
   * between two identical names for a while, on the class whose whole job is to be the
   * single source of scenario time.
   *
   * No replay, deliberately, and the asymmetry with the whole-session stream beside
   * it is the point: a beat is a position in a log a late subscriber has to be caught
   * up on, and an advance is a moment. What a subscriber missed is not a list of
   * ticks — it is whatever ITS own due rule says is due at the tick standing now,
   * which it can read off `progress` at attach and which every frame-serving fixture
   * here already does when it opens a feed.
   */
  public subscribeToAdvances(sink: EmitterSink<number>): Unsubscribe {
    return this.#delivery.subscribeToAdvances(sink);
  }

  /**
   * Append one frame this scenario's script does not carry, and deliver it now.
   *
   * The one entry a fixture namespace reaches to put an act's own consequence on this
   * session's stream. It goes through the log rather than through a sequence of its
   * own, so the position it takes and the positions the beats after it take are one
   * decision — see `scenario-log.ts` for why an appended frame shifts the rest.
   *
   * A DISPOSED engine appends nothing and reports it, on `advance`'s rule: a delivery
   * into a torn-down subscriber is the failure this module's teardown exists to
   * prevent, and an append is a delivery.
   */
  public appendEvent(event: UnpositionedSessionEvent): ConsoleSessionEvent | undefined {
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
   * The frames this playback has already delivered, in log order.
   *
   * The LOG's answer rather than a slice of the script: an appended frame is in no
   * slice, and every scripted beat after one is delivered at a position its author did
   * not write. `#deliveredBeatCount` still counts the consumed script prefix, which is
   * what `progress` and the due rule are about.
   *
   * PUBLIC, because a read whose answer the daemon derives from the log has to be
   * answerable from the log here too. A scripted reply is the state a session OPENS in;
   * a fixture that served it unchanged for the whole playback answered a read at tick
   * zero with a state the script does not reach until later, and answered the re-read a
   * beat triggers with the same row it had already given. Both halves are the same
   * defect, and neither is reachable without the record of what has actually landed.
   */
  public deliveredEvents(): readonly ConsoleSessionEvent[] {
    return this.#delivery.deliveredEvents();
  }

  /** Advance one tick. A no-op after teardown, reported rather than silent. */
  public tick(): void {
    this.advance(this.#tickMs);
  }

  /**
   * Advance the frozen clock and deliver every beat that falls due.
   *
   * After `dispose()` this drops the advance and fires the tripwire: a scenario
   * timer that outlives its pane is a real bug (the pane's store is gone), and a
   * silent no-op would let it live in the codebase forever.
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
    // The CONTIGUOUS due prefix, and contiguity is the whole of it. A filter over
    // the remainder picked up a later entry that happened to be due while leaving
    // an earlier undelivered one in front of it, then advanced the count as though
    // a prefix had been consumed — so the next advance sliced PAST the entry it had
    // skipped and re-emitted the one it had already sent. Stopping at the first
    // entry that is not yet due makes `deliveredBeatCount` and the set actually
    // delivered the same claim, whatever order the script is written in.
    //
    // Scripts are held to nondecreasing `atMs` by `scenario/wire-truth/wire-truth.ts`, so a
    // shipped scenario reaches here already ordered. This is the runtime half of
    // that pair rather than a restatement of it: the check reports an author error
    // before the scenario ships, and this makes the error cost a late beat instead
    // of a duplicated and a dropped one.
    const remainingBeats = this.#scenario.beats.slice(this.#deliveredBeatCount);
    const firstNotYetDueIndex = remainingBeats.findIndex((beat) => beat.atMs > target);
    const due =
      firstNotYetDueIndex === -1 ? remainingBeats : remainingBeats.slice(0, firstNotYetDueIndex);
    this.#elapsedMs = target;
    if (this.#clock.advance !== undefined) {
      this.#clock.advance(deltaMs);
    }
    // Held replies are released BEFORE the beats they share this advance with.
    // Settling a promise only queues a continuation, so the beats still reach
    // their sinks first; what the order buys is that a caller cannot observe a
    // beat delivered by an advance whose own reply it is still waiting on.
    this.#heldReplies.releaseThrough(this.#elapsedMs);
    if (due.length > 0) {
      this.#deliveredBeatCount += due.length;
      this.#delivery.admitScriptedBeats(due.map((beat) => beat.event));
    }
    // LAST, and unconditional. Last, because a subscriber walking its own due rule
    // against this tick should see a scenario whose beats for the same tick have
    // already landed — the session log first, then what the other namespaces made
    // due. Unconditional, because an advance that crossed no beat still moved the
    // clock, and the early return this replaced is exactly what would have made a
    // scripted outage between two beats unobservable: a frame whose tick sits in a
    // quiet stretch of the script is due exactly then.
    this.#delivery.publishAdvance(this.#elapsedMs);
  }

  /**
   * Hold one scripted reply until the frozen clock has moved `afterMs` further.
   *
   * This is what makes a scripted latency a LATENCY. The engine used to be
   * advanced by the call itself, which spent the delay on the calling turn: the
   * promise was never pending for the scripted duration, so the loading state the
   * latency exists to make reachable could not be observed, and every beat inside
   * the delay was delivered as a side effect of a request. Here the request parks
   * and the clock stays exactly where the caller left it.
   *
   * Never rejects. The outcome carries the refusal, because the vocabulary a
   * surface renders belongs to the bridge and not to the engine — and that holds
   * for a scripted REFUSAL too: the release says only that the reply came due,
   * and `fixture/call-plane/bridge.ts` is what turns a due `ScenarioRejectingReply` into a
   * rejection. An engine that rejected here would have to know the wire's error
   * shape, which is the bridge boundary's vocabulary and not the playback
   * engine's.
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
   * What lets a computed reply mint a DISTINCT identity each time it answers, and the
   * settled instant it is handed beside this cannot stand in: two calls parked on the
   * frozen clock together are released by one advance and read the same tick, so a
   * receipt keyed on the instant collides exactly where a second mint has to differ.
   *
   * Engine state rather than a counter in the reply table, on `scenario.ts`'s rule that
   * a reply is a computation over what it is handed — the same calls in the same order
   * are handed the same ordinals, so a playback stays replayable tick-for-tick.
   */
  public nextComputedReplyOrdinal(call: string): number {
    const ordinal = (this.#computedRepliesByCall.get(call) ?? 0) + 1;
    this.#computedRepliesByCall.set(call, ordinal);
    return ordinal;
  }

  /** How many sinks are attached. Read by tests and by the diagnostics surface. */
  public get sinkCount(): number {
    return this.#delivery.beatSinkCount;
  }

  /**
   * Final. Later ticks are dropped and counted; sinks and held replies released.
   *
   * The held replies are ABANDONED rather than left alone, and that is the half
   * that is easy to miss: a sink dropped on teardown simply stops being called,
   * but a reply dropped on teardown is a promise nobody can ever settle, and the
   * surface awaiting it renders its loading state for the life of the window.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#delivery.clear();
    this.#heldReplies.abandonAll();
  }
}
