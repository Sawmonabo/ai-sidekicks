// The React side of the history reader: one reader per session and bridge, its state read as an
// external store that changes when the reader or a store edge moves, the one act every trigger
// asks a stretch through: `Load earlier` and `Try again`, the viewport's approach to an edge, a
// link reaching back for its message and the look-ahead that keeps rows loaded above the screen;
// the jump Home and End read an end of the log through; and the page a long run's window reads
// back inside the store's window before it opens onto calls the store let go.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "#renderer/lib/subject-scoped/disposal.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { useBridgeClock } from "#renderer/services/platform/hooks/useClock.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { type ReleasedEventStretch } from "#renderer/store/session/state.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type ReleasedStretchReadDirection } from "#renderer/store/session/transcript-window.js";
import { type JumpToLogEnd } from "../../viewport/conversation-edge-jump.js";
import { type WindowSide } from "../../viewport/window-side.js";
import { queueTaskIn } from "#renderer/lib/queued-task.js";
import {
  TranscriptHistoryReader,
  type TranscriptHistoryState,
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
  /**
   * Asks for a page inside a stretch the store let go between two events it holds, `direction`
   * from the event that bounds it; answers whether the read started.
   */
  readonly readReleasedStretch: (
    stretch: ReleasedEventStretch,
    direction: ReleasedStretchReadDirection,
  ) => boolean;
  /**
   * Starts reading the page at one end of the log in place of the held window, calling
   * `beforePageLands` just before it takes the window's place; answers whether it started, not
   * when the store holds that end already.
   */
  readonly jumpTo: JumpToLogEnd;
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
  // The clock moves with the bridge, as the reader does.
  const clock = useBridgeClock();
  const ownerWindow = useOwnerWindow();
  const held = useSubjectScopedResource(
    bridge,
    sessionStore.sessionId,
    () =>
      new TranscriptHistoryReader(sessionStore, clock, (task) => {
        queueTaskIn(ownerWindow, task);
      }),
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
            readReleasedStretch: (
              stretch: ReleasedEventStretch,
              direction: ReleasedStretchReadDirection,
            ) => reader.readReleasedStretch(stretch, direction, readPage),
            jumpTo: (side: WindowSide, beforePageLands: () => void) =>
              reader.jumpTo(side, readPage, beforePageLands),
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
