// Keeps about two screen heights of rows loaded above the screen, without a scroll. Once per placed
// window it fills around the opening screen: a tail let go while the session was off screen reads
// forward, otherwise the head reads back until two screen heights sit above the screen. Held rows
// can later shrink with no scroll (a finished run folds, a person folds one, the window lets rows
// go), so the head is checked again when the drawn rows fall, the head edge moves, a read past the
// head ends or the measure changes. A streamed row alone is never checked, so the held log is not
// re-derived per event. It runs in an effect, so a session paints first no later than without it.

import { useEffect, useRef } from "react";

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";

import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { TRANSCRIPT_APPROACH_SCREEN_HEIGHTS } from "../../viewport/caps.js";
import { type TranscriptStretchMeasure } from "../reader.js";
import { type TranscriptHistory } from "./useTranscriptHistory.js";

/** The reader that looks ahead, the store it reads into, and the viewport it measures in. */
export interface HistoryLookAheadInputs {
  readonly history: TranscriptHistory | undefined;
  readonly sessionStore: SessionStore;
  readonly measure: TranscriptStretchMeasure;
  /** How many rows the feed draws now; a run or a person folding lowers it. */
  readonly drawnRowCount: number;
}

/**
 * Keeps the rows above the screen loaded: once per placed window it reads around the opening
 * screen, and afterward it reads backward again whenever the held rows may have shrunk below about
 * two screen heights above the screen. Never reads on its own while the last read past the head
 * failed, since `Try again` is the person's to press.
 */
export function useHistoryLookAhead(inputs: HistoryLookAheadInputs): void {
  const { sessionStore, measure, drawnRowCount } = inputs;
  const readStretch = inputs.history?.readStretch;
  const isReadingEarlier = inputs.history?.state.earlier.isReading ?? false;
  const hasEarlierFailed = inputs.history?.state.earlier.hasFailed ?? false;
  const windowPlacementCount = useSessionStore(sessionStore, readWindowPlacementCount);
  const headCursor = useSessionStore(sessionStore, readHeadCursor);
  const headHasMore = useSessionStore(sessionStore, readHeadHasMore);
  const lastSeen = useRef<LookAheadSighting | undefined>(undefined);
  useEffect(() => {
    if (windowPlacementCount === 0 || readStretch === undefined) {
      return;
    }
    const previous = lastSeen.current;
    const sighting: LookAheadSighting = {
      sessionStore,
      windowPlacementCount,
      drawnRowCount,
      headCursor,
      headHasMore,
      isReadingEarlier,
      measure,
    };
    lastSeen.current = sighting;
    if (
      previous?.sessionStore !== sessionStore ||
      previous.windowPlacementCount !== windowPlacementCount
    ) {
      lookAheadOnPlacedWindow(sessionStore, measure, readStretch);
      return;
    }
    // A read under way is checked again when it ends, as `isReadingEarlier` turns false.
    if (
      !mayHaveShrunk(previous, sighting) ||
      isReadingEarlier ||
      hasEarlierFailed ||
      !headHasMore
    ) {
      return;
    }
    readOwedHead(sessionStore, measure, readStretch);
  }, [
    windowPlacementCount,
    readStretch,
    measure,
    sessionStore,
    drawnRowCount,
    headCursor,
    headHasMore,
    isReadingEarlier,
    hasEarlierFailed,
  ]);
}

/** What the look-ahead last saw of a window, to tell a shrink from a mere append. */
interface LookAheadSighting {
  readonly sessionStore: SessionStore;
  /** The read that placed the window the look-ahead last ran on. */
  readonly windowPlacementCount: number;
  readonly drawnRowCount: number;
  readonly headCursor: EventCursor | undefined;
  readonly headHasMore: boolean;
  readonly isReadingEarlier: boolean;
  readonly measure: TranscriptStretchMeasure;
}

/** A newly placed window: a detached tail reads forward, otherwise the head reads what it owes. */
function lookAheadOnPlacedWindow(
  sessionStore: SessionStore,
  measure: TranscriptStretchMeasure,
  readStretch: TranscriptHistory["readStretch"],
): void {
  if (sessionStore.snapshot().transcriptTail.following === "detached") {
    readStretch("tail");
    return;
  }
  readOwedHead(sessionStore, measure, readStretch);
}

/** Reads backward for whatever height the held rows fall short of the screen and two above it. */
function readOwedHead(
  sessionStore: SessionStore,
  measure: TranscriptStretchMeasure,
  readStretch: TranscriptHistory["readStretch"],
): void {
  // The newest rows fill the screen the reader opens on; the rest of what is held sits above.
  const owedHeightPx =
    (TRANSCRIPT_APPROACH_SCREEN_HEIGHTS + 1) * measure.screenHeightPx() -
    measure.pageHeightPx(sessionStore.snapshot().transcript);
  if (owedHeightPx > 0) {
    readStretch("head", owedHeightPx);
  }
}

/** Whether the held rows may have shrunk since the last sighting; never for an append alone. */
function mayHaveShrunk(previous: LookAheadSighting, current: LookAheadSighting): boolean {
  return (
    current.drawnRowCount < previous.drawnRowCount ||
    current.headCursor !== previous.headCursor ||
    current.headHasMore !== previous.headHasMore ||
    (previous.isReadingEarlier && !current.isReadingEarlier) ||
    current.measure !== previous.measure
  );
}

function readWindowPlacementCount(state: SessionStoreState): number {
  return state.windowPlacementCount;
}

function readHeadCursor(state: SessionStoreState): EventCursor | undefined {
  return state.transcriptHead.cursor;
}

function readHeadHasMore(state: SessionStoreState): boolean {
  return state.transcriptHead.hasMore;
}
