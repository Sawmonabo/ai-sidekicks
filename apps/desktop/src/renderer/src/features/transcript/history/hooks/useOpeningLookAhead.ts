// The opening look-ahead: once a read has placed the session's window, the reader fills around the
// screen it opens on. A tail let go while the session was off screen is read forward from the kept
// edge; otherwise the reader reads backward until about two screen heights of rows sit above the
// screen. It runs in an effect, after the first paint, so a session paints first no later than it
// would without it, once per mount and again for each window a later read places.

import { useEffect, useRef } from "react";

import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { TRANSCRIPT_APPROACH_SCREEN_HEIGHTS } from "../../viewport/caps.js";
import { type TranscriptStretchMeasure } from "../reader.js";
import { type TranscriptHistory } from "./useTranscriptHistory.js";

/** The reader that looks ahead, the store it reads into, and the viewport it measures in. */
export interface OpeningLookAheadInputs {
  readonly history: TranscriptHistory | undefined;
  readonly sessionStore: SessionStore;
  readonly measure: TranscriptStretchMeasure;
}

/**
 * Asks once per placed window for the rows around the opening screen, so a snapshot that replaced
 * the window looks ahead from the new one. Two screen heights is the approach distance, so the
 * reader opens just outside it and the first scroll toward the top asks for more.
 */
export function useOpeningLookAhead(inputs: OpeningLookAheadInputs): void {
  const { sessionStore, measure } = inputs;
  const readStretch = inputs.history?.readStretch;
  const windowPlacementCount = useSessionStore(sessionStore, readWindowPlacementCount);
  const lookedAheadOn = useRef<LookedAheadWindow | undefined>(undefined);
  useEffect(() => {
    const looked = lookedAheadOn.current;
    const hasLookedAhead =
      looked?.sessionStore === sessionStore && looked.windowPlacementCount === windowPlacementCount;
    if (windowPlacementCount === 0 || readStretch === undefined || hasLookedAhead) {
      return;
    }
    lookedAheadOn.current = { sessionStore, windowPlacementCount };
    const { transcript, transcriptTail } = sessionStore.snapshot();
    if (transcriptTail.following === "detached") {
      readStretch("tail");
      return;
    }
    // The newest rows fill the screen the reader opens on; the rest of what was read sits above.
    const owedHeightPx =
      (TRANSCRIPT_APPROACH_SCREEN_HEIGHTS + 1) * measure.screenHeightPx() -
      measure.pageHeightPx(transcript);
    if (owedHeightPx > 0) {
      readStretch("head", owedHeightPx);
    }
  }, [windowPlacementCount, readStretch, measure, sessionStore]);
}

/** The window a look-ahead last ran on: its session's store and the read that placed it. */
interface LookedAheadWindow {
  readonly sessionStore: SessionStore;
  readonly windowPlacementCount: number;
}

function readWindowPlacementCount(state: SessionStoreState): number {
  return state.windowPlacementCount;
}
