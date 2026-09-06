// The reveal engine — N lanes streaming at once, none of them teleporting.
//
// `Spec-023 §The four bars`, Light on the machine: "streaming paints through a bounded
// reveal budget so four concurrent lanes cost one frame", and `Spec-023 §Console Test
// Tiers` puts "reveal monotonicity" in the browser tier. THE SENTENCE THIS MODULE ADDS,
// because no committed document states it: stream N agents at once so every lane moves
// continuously and no lane teleports, with the visible text never regressing. Four
// decisions carry it:
//
//   • **One ordered queue, two closed commit modes.** `direct` deltas are appends
//     and are trusted; `authoritative` deltas carry the producer's whole view of
//     the source and are CHECKED against what this lane holds. A producer whose
//     source changed under us is a diagnostic, never a silent concatenation of two
//     disagreeing histories.
//   • **The budget is allocated across lanes every frame, never spent on one.**
//     Each lane takes its fair share first; only the remainder is offered to lanes
//     that are behind, and never more than `REVEAL_CATCH_UP_MULTIPLIER` shares.
//     Catch-up raises a lane's rate and never jumps it, which is why
//     four lanes all move rather than one finishing while three wait.
//   • **The frame is the only scheduler.** Work is armed through the clock seam and
//     re-armed only while a lane has characters left. A settled engine has no timer
//     armed at all, which is the idle-CPU budget's precondition and is asserted
//     rather than claimed.
//   • **Transition failures aggregate.** A lane whose advance throws is quarantined
//     and counted; the other lanes finish their frame. Letting the first throw
//     escape would make delivery depend on lane order, which is the failure mode
//     `core/emitter.ts` reasons about for sinks and this one has for lanes. A
//     quarantine also STOPS COSTING: the lane releases the text it will never
//     reveal and refuses every speculative delta after it, so a producer that keeps
//     streaming into a lane the engine has given up on grows nothing.
//
// WHAT THIS ENGINE IS NOT. It publishes TEXT and says how much of it is safe to
// show. Turning that text into blocks — the incremental lex, the memoized block
// parse, the settled-block subtree, the highlight cache — is the card layer's, and
// a parser here would be a second one.
//
// WHAT IT NO LONGER DECLARES. The two closed sets and the four published shapes —
// the engine states, the diagnostic kinds, a delta, a lane state, a frame — live in
// `reveal-vocabulary.ts`, which states why the cut is there. A consumer that only
// speaks the language holds that module and never this one.

