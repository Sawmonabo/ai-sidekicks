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
//     `core/emitter.ts` reasons about for sinks and this one has for lanes.
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
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../../core/index.js";
import {
  REVEAL_CATCH_UP_MULTIPLIER,
  REVEAL_CHECKPOINT_TAIL_CAP,
  REVEAL_FRAME_CHARACTER_BUDGET,
  REVEAL_GATE_TAIL_CHARACTERS,
  REVEAL_LITERAL_BACKTRACK_CAP,
} from "./frame-bounds.js";
import { safeRevealCeiling } from "./reveal-gate.js";
import type {
  RevealDelta,
  RevealDiagnostic,
  RevealEngineState,
  RevealFrame,
  RevealLaneState,
} from "./reveal-vocabulary.js";
import { RopeSmoother, type ProvenAppendToken } from "./rope-smoother.js";

export interface RevealEngineOptions {
  readonly clock: ConsoleClock;
  readonly frameCharacterBudget?: number;
}

/** One authoritative commit the lane can be re-anchored against. */
interface RevealCheckpoint {
  readonly sequence: number;
  readonly sourceLength: number;
}

interface RevealLane {
  readonly smoother: RopeSmoother;
  readonly checkpoints: RevealCheckpoint[];
  publishedText: string;
  appendToken: ProvenAppendToken | undefined;
  isCatchingUp: boolean;
  isQuarantined: boolean;
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
      this.#commitAuthoritative(lane, delta);
    } else {
      const token = lane.smoother.append(delta.text);
      if (token !== undefined) {
        lane.appendToken = token;
      }
    }
    this.#armFrame();
  }

  /** The text a consumer may render for this lane. Empty for a lane never seen. */
  public publishedText(laneId: string): string {
    return this.#lanesById.get(laneId)?.publishedText ?? "";
  }

  public laneState(laneId: string): RevealLaneState | undefined {
    const lane = this.#lanesById.get(laneId);
    return lane === undefined ? undefined : this.#describeLane(laneId, lane);
  }

  public lanes(): readonly RevealLaneState[] {
    return [...this.#lanesById.entries()].map(([laneId, lane]) => this.#describeLane(laneId, lane));
  }

  public get state(): RevealEngineState {
    if (this.#lanesById.size === 0) {
      return "idle";
    }
    const working = [...this.#lanesById.values()].filter((lane) => !lane.smoother.isSettled);
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
    const lane: RevealLane = {
      smoother: new RopeSmoother(laneId),
      checkpoints: [],
      publishedText: "",
      appendToken: undefined,
      isCatchingUp: false,
      isQuarantined: false,
    };
    this.#lanesById.set(laneId, lane);
    return lane;
  }

  /**
   * Fold an authoritative commit.
   *
   * The prefix check is the whole point: a producer that re-wrote its own history
   * — a retry, a rollback, a driver reconnect — must not have its new source glued
   * onto the tail of the old one.
   *
   * When the check fails the lane is re-based on the LONGEST COMMON PREFIX of what
   * it had published and what the producer now claims, and never on the published
   * LENGTH. Clamping to the length preserved the cursor's position and not its
   * text: a shorter rewrite truncated the visible prefix, and an equal-or-longer
   * one replaced every character after the divergence in a single frame with no
   * budget spent — which is the teleport this engine exists to prevent, arriving in
   * exactly the retry case the branch was written for. Rebasing on the agreed
   * prefix keeps the characters the two sources actually share, and the divergent
   * remainder is revealed by the ordinary per-frame budget, so a rewrite streams.
   *
   * Both strings are already materialised here, so the comparison reads no growing
   * source. The retraction is real — the producer withdrew text a reader had
   * already seen — so the diagnostic states how many characters went, rather than
   * claiming the revealed text held where it was.
   */
  #commitAuthoritative(lane: RevealLane, delta: RevealDelta): void {
    if (lane.smoother.isPrefixOf(delta.text)) {
      const appended = delta.text.slice(lane.smoother.sourceLength);
      const token = lane.smoother.append(appended);
      if (token !== undefined) {
        lane.appendToken = token;
        this.#recordCheckpoint(lane, token);
      }
      return;
    }
    const alreadyPublished = lane.publishedText;
    const agreedPrefixLength = commonPrefixLength(alreadyPublished, delta.text);
    this.#reportDiagnostic({
      kind: "out-of-band-source-change",
      laneId: delta.laneId,
      detail: `an authoritative commit did not extend the text this lane had published; the lane was re-based on the ${String(agreedPrefixLength)} characters both sources agree on and ${String(alreadyPublished.length - agreedPrefixLength)} characters were retracted`,
    });
    const rebased = new RopeSmoother(delta.laneId);
    const token = rebased.append(delta.text);
    rebased.advance(agreedPrefixLength);
    this.#lanesById.set(delta.laneId, {
      smoother: rebased,
      checkpoints: [],
      publishedText: rebased.revealedText(),
      appendToken: token,
      isCatchingUp: false,
      isQuarantined: false,
    });
  }

  #recordCheckpoint(lane: RevealLane, token: ProvenAppendToken): void {
    lane.checkpoints.push({ sequence: token.sequence, sourceLength: token.sourceLength });
    while (lane.checkpoints.length > REVEAL_CHECKPOINT_TAIL_CAP) {
      const dropped = lane.checkpoints.shift();
      if (dropped !== undefined) {
        this.#reportDiagnostic({
          kind: "checkpoint-dropped",
          laneId: lane.smoother.laneId,
          detail: `the checkpoint tail is bounded at ${String(REVEAL_CHECKPOINT_TAIL_CAP)}; the oldest anchor was released`,
        });
      }
    }
  }

  #armFrame(): void {
    if (this.#armedFrame !== undefined || this.#disposed) {
      return;
    }
    if (![...this.#lanesById.values()].some((lane) => this.#hasWork(lane))) {
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
    const workingLanes = [...this.#lanesById.entries()].filter(([, lane]) => this.#hasWork(lane));
    if (workingLanes.length === 0) {
      return;
    }
    const fairShare = Math.max(1, Math.floor(this.#frameCharacterBudget / workingLanes.length));
    const catchUpCeiling = fairShare * REVEAL_CATCH_UP_MULTIPLIER;
    const failures: string[] = [];
    let spent = 0;

    for (const [laneId, lane] of workingLanes) {
      // Cleared before the pass, so "catching up" describes THIS frame's
      // allocation rather than a flag a lane keeps once it has caught up.
      lane.isCatchingUp = false;
      spent += this.#advanceLane(laneId, lane, fairShare, failures);
    }
    // The remainder, offered in queue order to the lanes that are behind. Bounded
    // by the catch-up ceiling so a lane's RATE rises and its position never jumps.
    for (const [laneId, lane] of workingLanes) {
      const remaining = this.#frameCharacterBudget - spent;
      if (remaining <= 0) {
        break;
      }
      if (!this.#hasWork(lane)) {
        lane.isCatchingUp = false;
        continue;
      }
      const extra = Math.min(remaining, catchUpCeiling - fairShare);
      if (extra <= 0) {
        continue;
      }
      lane.isCatchingUp = true;
      spent += this.#advanceLane(laneId, lane, extra, failures);
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
  #advanceLane(laneId: string, lane: RevealLane, share: number, failures: string[]): number {
    try {
      const tail = lane.smoother.revealedTail(REVEAL_GATE_TAIL_CHARACTERS);
      const window = tail + lane.smoother.lookahead(share + REVEAL_LITERAL_BACKTRACK_CAP);
      const candidateInWindow = Math.min(tail.length + share, window.length);
      const gatedInWindow = safeRevealCeiling(window, candidateInWindow);
      const revealed = lane.smoother.advance(Math.max(0, gatedInWindow - tail.length));
      lane.publishedText = lane.smoother.revealedText();
      lane.isCatchingUp = lane.isCatchingUp && !lane.smoother.isSettled;
      this.#assertPublishedTextIsRevealCursor(lane);
      return revealed;
    } catch (transitionFailure: unknown) {
      lane.isQuarantined = true;
      failures.push(`${laneId}: ${String(transitionFailure)}`);
      return 0;
    }
  }

  #hasWork(lane: RevealLane): boolean {
    return !lane.isQuarantined && !lane.smoother.isSettled;
  }

  /**
   * This engine's named invariant: published text is the smoother's reveal cursor.
   *
   * Asserted under DEV and test only, because it is a claim about this module's own
   * bookkeeping rather than about anything a user did. `import.meta.env.DEV` is a
   * compile-time substitution, so a release bundle contains neither the check nor
   * the branch.
   */
  #assertPublishedTextIsRevealCursor(lane: RevealLane): void {
    if (!import.meta.env.DEV) {
      return;
    }
    if (lane.publishedText !== lane.smoother.revealedText()) {
      throw new Error(
        `reveal invariant broken on lane ${lane.smoother.laneId}: published text is not the smoother's reveal cursor`,
      );
    }
  }

  #describeLane(laneId: string, lane: RevealLane): RevealLaneState {
    return {
      laneId,
      publishedText: lane.publishedText,
      pendingCharacterCount: lane.smoother.pendingCharacterCount,
      isCatchingUp: lane.isCatchingUp,
      isSettled: lane.smoother.isSettled,
      appendToken: lane.appendToken,
    };
  }

  #reportDiagnostic(diagnostic: RevealDiagnostic): void {
    this.#diagnosticEmitter.emit(diagnostic);
  }
}

/**
 * How many leading characters two settled strings share.
 *
 * Both arguments are materialised strings the caller already holds — the text a
 * lane published and the whole source an authoritative commit carried — so this
 * inspects nothing that is still growing, which is the one thing the rope's
 * proven-append token exists to prevent.
 */
function commonPrefixLength(first: string, second: string): number {
  const ceiling = Math.min(first.length, second.length);
  let shared = 0;
  while (shared < ceiling && first[shared] === second[shared]) {
    shared += 1;
  }
  return shared;
}
