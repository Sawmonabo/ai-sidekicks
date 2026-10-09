// The replay a repair read starts on a store that already holds a window. It starts from the last
// whole row of the window, or of a replay it replaces, or from what the read established at the
// window's head, and every row the stream sends after it folds here, off screen, while the window
// keeps the rows it holds and stays degraded. The stream reopens after where the replay starts, so
// the replay comes to every row the window holds after it; once it reaches the newest of them it
// holds those rows and the holes between them, and the store swaps it in.
//
// A row the window already holds is taken as the window's own object, matched by sequence and
// cursor, so a long session is not held twice while it repairs and a row on screen keeps its
// identity across the swap.

import type { ProjectedSessionEvent } from "./entities/vocabulary.js";
import { SequenceReconciler, orderBatchBySequence } from "./sequence-reconciler.js";
import type { SessionStoreState } from "./state.js";

/** What a replay starts from: the window it repairs and the state it folds onto. */
export interface RepairReplayStart {
  /** The window on screen, whose rows the replay must pass before it replaces them. */
  readonly window: SessionStoreState;
  /** The replay's own run, placed where the replay starts. */
  readonly reconciler: SequenceReconciler;
  /** What the replay folds onto: a checkpoint the window held, or what the read established. */
  readonly startState: SessionStoreState;
}

/** One repair's replay: the state it builds off screen and the window rows it must pass. */
export class RepairReplay {
  /** The replay's own run, which becomes the store's at the swap. */
  public readonly reconciler: SequenceReconciler;
  #state: SessionStoreState;
  readonly #heldCursor: number;
  readonly #heldTranscript: readonly ProjectedSessionEvent[];
  /** Where the walk over the held rows stands; replayed rows arrive in ascending order. */
  #heldIndex = 0;

  public constructor(start: RepairReplayStart) {
    this.reconciler = start.reconciler;
    this.#state = start.startState;
    this.#heldCursor = start.window.cursor;
    this.#heldTranscript = start.window.transcript;
  }

  /** The state folded so far, never shown before the swap. */
  public get state(): SessionStoreState {
    return this.#state;
  }

  /**
   * Whether the replay has reached the newest row the window holds, so it holds every one of
   * them. A window that admitted none is passed at once.
   */
  public get hasPassedHeldRows(): boolean {
    return this.reconciler.cursor >= this.#heldCursor;
  }

  /** Take the state one fold or mark produced. */
  public advance(state: SessionStoreState): void {
    this.#state = state;
  }

  /** A batch in sequence order, each row the window already holds given as the window's own. */
  public withHeldRows(events: readonly ProjectedSessionEvent[]): ProjectedSessionEvent[] {
    return orderBatchBySequence(events).map((event) => this.#heldRowFor(event) ?? event);
  }

  #heldRowFor(event: ProjectedSessionEvent): ProjectedSessionEvent | undefined {
    const held = this.#heldTranscript;
    while (this.#heldIndex < held.length && held[this.#heldIndex]!.sequence < event.sequence) {
      this.#heldIndex += 1;
    }
    const candidate = held[this.#heldIndex];
    return candidate?.sequence === event.sequence && candidate.cursor === event.cursor
      ? candidate
      : undefined;
  }
}
