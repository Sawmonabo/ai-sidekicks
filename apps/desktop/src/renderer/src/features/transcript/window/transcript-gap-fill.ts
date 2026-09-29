// Replay from here: what a window that was told about entries it never received can ask
// for, and what it asks with.
//
// The store records a hole (named rows the daemon says exist and this window does not
// hold) as a `sequence-gap` cause that only a completed re-pull clears, and without a kept
// position that re-pull is the whole window re-read. `timeline.subscribe` takes an
// `afterCursor`, so a window holding a kept position can ask for exactly the rows it lost.
// The rows arrive on the subscription the store already holds; the pane never owns the
// stream.
//
// The position is the cursor a read acknowledged, never the newest row on screen: an event
// id is not a cursor, and the cursor is opaque and the daemon's.

import type { TimelineResubscribeRequest } from "@renderer/services/daemon/session-reads.js";

/**
 * Whether this window can ask for a replay, and what it would ask with.
 *
 * A discriminated union rather than a request that may be absent, because the two
 * absences are different facts a surface says differently: a window with nothing
 * missing has no reason to ask, and a window that IS missing rows and holds no kept
 * position cannot ask at all — its only repair is the whole-window re-read, which is
 * worth saying rather than leaving as a request that quietly never went out.
 */
export type TranscriptGapFillIntent =
  | { readonly outcome: "whole" }
  | { readonly outcome: "unanchored"; readonly missingFromSequence: number }
  | {
      readonly outcome: "resumable";
      readonly missingFromSequence: number;
      readonly request: TimelineResubscribeRequest;
    };

/** The three facts the decision is taken over, and nothing else. */
export interface TranscriptGapFillInput {
  readonly sessionId: string;
  /**
   * The first log position of the oldest hole standing, or nothing where none is.
   *
   * The OLDEST rather than the newest: a replay opens after one position and runs
   * forward, so asking from the newest hole would leave every earlier one unfilled
   * while reporting a repair.
   */
  readonly missingFromSequence: number | undefined;
  /** The position a read acknowledged, held by the store. Never derived from a row. */
  readonly keptCursor: string | undefined;
}

/** Decide what this window can ask for. Pure: it holds nothing and it calls nothing. */
export function resolveTranscriptGapFill(input: TranscriptGapFillInput): TranscriptGapFillIntent {
  if (input.missingFromSequence === undefined) {
    return { outcome: "whole" };
  }
  if (input.keptCursor === undefined) {
    return { outcome: "unanchored", missingFromSequence: input.missingFromSequence };
  }
  return {
    outcome: "resumable",
    missingFromSequence: input.missingFromSequence,
    request: { sessionId: input.sessionId, afterCursor: input.keptCursor },
  };
}

/**
 * The subject one fill is put under: this session's hole, and not this session.
 *
 * Keyed on the hole so exactly one ask goes out per hole. Keyed on the session alone
 * it would be one ask per session and a second hole would go unasked; keyed on the
 * store's revision it would be one ask per row admitted, which is the polling this
 * console forbids wearing a read's clothes.
 */
export function buildGapFillSubjectKey(sessionId: string, missingFromSequence: number): string {
  return `${sessionId}:${String(missingFromSequence)}`;
}
