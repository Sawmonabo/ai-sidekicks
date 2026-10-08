// After the viewport's window lets rows go, the store lets go of the events no held row is drawn
// from, so the window's memory stays flat however long the session runs. A return reads them again
// through the history reader, as any stretch past an edge of the store's window.

import { useEffect, useRef } from "react";

import { type SessionStore } from "#renderer/store/session/store.js";
import { type ViewportSnapshot } from "../../viewport/snapshot.js";
import { type PruneOutcome } from "../../viewport/window-cap.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { keptEventCursors } from "../kept-events.js";
import { type TranscriptHistory } from "./useTranscriptHistory.js";

/** The store whose events go, the window that let rows go, and what its rows are drawn from. */
export interface ReleaseOutsideWindowInputs {
  /** The reader a return reads the events again through; with none, nothing is let go. */
  readonly history: TranscriptHistory | undefined;
  readonly sessionStore: SessionStore;
  readonly snapshot: ViewportSnapshot;
  /** Every row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  /** The window the viewport draws: folded by run group, holding only rows the feed draws. */
  readonly transcriptWindow: TranscriptWindowModel;
}

/** Lets the store go of the events outside the window once per pass that let rows go. */
export function useReleaseOutsideWindow(inputs: ReleaseOutsideWindowInputs): void {
  const { sessionStore, unfurledWindow, transcriptWindow } = inputs;
  const canReadAgain = inputs.history !== undefined;
  const { lastPrune, rows } = inputs.snapshot;
  const releasedAfter = useRef<PruneOutcome | undefined>(undefined);
  useEffect(() => {
    if (
      !canReadAgain ||
      lastPrune === undefined ||
      !lastPrune.applied ||
      releasedAfter.current === lastPrune
    ) {
      return;
    }
    releasedAfter.current = lastPrune;
    const kept = keptEventCursors(lastPrune, rows, {
      unfurledWindow,
      transcriptWindow,
      log: sessionStore.snapshot().transcript,
    });
    if (kept !== undefined) {
      sessionStore.releaseOutside(kept.firstKeptCursor, kept.lastKeptCursor);
    }
  }, [canReadAgain, sessionStore, lastPrune, rows, unfurledWindow, transcriptWindow]);
}
