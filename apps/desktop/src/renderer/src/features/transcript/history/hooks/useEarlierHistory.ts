// The React side of the backward walk: one reader per session, and the act a control presses.
// Held per session and bridge, not per mount: session stores stay open across navigation, and
// a bridge replacement retires every call in flight. It is a resource, so re-addressing
// abandons the old walk's read line. The state is the reader's own, read as an external store
// that changes when the walk moves or the store's window does.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import {
  EarlierHistoryReader,
  type EarlierHistoryState,
  type EarlierPageRead,
} from "../earlier-history-reader.js";

/** What the head control renders, and the one act it performs. */
export interface EarlierHistoryPaging extends EarlierHistoryState {
  /**
   * Asks for one page of rows before this window's head.
   *
   * Never rejects; the outcome is the next state. A press while a page is in flight or with
   * nothing left is dropped by the reader.
   */
  readonly loadEarlier: () => void;
}

/**
 * How a walk ends. Terminal, not releasing: a reader holds a read line, and one that was let
 * go cannot be reused. `isClosed` makes React's double-mount survivable: the disposed reader
 * is recognized and a fresh one minted.
 */
const EARLIER_WINDOW_READER_DISPOSAL: SubjectScopedDisposal<EarlierHistoryReader> = {
  dispose: (reader: EarlierHistoryReader): void => {
    reader.abandonReads();
  },
  isClosed: (reader: EarlierHistoryReader): boolean => reader.isAbandoned,
};

/**
 * Binds one session's backward walk to a React tree.
 *
 * The store is the subject, not a per-call parameter, because the walk's base and its rows
 * both belong to one store.
 */
export function useEarlierHistory(
  sessionStore: SessionStore,
  readEarlierPage: EarlierPageRead,
): EarlierHistoryPaging {
  const bridge = usePlatformBridge();
  const held = useSubjectScopedResource(
    bridge,
    sessionStore.sessionId,
    () => new EarlierHistoryReader(),
    EARLIER_WINDOW_READER_DISPOSAL,
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
  const state = useSyncExternalStore(subscribe, () => reader.state(sessionStore));
  const loadEarlier = useCallback(() => {
    void reader.loadEarlier(readEarlierPage, sessionStore);
  }, [readEarlierPage, reader, sessionStore]);
  return useMemo(() => ({ ...state, loadEarlier }), [state, loadEarlier]);
}
