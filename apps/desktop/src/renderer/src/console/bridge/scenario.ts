// Scenarios: what the fixture bridge serves, and the engine that plays them.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge: "the fixture bridge
// serves scripted scenarios over async generators with a frozen clock … the fixture
// clock is the only clock the renderer reads in fixture mode."
//
// A scenario is therefore DATA, not code: an ordered script of events with the
// millisecond each is due, plus canned replies for request/response calls. That
// matters for two reasons beyond tidiness — a data scenario can be asserted against
// (the screenshot tier pins a frame by advancing to an exact tick), and a scenario
// that cannot reach the network or the clock cannot accidentally become flaky.
//
// The engine's one sharp edge is teardown. A pane that unmounts mid-scenario leaves
// the engine disposed while a timer callback is still in flight; delivering into a
// torn-down subscriber would either throw inside a React commit or write into a
// store that no longer has a consumer. So `dispose()` is final: every later tick is
// dropped and reported on the tripwire rather than delivered.

import {
  Emitter,
  ManualClock,
  SCENARIO_TICK_MS,
  reportTripwire,
  type ConsoleClock,
  type EmitterSink,
  type Unsubscribe,
} from "../core/index.js";
import { type ConsoleSessionEvent } from "../store/index.js";

/** One scripted event and the tick it is due at, measured from scenario start. */
export interface ScenarioBeat {
  readonly atMs: number;
  readonly event: ConsoleSessionEvent;
}

/** A canned reply for one request/response call the scenario expects. */
export interface ScenarioReply {
  /** The daemon method or control-plane procedure name, verbatim. */
  readonly call: string;
  readonly result: unknown;
  /** Simulated latency, so a loading state is reachable in the fixture. */
  readonly afterMs?: number;
}

export interface ConsoleScenario {
  readonly id: string;
  /** Shown in the fixture picker. Short; a name, not a sentence. */
  readonly label: string;
  /** What this scenario is for, so a reader knows which to reach for. */
  readonly purpose: string;
  readonly sessionId: string;
  /** Participants in join order — the hue allocator's input (rule 2). */
  readonly participantIdsInJoinOrder: readonly string[];
  readonly beats: readonly ScenarioBeat[];
  readonly replies: readonly ScenarioReply[];
  /** Wall-clock instant the frozen clock reports as "now" at tick zero. */
  readonly startedAtIso: string;
}

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
    const due = this.#scenario.beats
      .slice(this.#deliveredBeatCount)
      .filter((beat) => beat.atMs <= target);
    this.#elapsedMs = target;
    if (this.#clock.advance !== undefined) {
      this.#clock.advance(deltaMs);
    }
    if (due.length === 0) {
      return;
    }
    this.#deliveredBeatCount += due.length;
    this.#beats.emit(due.map((beat) => beat.event));
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

  /** Final. Later ticks are dropped and counted; sinks are released. */
  public dispose(): void {
    this.#disposed = true;
    this.#beats.clear();
  }
}
