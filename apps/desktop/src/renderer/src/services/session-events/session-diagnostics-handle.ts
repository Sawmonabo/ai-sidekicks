// What the endurance tier reads about a window's session subscriptions.
//
// The subscriber composes it from its own state and hands it to the window's registry hook,
// which gives it to the fixture composition to put on the page. This module holds only the
// shape the subscriber builds and the drivers read; no module below `app/` writes the page.

import { type TranscriptWindowReading } from "@renderer/lib/transcript-window-diagnostics.js";

/**
 * What a fixture build exposes to the endurance tier, and nothing more.
 *
 * Four reads, no writes and no handles: a tier driving a real window from outside
 * the renderer can ask what is open, what is bound, how much has flowed, and what one
 * session's ledger is showing of it — and cannot open a session, close one, or apply
 * an event.
 */
export interface ConsoleSessionDiagnostics {
  /** Sessions the registry currently holds a store for, in open order. */
  openSessionIds: () => readonly string[];
  /**
   * Events this window has put through one session's apply chokepoint.
   *
   * Deliberately NOT the store's timeline length: a store admits nothing until a
   * read gives it a base state, so a timeline reading is zero for every session
   * whose read has not landed, and a diagnostic that reports the same number
   * whether or not the binder exists is worse than no diagnostic at all. This
   * counts admissions to the chokepoint: deliveries the registry accepted for a
   * session's apply queue. It is zero — correctly, and beside `boundSessionIds()`
   * reading empty — on a window whose registry can initialize no store, because
   * that window takes no wire subscription in the first place.
   *
   * Retained after a session closes, so the count FREEZES rather than vanishing.
   * A reading that disappeared on close could not be told apart from a session
   * that never received anything.
   */
  appliedEventCountFor: (sessionId: string) => number;
  /** Sessions the binder currently holds a wire subscription for. */
  boundSessionIds: () => readonly string[];
  /**
   * What one session's ledger viewport is showing, or `null` where none is mounted.
   *
   * The reading a windowing claim has to be made against, because a row count taken
   * off the document answers one question with three states collapsed into it: a
   * window that mounted its rows, a window with nothing to mount, and a viewport the
   * browser measured at no height, which computes no range and mounts nothing however
   * long anybody waits. The five figures separate them, and `null` separates all
   * three from a route with no ledger on it at all.
   *
   * Not the binder's own state and deliberately not composed here: it is read from
   * the mounted viewport that registered it, through the floor's registry.
   */
  ledgerWindowFor: (sessionId: string) => TranscriptWindowReading | null;
}
