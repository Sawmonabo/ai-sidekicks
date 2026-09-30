// What the endurance tier reads about a window's session subscriptions. The subscriber composes it
// from its own state and hands it to the window's registry hook, which gives it to the fixture
// composition to put on the page; no module below `app/` writes the page.

import { type TranscriptWindowReading } from "@renderer/lib/transcript-window-diagnostics.js";

/**
 * What a fixture build exposes to the endurance tier: four reads, no writes and no handles, so a
 * tier driving a real window from outside cannot open a session, close one or apply an event.
 */
export interface SessionDiagnostics {
  /** Sessions the registry currently holds a store for, in open order. */
  openSessionIds: () => readonly string[];
  /**
   * Events this window has put through one session's apply chokepoint, counting deliveries the
   * registry accepted for the session's apply queue. It is not the store's timeline length, which
   * is zero until a read gives the store a base state. It is zero on a window whose registry can
   * initialize no store, since that window takes no wire subscription. It is retained after a
   * session closes, so the count freezes rather than vanishing.
   */
  appliedEventCountFor: (sessionId: string) => number;
  /** Sessions the binder currently holds a wire subscription for. */
  boundSessionIds: () => readonly string[];
  /**
   * What one session's transcript viewport is showing, or `null` where none is mounted. A row
   * count off the document cannot tell a window that mounted its rows from one with nothing to
   * mount or a viewport measured at no height; its figures separate them and `null`
   * separates all three from a route with no transcript. It is read from the mounted viewport
   * through the floor's registry, not composed here.
   */
  transcriptWindowFor: (sessionId: string) => TranscriptWindowReading | null;
}
