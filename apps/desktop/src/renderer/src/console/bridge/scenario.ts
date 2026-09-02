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
//
// The engine holds ONE more thing than the script: the replies a scripted latency
// has parked. A `ScenarioReply` carrying `afterMs` is a request that has not been
// answered yet, and on a frozen clock the only thing that can answer it is the
// caller moving that clock. Holding them here rather than in the bridge is what
// keeps the frozen clock the single source of scenario time — a bridge that spent
// the delay itself would be a second clock, and the one property this whole file
// exists for is that there is only one.

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
import type { RuntimeNodeRosterEntry } from "@ai-sidekicks/contracts";

import { type ConsoleSessionEvent } from "../store/index.js";
import type { WireErrorEnvelope } from "../../../../shared/wire-errors.js";

/** One scripted event and the tick it is due at, measured from scenario start. */
export interface ScenarioBeat {
  readonly atMs: number;
  readonly event: ConsoleSessionEvent;
}

/**
 * One reading of a session's runtime-node roster, and the tick it becomes current.
 *
 * A frame rather than a single roster, and rather than a scripted reply, because a
 * roster CHANGES: the registered `runtimenode.roster` read is the source of truth
 * for the rendered set and a `runtime_node.*` beat only says WHEN to re-read, so a
 * fixture whose roster could not move would answer every re-read with the same rows
 * and make the whole snapshot-plus-signal discipline untestable. Mirrors
 * {@link ScenarioBeat} deliberately — same `atMs` measured from scenario start,
 * same "data, never code" posture — so a reader who has understood one has
 * understood the other.
 *
 * `nodes` is the registered `RuntimeNodeRosterEntry` set verbatim, so a scenario
 * carries BOTH health axes the wire carries — the slot axis `state` and the
 * sweep-owned `healthState` / `lastHeartbeatAt` pair — and no collapsed scalar,
 * which the wire does not have either. Reconciling them is the client's render-time
 * concern and a fixture that pre-reconciled them would answer a question the
 * surface exists to ask.
 */
export interface ScenarioRuntimeNodeRosterFrame {
  readonly atMs: number;
  readonly nodes: readonly RuntimeNodeRosterEntry[];
}

/** What every canned reply carries, whichever way it settles. */
interface ScenarioReplyBase {
  /** The daemon method or control-plane procedure name, verbatim. */
  readonly call: string;
  /**
   * Simulated latency, so a loading state is reachable in the fixture.
   *
   * Measured in scenario time, which only the caller moves: the reply stays
   * pending until the engine has been advanced this far past the call. It bounds
   * BOTH arms — a refusal a real transport takes 400 ms to deliver is a loading
   * state before it is an error, and a fixture that refused instantly would let a
   * surface ship without ever rendering that half.
   */
  readonly afterMs?: number;
}

/** A canned reply that answers with a value. */
export interface ScenarioResolvingReply extends ScenarioReplyBase {
  readonly result: unknown;
  readonly refusal?: never;
}

/**
 * A canned reply that REFUSES, with the shape the wire refuses in.
 *
 * Without this arm no scenario could reach a refusal at all: the fixture's own
 * `FixtureBridgeError` names something the FIXTURE could not do, so every typed
 * daemon refusal a surface has to render — an artifact too large, an ingest at
 * capacity, a terminal permission denied, a control already held by someone else —
 * was unreachable, and the console's refusal renderings could only ever be driven
 * from the growth port's one typed absence.
 *
 * `WireErrorEnvelope` is `src/shared/wire-errors.ts`'s, not a second refusal
 * vocabulary minted here: that module is the console's one home for the wire's
 * `{code, message}` shape and for `normalizeWireRejection`, which is what every
 * renderer catch arm already turns a rejection into. A fixture refusing in any
 * other shape would train a surface against a value the live bridge never sends.
 */
export interface ScenarioRejectingReply extends ScenarioReplyBase {
  readonly refusal: WireErrorEnvelope;
  readonly result?: never;
}

/**
 * A canned reply for one request/response call the scenario expects.
 *
 * Exactly one of `result` / `refusal`, enforced by the `?: never` member on each
 * arm rather than by two independent optionals — the two-arm-union idiom the
 * corpus already uses for `AgentAttachRequest` in
 * `docs/architecture/contracts/api-payload-contracts.md`. Two optionals would
 * admit both at once (a reply that resolves AND refuses) and neither at all (a
 * reply that settles no way), which are the two shapes nothing can serve.
 */
export type ScenarioReply = ScenarioResolvingReply | ScenarioRejectingReply;

export interface ConsoleScenario {
  readonly id: string;
  /** Shown in the fixture picker. Short; a name, not a sentence. */
  readonly label: string;
  /** What this scenario is for, so a reader knows which to reach for. */
  readonly purpose: string;
  readonly sessionId: string;
  /** Participants in join order — the hue allocator's input (rule 2). */
  readonly participantIdsInJoinOrder: readonly string[];
  /**
   * Which of those participants this window IS, where the scenario states one.
   *
   * OPTIONAL, and the optionality is the point: join order is who opened the session
   * and who followed, on any machine, so reading its head as "me" is a fabrication —
   * and a surface handed a fabricated identity renders a role gate as though it had
   * been checked. A scenario that does not say leaves this absent and the fixture
   * refuses the caller-identity read, which is the honest "not checked" answer.
   *
   * When present it must be a member of `participantIdsInJoinOrder`: an identity
   * outside the roster is a viewer of some other session, and every surface that
   * resolves a role would look it up and find nothing. `scenarios/wire-truth.ts`
   * holds every scenario to that, the substrate's own two included.
   */
  readonly viewingParticipantId?: string;
  readonly beats: readonly ScenarioBeat[];
  readonly replies: readonly ScenarioReply[];
  /**
   * The session's runtime-node roster as it reads over scenario time.
   *
   * OPTIONAL, and the optionality is the answer rather than a gap: a scenario that
   * names no roster has not been asked, so the read refuses with the "not checked"
   * absence instead of resolving with an empty set. Those are different facts — "no
   * machine is attached" is a session state a surface draws, and "nobody asked" is
   * not — and a fixture that conflated them would train the roster to render an
   * empty table for a read that never happened.
   *
   * It is a scenario member rather than a `replies` row because the reply table is
   * keyed by call name and answers each call with one fixed value, which cannot
   * express a roster that moves. A scenario needing latency or a scripted daemon
   * refusal for some other call still uses `replies`; this member is the one read
   * whose ANSWER is a function of the clock.
   */
  readonly runtimeNodeRoster?: readonly ScenarioRuntimeNodeRosterFrame[];
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
    const due = this.#scenario.beats
      .slice(this.#deliveredBeatCount)
      .filter((beat) => beat.atMs <= target);
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
