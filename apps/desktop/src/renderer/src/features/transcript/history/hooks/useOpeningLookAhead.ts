// The opening look-ahead: once the session's first read has landed, the reader reads backward until
// about two screen heights of rows sit above the screen it opened on. It runs in an effect, after
// the first paint, so a session paints first no later than it would without it.

import { useEffect, useRef } from "react";

import { type SessionStore } from "#renderer/store/session/store.js";
import { TRANSCRIPT_APPROACH_SCREEN_HEIGHTS } from "../../viewport/caps.js";
import { type TranscriptStretchMeasure } from "../reader.js";
import { type TranscriptHistory } from "./useTranscriptHistory.js";

/** The reader that looks ahead, the store it reads into, and the viewport it measures in. */
export interface OpeningLookAheadInputs {
  readonly history: TranscriptHistory | undefined;
  readonly sessionStore: SessionStore;
  readonly measure: TranscriptStretchMeasure;
  /** Whether the session's first read has landed, which the look-ahead waits for. */
  readonly isFirstReadSettled: boolean;
}

/**
 * Asks once per mount for the rows above the opening screen. Two screen heights is the approach
 * distance, so the reader opens just outside it and the first scroll toward the top asks for more.
 */
export function useOpeningLookAhead(inputs: OpeningLookAheadInputs): void {
  const { sessionStore, measure, isFirstReadSettled } = inputs;
  const readStretch = inputs.history?.readStretch;
  const hasLookedAhead = useRef(false);
  useEffect(() => {
    if (!isFirstReadSettled || readStretch === undefined || hasLookedAhead.current) {
      return;
    }
    hasLookedAhead.current = true;
    // The newest rows fill the screen the reader opens on; the rest of what was read sits above.
    const owedHeightPx =
      (TRANSCRIPT_APPROACH_SCREEN_HEIGHTS + 1) * measure.screenHeightPx() -
      measure.pageHeightPx(sessionStore.snapshot().transcript);
    if (owedHeightPx > 0) {
      readStretch("head", owedHeightPx);
    }
  }, [isFirstReadSettled, readStretch, measure, sessionStore]);
}
