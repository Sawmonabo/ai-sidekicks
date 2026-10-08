// The React side of the history reader: one reader per session and bridge, its state read as an
// external store that changes when the reader or a store edge moves, and the one act every
// trigger asks it through: `Load earlier` and `Try again`, the viewport's approach to an edge, a
// link reaching back for its message and the opening look-ahead.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "#renderer/lib/subject-scoped/disposal.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type WindowSide } from "../../viewport/window-cap.js";
import {
  TranscriptHistoryReader,
  type TranscriptHistoryState,
  type TranscriptPageRead,
  type TranscriptStretchMeasure,
} from "../reader.js";

/** What the transcript renders about its history, and how it asks for more. */
export interface TranscriptHistory {
  readonly state: TranscriptHistoryState;
  /**
   * Asks for the stretch past one edge, about `owedHeightPx` of rows or a stretch when not
   * given; answers whether that edge has more to read. A failed read past it is sent again.
   */
  readonly readStretch: (side: WindowSide, owedHeightPx?: number) => boolean;
  /** Hands the reader the viewport a stretch is measured in, or takes it back. */
  readonly measureWith: (measure: TranscriptStretchMeasure | undefined) => void;
}

/**
 * Binds one session's history reader to a React tree, or answers `undefined` for a composition
 * with no page read, which has no history to offer.
 */
export function useTranscriptHistory(
  sessionStore: SessionStore,
  readPage: TranscriptPageRead | undefined,
): TranscriptHistory | undefined {
  const bridge = usePlatformBridge();
  const held = useSubjectScopedResource(
    bridge,
    sessionStore.sessionId,
    () => new TranscriptHistoryReader(sessionStore),
    TRANSCRIPT_HISTORY_READER_DISPOSAL,
  );
  const reader = held.value;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribeReader = reader.subscribe(onChange);
      const unsubscribeStore = sessionStore.readable.subscribe(onChange);
      return () => {
        unsubscribeReader();
        unsubscribeStore();
      };
    },
    [reader, sessionStore],
  );
  const state = useSyncExternalStore(subscribe, () => reader.state());
  // Its own identity for the reader's life, so the measure is not handed over again per state.
  const measureWith = useCallback(
    (measure: TranscriptStretchMeasure | undefined) => {
      reader.measureWith(measure);
    },
    [reader],
  );
  return useMemo(
    () =>
      readPage === undefined
        ? undefined
        : {
            state,
            readStretch: (side: WindowSide, owedHeightPx?: number) =>
              reader.readStretch(side, readPage, owedHeightPx),
            measureWith,
          },
    [readPage, reader, state, measureWith],
  );
}

/**
 * How a reader ends. Terminal, not releasing: a reader holds a read line, and one that was let go
 * cannot be reused, so React's double mount recognizes it and mints a fresh one.
 */
const TRANSCRIPT_HISTORY_READER_DISPOSAL: SubjectScopedDisposal<TranscriptHistoryReader> = {
  dispose: (reader: TranscriptHistoryReader): void => {
    reader.abandonReads();
  },
  isClosed: (reader: TranscriptHistoryReader): boolean => reader.isAbandoned,
};