import {
  Emitter,
  REVEAL_FRAME_CHARACTER_BUDGET,
  REVEAL_LITERAL_BACKTRACK_CAP,
  lossyStringify,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../../../core/index.js";
import { REVEAL_CATCH_UP_MULTIPLIER, REVEAL_GATE_TAIL_CHARACTERS } from "../frame-bounds.js";
import { safeRevealCeiling } from "./reveal-gate.js";
import { RevealLane } from "./reveal-lane.js";
import type {
  RevealDelta,
  RevealDiagnostic,
  RevealEngineState,
  RevealFrame,
  RevealLaneState,
} from "./reveal-vocabulary.js";

export interface RevealEngineOptions {
  readonly clock: ConsoleClock;
  readonly frameCharacterBudget?: number;
}

export class RevealEngine {
  readonly #clock: ConsoleClock;
  readonly #frameCharacterBudget: number;
  readonly #frameEmitter = new Emitter<RevealFrame>("reveal frame");
  readonly #diagnosticEmitter = new Emitter<RevealDiagnostic>("reveal diagnostic");
  /** Insertion-ordered: the one ordered queue the header's first decision names. */
  readonly #lanesById = new Map<string, RevealLane>();

  #armedFrame: ScheduledHandle | undefined;
  #disposed = false;

  public constructor(options: RevealEngineOptions) {
    this.#clock = options.clock;
    this.#frameCharacterBudget = options.frameCharacterBudget ?? REVEAL_FRAME_CHARACTER_BUDGET;
  }

  /**
   * Take one delta.
   *
   * Arming happens here and nowhere else, and only when there is work: an engine
   * handed an empty delta arms nothing, which is what keeps an idle console at zero
   * timers.
   */
  public ingest(delta: RevealDelta): void {
    if (this.#disposed) {
      return;
    }
    const lane = this.#laneFor(delta.laneId);
    if (delta.mode === "authoritative") {
      lane.commitAuthoritative(delta, (diagnostic) => {
        this.#reportDiagnostic(diagnostic);
      });
    } else {
      lane.appendSpeculative(delta.text);
    }
    this.#armFrame();
  }

  /** The text a consumer may render for this lane. Empty for a lane never seen. */
  public publishedText(laneId: string): string {
    return this.#lanesById.get(laneId)?.publishedText ?? "";
  }

  public laneState(laneId: string): RevealLaneState | undefined {
    const lane = this.#lanesById.get(laneId);
    return lane?.describe();
  }

  public lanes(): readonly RevealLaneState[] {
    return [...this.#lanesById.values()].map((lane) => lane.describe());
  }

  public get state(): RevealEngineState {
    if (this.#lanesById.size === 0) {
      return "idle";
    }
    const working = [...this.#lanesById.values()].filter((lane) => !lane.isSettled);
    if (working.length === 0) {
      return "settled";
    }
    return working.some((lane) => lane.isCatchingUp) ? "catching-up" : "streaming";
  }

  /** True while a frame is armed. `LedgerWindow` reads this to defer prune. */
  public get isDraining(): boolean {
    return this.#armedFrame !== undefined;
  }

  /**
   * Whether this engine has been torn down.
   *
   * Read by the React binding's re-mint arm: a remount of the same component instance
   * has already run the cleanup, and a disposed engine silently ignores every delta,
   * so the second mount has to be able to tell a live engine from a corpse.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Watch drained frames. No replay: a frame is an event, not a state. */
  public subscribe(sink: (frame: RevealFrame) => void): Unsubscribe {
    return this.#frameEmitter.subscribe(sink);
  }

  public subscribeToDiagnostics(sink: (diagnostic: RevealDiagnostic) => void): Unsubscribe {
    return this.#diagnosticEmitter.subscribe(sink);
  }

  /** Drop a lane whose run ended, so a finished turn stops costing memory. */
  public retireLane(laneId: string): void {
    this.#lanesById.delete(laneId);
  }

  /** Terminal. A disposed engine arms nothing and reaches nobody. */
  public dispose(): void {
    this.#cancelFrame();
    this.#frameEmitter.clear();
    this.#diagnosticEmitter.clear();
    this.#lanesById.clear();
    this.#disposed = true;
  }

  #laneFor(laneId: string): RevealLane {
    const existing = this.#lanesById.get(laneId);
    if (existing !== undefined) {
      return existing;
    }
    const lane = new RevealLane(laneId);
    this.#lanesById.set(laneId, lane);
    return lane;
  }

  #armFrame(): void {
    if (this.#armedFrame !== undefined || this.#disposed) {
      return;
    }
    if (![...this.#lanesById.values()].some((lane) => lane.hasWork())) {
      return;
    }
    this.#armedFrame = this.#clock.scheduleFrame(() => {
      this.#armedFrame = undefined;
      this.#drainFrame();
    });
  }

  #cancelFrame(): void {
    if (this.#armedFrame === undefined) {
      return;
    }
    this.#clock.cancel(this.#armedFrame);
    this.#armedFrame = undefined;
  }

  /**
   * One frame's work: allocate, advance, publish, and re-arm only if anything is
   * still pending.
   */
  #drainFrame(): void {
    const workingLanes = [...this.#lanesById.values()].filter((lane) => lane.hasWork());
    if (workingLanes.length === 0) {
      return;
    }
    const fairShare = Math.max(1, Math.floor(this.#frameCharacterBudget / workingLanes.length));
    const catchUpCeiling = fairShare * REVEAL_CATCH_UP_MULTIPLIER;
    const failures: string[] = [];
    let spent = 0;

    for (const lane of workingLanes) {
      // Cleared before the pass, so "catching up" describes THIS frame's
      // allocation rather than a flag a lane keeps once it has caught up.
      lane.isCatchingUp = false;
      spent += this.#advanceLane(lane, fairShare, failures);
    }
    // The remainder, offered in queue order to the lanes that are behind. Bounded
    // by the catch-up ceiling so a lane's RATE rises and its position never jumps.
    for (const lane of workingLanes) {
      const remaining = this.#frameCharacterBudget - spent;
      if (remaining <= 0) {
        break;
      }
      if (!lane.hasWork()) {
        lane.isCatchingUp = false;
        continue;
      }
      const extra = Math.min(remaining, catchUpCeiling - fairShare);
      if (extra <= 0) {
        continue;
      }
      lane.isCatchingUp = true;
      spent += this.#advanceLane(lane, extra, failures);
    }

    if (failures.length > 0) {
      this.#reportDiagnostic({
        kind: "transition-failed",
        laneId: failures.join(", "),
        detail: `${String(failures.length)} lanes were quarantined after their reveal transition threw; the remaining lanes finished the frame`,
      });
    }
    this.#frameEmitter.emit({ state: this.state, lanes: this.lanes(), charactersRevealed: spent });
    this.#armFrame();
  }

  /** Advance one lane through the gate. Returns the characters actually revealed. */
  #advanceLane(lane: RevealLane, share: number, failures: string[]): number {
    try {
      return lane.advance(
        share,
        safeRevealCeiling,
        REVEAL_GATE_TAIL_CHARACTERS,
        REVEAL_LITERAL_BACKTRACK_CAP,
      );
    } catch (transitionFailure: unknown) {
      // The lane RELEASES what it will not reveal rather than only being flagged —
      // see `RevealLane.quarantine`. Flagged alone, it stayed in the map with a rope
      // the producer went on growing and no frame would ever walk.
      lane.quarantine();
      // The TOTAL stringifier, because this expression runs after the `catch` has
      // been entered and a `String(...)` that threw here would leave the handler by
      // exception: the throw escapes the frame loop past `#armFrame()`, so one
      // lane's null-prototype failure value stops every lane permanently, with no
      // diagnostic and no terminal. A quarantine that takes the engine with it is
      // not a quarantine.
      failures.push(`${lane.laneId}: ${lossyStringify(transitionFailure)}`);
      return 0;
    }
  }

  #reportDiagnostic(diagnostic: RevealDiagnostic): void {
    this.#diagnosticEmitter.emit(diagnostic);
  }
}
