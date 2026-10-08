// The replay a repair read starts on a store that already holds a window. It starts from the last
// whole row of the window, or of a replay it replaces, or at the window's head, and every row the
// stream sends after it folds here, off screen, while the window keeps the rows it holds and stays
// degraded. Once the replay reaches the newest row the stream had delivered, the store swaps it in.
//
// A row the window already holds is taken as the window's own object, matched by sequence and
// cursor, so a long session is not held twice while it repairs and a row on screen keeps its
// identity across the swap. The replay holds only what the window spans: past a detached tail it
// folds rows into the entities and holds none of them.

import type { ProjectedSessionEvent } from "./entities/vocabulary.js";
import { SequenceReconciler, orderBatchBySequence } from "./sequence-reconciler.js";
import {
  heldRowCursor,
  liveTailAfter,
  type SessionStoreState,
  type TranscriptWindowEdge,
  type TranscriptWindowTail,
} from "./state.js";

/** What a replay starts from: the window it repairs and the state it folds onto. */
export interface RepairReplayStart {
  /** The window on screen, whose rows the replay must pass before it replaces them. */
  readonly window: SessionStoreState;
  /** The replay's own run, placed where the replay starts. */
  readonly reconciler: SequenceReconciler;
  /** What the replay folds onto: a checkpoint the window held, or what the read established. */
  readonly startState: SessionStoreState;
}

/** The window's rows and edges once a replay is swapped in. */
export interface ReplayedWindow {
  readonly transcript: readonly ProjectedSessionEvent[];
  readonly transcriptHead: TranscriptWindowEdge;
  readonly transcriptTail: TranscriptWindowTail;
}

/** One repair's replay: the state it builds off screen and the window rows it must pass. */
export class RepairReplay {
  /** The replay's own run, which becomes the store's at the swap. */
  public readonly reconciler: SequenceReconciler;
  #state: SessionStoreState;
  readonly #heldCursor: number;
  readonly #heldTranscript: readonly ProjectedSessionEvent[];
  /** The tail the window had detached at, past which the replay holds no row. */
  readonly #detachedTail: TranscriptWindowTail | undefined;
  /** Where the walk over the held rows stands; replayed rows arrive in ascending order. */
  #heldIndex = 0;

  public constructor(start: RepairReplayStart) {
    this.reconciler = start.reconciler;
    this.#heldCursor = start.window.cursor;
    this.#heldTranscript = start.window.transcript;
    this.#detachedTail =
      start.window.transcriptTail.following === "detached"
        ? start.window.transcriptTail
        : undefined;
    this.#state = this.#withinHeldSpan(start.startState);
  }

  /** The state folded so far, never shown before the swap. */
  public get state(): SessionStoreState {
    return this.#state;
  }

  /**
   * Whether the replay has reached the newest row the stream delivered to the window, so it holds
   * every row the window does. A window the stream delivered nothing to is passed at once.
   */
  public get hasPassedHeldRows(): boolean {
    return this.reconciler.cursor >= this.#heldCursor;
  }

  /** Take the state one fold or mark produced. */
  public advance(state: SessionStoreState): void {
    this.#state = this.#withinHeldSpan(state);
  }

  /** A batch in sequence order, each row the window already holds given as the window's own. */
  public withHeldRows(events: readonly ProjectedSessionEvent[]): ProjectedSessionEvent[] {
    return orderBatchBySequence(events).map((event) => this.#heldRowFor(event) ?? event);
  }

  /**
   * The rows and edges `visible` takes from this replay: the replay's row at each sequence it
   * holds, and the window's own where it holds none, as a page loaded while the replay ran,
   * within what the window spans now. A live tail that falls short of the stream is detached
   * there, so the reader pages up to the stream rather than leaving a tail that never grows.
   */
  public windowOnto(visible: SessionStoreState): ReplayedWindow {
    const isTailDetached = visible.transcriptTail.following === "detached";
    const lowest = visible.transcript[0]?.sequence;
    const highest = isTailDetached ? visible.transcript.at(-1)?.sequence : undefined;
    const transcript = mergeBySequence(visible.transcript, this.#state.transcript).filter(
      (row) =>
        (lowest === undefined || row.sequence >= lowest) &&
        (highest === undefined || row.sequence <= highest),
    );
    const newest = transcript.at(-1);
    let transcriptTail: TranscriptWindowTail;
    if (isTailDetached) {
      transcriptTail = visible.transcriptTail;
    } else if (newest === undefined || newest.sequence >= this.#state.cursor) {
      transcriptTail = liveTailAfter(transcript);
    } else {
      transcriptTail = { cursor: heldRowCursor(newest), hasMore: true, following: "detached" };
    }
    return { transcript, transcriptHead: visible.transcriptHead, transcriptTail };
  }

  /** `state` holding no row past the tail the window had detached at, and detached there. */
  #withinHeldSpan(state: SessionStoreState): SessionStoreState {
    const detachedAt = this.#heldTranscript.at(-1)?.sequence;
    const newest = state.transcript.at(-1);
    if (
      this.#detachedTail === undefined ||
      detachedAt === undefined ||
      newest === undefined ||
      newest.sequence < detachedAt
    ) {
      return state;
    }
    return {
      ...state,
      transcript: state.transcript.filter((row) => row.sequence <= detachedAt),
      transcriptTail: this.#detachedTail,
    };
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

/** Two transcripts in sequence order as one, the replayed row winning where both hold one. */
function mergeBySequence(
  held: readonly ProjectedSessionEvent[],
  replayed: readonly ProjectedSessionEvent[],
): ProjectedSessionEvent[] {
  const merged: ProjectedSessionEvent[] = [];
  let heldIndex = 0;
  for (const row of replayed) {
    while (heldIndex < held.length && held[heldIndex]!.sequence < row.sequence) {
      merged.push(held[heldIndex]!);
      heldIndex += 1;
    }
    if (held[heldIndex]?.sequence === row.sequence) {
      heldIndex += 1;
    }
    merged.push(row);
  }
  merged.push(...held.slice(heldIndex));
  return merged;
}
