// The engine that plays a scenario, and the one frozen clock it plays it on.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge makes the fixture clock
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
// The engine holds ONE more thing than the script: the replies a scripted latency
// has parked. A `ScenarioReply` carrying `afterMs` is a request that has not been
// answered yet, and on a frozen clock the only thing that can answer it is the
// caller moving that clock. Holding them here rather than in the bridge is what
// keeps the frozen clock the single source of scenario time — a bridge that spent
// the delay itself would be a second clock, and the one property this module exists
// for is that there is only one.

import {
  Emitter,
  ManualClock,
  SCENARIO_PENDING_REPLY_CAP,
  SCENARIO_TICK_MS,
  reportTripwire,
  type ConsoleClock,
  type EmitterSink,
  type Unsubscribe,
} from "../core/index.js";
import type { ConsoleSessionEvent } from "../store/index.js";
import type { ConsoleScenario, ScenarioReply } from "./scenario.js";

/** Where a scenario's playback has got to. Rendered by the fixture picker. */
export interface ScenarioProgress {
  readonly scenarioId: string;
  readonly elapsedMs: number;
  readonly deliveredBeatCount: number;
  readonly totalBeatCount: number;
  readonly isComplete: boolean;
}

/**
 * A subscriber to delivered beats.
 *
 * `core/emitter.ts`'s sink type rather than a fourth hand-written one — that module
 * names the engine's flat sink `Set` as one of the three copies it exists to
 * replace, and the alias keeps the engine's own vocabulary readable at call sites.
 */
export type ScenarioSink = EmitterSink<readonly ConsoleSessionEvent[]>;

/**
 * How a held reply ended.
 *
 * Three outcomes rather than a promise that resolves or hangs, because two of
 * them are refusals the caller has to render: an engine torn down under a request
 * and a backlog that is already full both leave the caller with nothing to show,
 * and a promise that never settles leaves a surface loading for the life of the
 * window. The engine reports which; naming the refusal belongs to the bridge.
 */
export type ScenarioReplyOutcome = "due" | "abandoned" | "backlog-full";

/** One reply parked until the frozen clock reaches its tick. */
interface HeldScenarioReply {
  readonly dueAtMs: number;
  readonly settle: (outcome: ScenarioReplyOutcome) => void;
}

/**
 * The replies a scenario is holding, and the bound on how many.
 *
 * Its own class rather than an array field on the engine because it owns a rule
 * the engine does not otherwise have: entries leave in DUE order, not in call
 * order, so two calls made together with different scripted latencies settle in
 * the order a real transport would settle them. Keeping that in one place is what
 * stops `advance` from growing a second sort.
 */
class HeldReplyQueue {
  readonly #held: HeldScenarioReply[] = [];
  readonly #cap: number;

  public constructor(cap: number) {
    this.#cap = cap;
  }

  public get heldCount(): number {
    return this.#held.length;
  }

  /** Park one reply. `false` when the queue is already at its cap. */
  public hold(dueAtMs: number, settle: (outcome: ScenarioReplyOutcome) => void): boolean {
    if (this.#held.length >= this.#cap) {
      return false;
    }
    this.#held.push({ dueAtMs, settle });
    return true;
  }

  /**
   * Settle every reply due at or before `elapsedMs`, earliest first.
   *
   * The entries are removed BEFORE any of them is settled, so a continuation that
   * issues another delayed call cannot be released by the same pass that released
   * the call it came from. `sort` is stable, so replies sharing a due tick settle
   * in the order they were made.
   */
  public releaseThrough(elapsedMs: number): void {
    if (this.#held.length === 0) {
      // The common case by far — every advance of a scenario that scripts no
      // latency reaches here — and it allocates nothing.
      return;
    }
    const due: HeldScenarioReply[] = [];
    const stillHeld: HeldScenarioReply[] = [];
    for (const reply of this.#held) {
      (reply.dueAtMs <= elapsedMs ? due : stillHeld).push(reply);
    }
    if (due.length === 0) {
      return;
    }
    this.#held.length = 0;
    this.#held.push(...stillHeld);
    due.sort((left, right) => left.dueAtMs - right.dueAtMs);
    for (const reply of due) {
      reply.settle("due");
    }
  }

  /** Settle every held reply as abandoned. For teardown, and final. */
  public abandonAll(): void {
    const abandoned = this.#held.splice(0, this.#held.length);
    for (const reply of abandoned) {
      reply.settle("abandoned");
    }
  }
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
  // The subscribe / emit / unsubscribe idiom is `core/emitter.ts`'s. Two of its
  // behaviours matter here specifically: delivery iterates a SNAPSHOT, so a pane
  // that unsubscribes during a beat cannot make a sibling pane miss the beat it was
  // still subscribed for; and a throwing sink does not silence the others, so one
  // broken surface does not stop a scenario delivering to the rest.
  readonly #beats = new Emitter<readonly ConsoleSessionEvent[]>("scenario beat");
  readonly #heldReplies = new HeldReplyQueue(SCENARIO_PENDING_REPLY_CAP);
  #elapsedMs = 0;
  #deliveredBeatCount = 0;
  #disposed = false;
  #droppedTickCount = 0;

  public constructor(options: ScenarioEngineOptions) {
    this.#scenario = options.scenario;
    this.#clock = options.clock ?? new ManualClock(Date.parse(options.scenario.startedAtIso));
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

  /** Subscribe to delivered beats. Returns an idempotent unsubscribe. */
  public subscribe(sink: ScenarioSink): Unsubscribe {
    return this.#beats.subscribe(sink);
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
    // Scripts are held to nondecreasing `atMs` by `scenarios/wire-truth.ts`, so a
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
    if (due.length === 0) {
      return;
    }
    this.#deliveredBeatCount += due.length;
    this.#beats.emit(due.map((beat) => beat.event));
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
   * and `fixture-bridge.ts` is what turns a due `ScenarioRejectingReply` into a
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

  /** How many sinks are attached. Read by tests and by the diagnostics surface. */
  public get sinkCount(): number {
    return this.#beats.sinkCount;
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
    this.#beats.clear();
    this.#heldReplies.abandonAll();
  }
}
