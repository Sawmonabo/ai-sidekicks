// What the reveal engine PUBLISHES, and the two closed sets it publishes it in.
//
// The seam this module is on is not "the types" — it is the difference between
// SPEAKING the reveal engine's language and BEING the reveal engine. A card layer
// that renders a lane's published text, a diagnostics sink that counts
// quarantined lanes, and a test that asserts the state machine's own enumeration
// all need every name below and none of them needs the scheduler, the rope
// smoother, the checkpoint tail, or the per-frame budget allocation that
// `reveal-engine.ts` exists for. Splitting there leaves each file with one job:
// this one owns the vocabulary and holds no state; that one owns the mechanism
// and declares no vocabulary.
//
// The alternative seam — lane bookkeeping in one module and the frame scheduler in
// another — was considered and NOT taken. The fair-share pass and the catch-up
// remainder pass both read and write the same lane records inside one frame, and
// the diagnostics emitter is written from both halves, so that cut would put one
// job in two files rather than two jobs in two files.
//
// Nothing here imports the engine, so the engine imports this and the direction
// never reverses.

import { type RevealCommitMode } from "./reveal-gate.js";
import { type ProvenAppendToken } from "./rope-smoother.js";

/** The four states the engine reports. Closed, and derived into a union below. */
export const REVEAL_ENGINE_STATES = ["idle", "streaming", "catching-up", "settled"] as const;

/** One engine state. Derived from the enumeration, never restated. */
export type RevealEngineState = (typeof REVEAL_ENGINE_STATES)[number];

/** Why the engine reported something. Closed: a nameless diagnostic is noise. */
export const REVEAL_DIAGNOSTIC_KINDS = [
  "out-of-band-source-change",
  "transition-failed",
  "checkpoint-dropped",
] as const;

/** One diagnostic kind. Derived from the enumeration, never restated. */
export type RevealDiagnosticKind = (typeof REVEAL_DIAGNOSTIC_KINDS)[number];

export interface RevealDiagnostic {
  readonly kind: RevealDiagnosticKind;
  readonly laneId: string;
  readonly detail: string;
}

/** One delta from one producer. */
export interface RevealDelta {
  readonly laneId: string;
  readonly mode: RevealCommitMode;
  /** For `direct`, the appended text. For `authoritative`, the whole source. */
  readonly text: string;
}

/** What a lane looks like from outside. */
export interface RevealLaneState {
  readonly laneId: string;
  /**
   * The text a consumer may render.
   *
   * Never shorter than it was last frame, with one declared exception: an
   * out-of-band rebase, where the producer withdrew text it had already published
   * and the lane fell back to the prefix both sources agree on. That retraction is
   * real rather than a bookkeeping artefact, so it is announced — the
   * `out-of-band-source-change` diagnostic carries how many characters went — and
   * never papered over by holding a cursor whose text no longer matches.
   */
  readonly publishedText: string;
  readonly pendingCharacterCount: number;
  /** True while the lane is taking more than its fair share to catch up. */
  readonly isCatchingUp: boolean;
  readonly isSettled: boolean;
  /** The receipt for the most recent append, so a consumer proves growth by token. */
  readonly appendToken: ProvenAppendToken | undefined;
}

/** One drained frame, published to every subscriber at once. */
export interface RevealFrame {
  readonly state: RevealEngineState;
  readonly lanes: readonly RevealLaneState[];
  readonly charactersRevealed: number;
}
