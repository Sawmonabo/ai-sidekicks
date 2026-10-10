// N reveal lanes streaming at once through a bounded per-frame character budget, so lanes move
// continuously, none jumps, and visible text never regresses. It publishes text and how much
// of it is safe to show; turning text into blocks belongs to the card layer. The engine's
// published types live in `model.ts`.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { lossyStringify } from "#renderer/lib/wire/errors.js";
import { recordRevealDrain } from "#renderer/lib/performance-meters/registry.js";
import { AnimationFrameScheduler } from "../animation-frame-scheduler.js";
import {
  REVEAL_CATCH_UP_MULTIPLIER,
  REVEAL_FRAME_CHARACTER_BUDGET,
  REVEAL_GATE_TAIL_CHARACTERS,
  REVEAL_LITERAL_BACKTRACK_CAP,
} from "./caps.js";
import { safeRevealCeiling } from "./gate.js";
import { RevealLane } from "./lane.js";
import { type PublishedText } from "./published-text.js";
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
   * The lanes with text left to reveal, in queue order, kept apart so a frame walks only these: a
   * settled lane stays held until its row leaves the window and costs no frame meanwhile.
   */
  readonly #workingLanes: RevealLane[] = [];
  /** Each held lane's place in the queue, by when it was first seen. */
  readonly #queuePositionByLane = new Map<RevealLane, number>();
  #nextQueuePosition = 0;

  /** Bumped whenever a lane is first held or retired, the only changes `holdsLane` sees. */
  #laneRevision = 0;
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
    if (lane.hasWork()) {
      this.#markWorking(lane);
    } else {
      // An authoritative commit can leave a lane with nothing left to reveal.
      this.#dropSettledLanes();
    }
    this.#armFrame();
  }

  /**
   * The text a consumer may render for this lane: the same handle for the lane's life, or
   * `undefined` for a lane never seen.
   */
  public publishedText(laneId: string): PublishedText | undefined {
    return this.#lanesById.get(laneId)?.publishedText;
  }

  /** Whether a lane by this name is held: seen and not yet retired. A map lookup. */
  public holdsLane(laneId: string): boolean {
    return this.#lanesById.has(laneId);
  }

  /** A count that moves exactly when the set of held lanes does, so a reader can re-ask cheaply. */
  public get laneRevision(): number {
    return this.#laneRevision;
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
    // A lane with no work is settled: a quarantined lane released what it will not reveal.
    if (this.#workingLanes.length === 0) {
      return "settled";
    }
    return this.#workingLanes.some((lane) => lane.isCatchingUp) ? "catching-up" : "streaming";
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
   * Drop a lane whose row the window let go, so its text stops costing memory. A reader still
   * holding its text keeps only what was revealed: the rest is released first.
   */
  public retireLane(laneId: string): void {
    const lane = this.#lanesById.get(laneId);
    if (lane === undefined) {
      return;
    }
    lane.quarantine();
    this.#lanesById.delete(laneId);
    this.#laneRevision += 1;
    this.#queuePositionByLane.delete(lane);
    this.#dropSettledLanes();
  }

  /** Terminal. A disposed engine arms nothing and reaches nobody. */
  public dispose(): void {
    this.#cancelFrame();
    this.#frameEmitter.clear();
    this.#diagnosticEmitter.clear();
    this.#lanesById.clear();
    this.#workingLanes.length = 0;
    this.#queuePositionByLane.clear();
    this.#disposed = true;
  }

  #laneFor(laneId: string): RevealLane {
    const existing = this.#lanesById.get(laneId);
    if (existing !== undefined) {
      return existing;
    }
    const lane = new RevealLane(laneId);
    this.#lanesById.set(laneId, lane);
    this.#laneRevision += 1;
    this.#queuePositionByLane.set(lane, this.#nextQueuePosition);
    this.#nextQueuePosition += 1;
    return lane;
  }

  /** Put a lane with work among the working lanes, at its place in the queue, once. */
  #markWorking(lane: RevealLane): void {
    if (this.#workingLanes.includes(lane)) {
      return;
    }
    const position = this.#queuePositionByLane.get(lane) ?? this.#nextQueuePosition;
    const before = this.#workingLanes.findIndex(
      (working) => (this.#queuePositionByLane.get(working) ?? 0) > position,
    );
    this.#workingLanes.splice(before === -1 ? this.#workingLanes.length : before, 0, lane);
  }

  /** Drop every working lane left with nothing to reveal. */
  #dropSettledLanes(): void {
    let kept = 0;
    for (const lane of this.#workingLanes) {
      if (lane.hasWork()) {
        this.#workingLanes[kept] = lane;
        kept += 1;
      }
    }
    this.#workingLanes.length = kept;
  }

  #armFrame(): void {
    if (this.#frameSubmitted || this.#disposed) {
      return;
    }
    if (this.#workingLanes.length === 0) {
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
    // A copy: the passes below read the frame's lanes while the list is pruned after them.
    const workingLanes = this.#workingLanes.filter((lane) => lane.hasWork());
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
    this.#dropSettledLanes();
    // Armed before the frame is published, so a subscriber reads whether another drain follows.
    this.#armFrame();
    this.#frameEmitter.emit({ charactersRevealed: spent });
    // The series key comes from the scheduler, which also retires it on dispose: the task key
    // alone repeats across schedulers (one per feed), and two spellings of one key retire
    // nothing.
    recordRevealDrain(this.#frameScheduler.meterSeriesKeyFor(this.#frameTaskKey), spent);
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
