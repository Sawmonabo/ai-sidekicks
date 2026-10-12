// What the reveal engine publishes: its closed state and diagnostic sets, and the delta, lane and
// frame shapes. This module holds no state and imports nothing from the engine, so a consumer
// that only speaks the language never loads the scheduler.

import { type RevealCommitMode } from "./gate.js";
import { type PublishedText } from "./published-text.js";

/** The four states the engine reports. Closed, and derived into a union below. */
export const REVEAL_ENGINE_STATES = ["idle", "streaming", "catching-up", "settled"] as const;

/** One engine state. Derived from the enumeration, never restated. */
export type RevealEngineState = (typeof REVEAL_ENGINE_STATES)[number];

/** Why the engine reported something. Closed: a nameless diagnostic is noise. */
export const REVEAL_DIAGNOSTIC_KINDS = ["out-of-band-source-change", "transition-failed"] as const;

/** One diagnostic kind. Derived from the enumeration, never restated. */
export type RevealDiagnosticKind = (typeof REVEAL_DIAGNOSTIC_KINDS)[number];

/** One diagnostic the engine reports. */
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
   * The text a consumer may render, as the lane's one handle. Never shorter than last frame,
   * except after an out-of-band rebase where the producer withdrew published text; that
   * retraction is announced by the `out-of-band-source-change` diagnostic, which carries how
   * many characters went.
   */
  readonly publishedText: PublishedText;
  readonly pendingCharacterCount: number;
  /** True while the lane is taking more than its fair share to catch up. */
  readonly isCatchingUp: boolean;
  readonly isSettled: boolean;
}

/**
 * One drained frame, published to every subscriber at once. It carries no lane or state: a reader
 * that needs them asks the engine, so a frame costs no walk over the settled lanes.
 */
export interface RevealFrame {
  readonly charactersRevealed: number;
}
