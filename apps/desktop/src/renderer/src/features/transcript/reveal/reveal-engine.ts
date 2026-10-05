// N reveal lanes streaming at once through a bounded per-frame character budget, so lanes move
// continuously, none jumps, and visible text never regresses. It publishes text and how much
// of it is safe to show; turning text into blocks belongs to the card layer. The engine's
// published types live in `model.ts`.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { lossyStringify } from "#renderer/lib/wire/errors.js";
import { recordRevealDrain } from "#renderer/lib/performance-meters/performance-meters.js";
import { AnimationFrameScheduler } from "../animation-frame-scheduler.js";
import {
  REVEAL_CATCH_UP_MULTIPLIER,
  REVEAL_FRAME_CHARACTER_BUDGET,
  REVEAL_GATE_TAIL_CHARACTERS,
  REVEAL_LITERAL_BACKTRACK_CAP,
} from "./caps.js";
import { safeRevealCeiling } from "./gate.js";
import { RevealLane } from "./reveal-lane.js";
import type {
  RevealDelta,
  RevealDiagnostic,
  RevealEngineState,
  RevealFrame,
  RevealLaneState,
} from "./model.js";

/** Options for a `RevealEngine`. */
export interface RevealEngineOptions {
  /**
   * The frame this engine's drains run inside. Required, and the engine has no clock of its
   * own: an optional scheduler would leave an unordered path open to any caller that forgot it.
   */
  readonly frameScheduler: AnimationFrameScheduler;
  /** Characters revealed per frame across all lanes; defaults to the shared frame budget. */
  readonly frameCharacterBudget?: number;
}

/**
 * N lanes streaming at once. Each frame every lane takes its fair share of the budget first;
 * only the remainder goes to lanes that are behind, capped at `REVEAL_CATCH_UP_MULTIPLIER`
 * shares, so every lane moves and none jumps. A `direct` delta is a trusted append; an
 * `authoritative` one is checked against what the lane holds. A lane whose advance throws is
 * quarantined and the others finish the frame.
 */
export class RevealEngine {
  readonly #frameScheduler: AnimationFrameScheduler;
  readonly #frameTaskKey: string;
  readonly #frameCharacterBudget: number;
  readonly #frameEmitter = new Emitter<RevealFrame>("reveal frame");
  readonly #diagnosticEmitter = new Emitter<RevealDiagnostic>("reveal diagnostic");
  /** Insertion order is the queue order the catch-up remainder is offered in. */
  readonly #lanesById = new Map<string, RevealLane>();
  /**
   * The ids of retired lanes that had published text, and no text: a reply's foot outlives the
   * text it stood under. One id per lane this engine streamed, so it never outgrows the session.
   */
  readonly #retiredPublishedLaneIds = new Set<string>();

  #frameSubmitted = false;
  #disposed = false;

  public constructor(options: RevealEngineOptions) {
    this.#frameScheduler = options.frameScheduler;
    this.#frameTaskKey = options.frameScheduler.claimTaskKey("transcript-reveal-drain");
    this.#frameCharacterBudget = options.frameCharacterBudget ?? REVEAL_FRAME_CHARACTER_BUDGET;
  }

  /**
   * Take one delta. Arms a frame only when there is work, so an idle engine holds no timer.
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

  /**
   * Whether this lane has published text: true while it shows some, and still true after the
   * lane retired and dropped it.
   */
  public hasPublishedText(laneId: string): boolean {
    return this.publishedText(laneId) !== "" || this.#retiredPublishedLaneIds.has(laneId);
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

  /** True while a drain is submitted. The viewport defers pruning while this is true. */
  public get isDraining(): boolean {
    return this.#frameSubmitted;
  }

  /**
   * Whether this engine has been torn down. The React binding checks it to re-mint after a
   * remount: a disposed engine ignores every delta.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Watch drained frames. No resend: a frame is an event, not a state. */
  public subscribe(sink: (frame: RevealFrame) => void): Unsubscribe {
    return this.#frameEmitter.subscribe(sink);
  }

  public subscribeToDiagnostics(sink: (diagnostic: RevealDiagnostic) => void): Unsubscribe {
    return this.#diagnosticEmitter.subscribe(sink);
  }

  /**
   * Drop a lane whose run ended, so a finished turn stops costing memory; only whether it had
   * published text is kept.
   */
  public retireLane(laneId: string): void {
    if (this.publishedText(laneId) !== "") {
      this.#retiredPublishedLaneIds.add(laneId);
    }
    this.#lanesById.delete(laneId);
  }

  /** Terminal. A disposed engine arms nothing and reaches nobody. */
  public dispose(): void {
    this.#cancelFrame();
    this.#frameEmitter.clear();
    this.#diagnosticEmitter.clear();
    this.#lanesById.clear();
    this.#retiredPublishedLaneIds.clear();
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
    if (this.#frameSubmitted || this.#disposed) {
      return;
    }
    if (![...this.#lanesById.values()].some((lane) => lane.hasWork())) {
      return;
    }
    this.#frameSubmitted = true;
    this.#frameScheduler.scheduleRevealWork(this.#frameTaskKey, () => {
      this.#frameSubmitted = false;
      this.#drainFrame();
    });
  }

  #cancelFrame(): void {
    if (!this.#frameSubmitted) {
      return;
    }
    this.#frameScheduler.cancel("reveal-work", this.#frameTaskKey);
    this.#frameSubmitted = false;
  }

  /** One frame's work: allocate, advance, publish, and re-arm only if anything is pending. */
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
      // Cleared before the pass so "catching up" describes this frame's allocation.
      lane.isCatchingUp = false;
      spent += this.#advanceLane(lane, fairShare, failures);
    }
    // The remainder, offered in queue order to lanes that are behind, bounded by the catch-up
    // ceiling so a lane's rate rises and its position never jumps.
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
        detail:
          `${String(failures.length)} lanes were quarantined after their ` +
          "reveal transition threw; the remaining lanes finished the frame",
      });
    }
    this.#frameEmitter.emit({ state: this.state, lanes: this.lanes(), charactersRevealed: spent });
    // The series key comes from the scheduler, which also retires it on dispose: the task key
    // alone repeats across schedulers (one per feed), and two spellings of one key retire
    // nothing.
    recordRevealDrain(this.#frameScheduler.meterSeriesKeyFor(this.#frameTaskKey), spent);
    this.#armFrame();
  }

  #advanceLane(lane: RevealLane, share: number, failures: string[]): number {
    try {
      return lane.advance(
        share,
        safeRevealCeiling,
        REVEAL_GATE_TAIL_CHARACTERS,
        REVEAL_LITERAL_BACKTRACK_CAP,
      );
    } catch (transitionFailure: unknown) {
      // The lane releases what it will not reveal instead of only being flagged: a flagged lane
      // would keep a rope the producer goes on growing and no frame would walk.
      lane.quarantine();
      // The total stringifier: a `String(...)` that threw inside this handler would escape the
      // frame loop past `#armFrame()` and stop every lane for good, with no diagnostic.
      failures.push(`${lane.laneId}: ${lossyStringify(transitionFailure)}`);
      return 0;
    }
  }

  #reportDiagnostic(diagnostic: RevealDiagnostic): void {
    this.#diagnosticEmitter.emit(diagnostic);
  }
}
