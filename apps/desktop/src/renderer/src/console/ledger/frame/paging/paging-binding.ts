// The React side of the backward walk: one reader per session, and the act a control
// presses.
//
// `earlier-window-reader.ts` holds the policy — where the next page starts, whether
// one is in flight, whether the producer said any remain — and this module holds the
// three things React has to supply for it: a holder whose lifetime is the session's, a
// reason to re-render when the answer moves, and a callback that does not change
// identity on every render of the feed.
//
// THE HOLDER IS SESSION-SCOPED, NOT MOUNT-SCOPED, for `useChildRunDisclosure`'s
// reason: this console holds session stores open across a navigation, so a walk held
// by the mount would carry one session's position into the next session's ledger. The
// subject is the bridge as well as the session id, because a bridge replacement — a
// reconnect, a second window's own instance, the fixture's scenario switch — retires
// every call in flight through it.
//
// AND IT IS A RESOURCE RATHER THAN A VALUE, which is the half a plain holder cannot
// serve: the reader owns a read line, and a line has an ENDING. Held as a value, a
// walk whose pane left went on decoding a page nobody would ever see and then grew a
// log the console had moved off; held through `useSubjectScopedResource`, the same
// re-address that mints the next walk abandons this one's line.
//
// AND THE STATE IS DERIVED, NEVER MIRRORED. The reader answers from its own fields and
// the store's, so there is nothing here to keep in step: the memo below re-asks
// whenever either could have moved. A published mirror would be a second copy of a
// verdict whose whole point is that it is the producer's.

import { useCallback, useMemo, useState } from "react";

import { useConsoleBridge } from "../../../bridge/index.js";
import {
  useSessionStore,
  useSubjectScopedResource,
  type SessionStore,
  type SubjectScopedDisposal,
} from "../../../store/index.js";
import {
  LedgerEarlierWindowReader,
  type LedgerEarlierWindowState,
} from "./earlier-window-reader.js";

/** What the head control renders, and the one act it performs. */
export interface LedgerEarlierPaging extends LedgerEarlierWindowState {
  /**
   * Ask for one page of rows before this window's head.
   *
   * Returns nothing and never rejects: the outcome is the next state, which is what
   * the control is already rendering. A press while a page is in flight, or with
   * nothing left to read, is dropped by the reader rather than guarded here — one
   * place decides whether a walk may advance.
   */
  readonly loadEarlier: () => void;
}

/**
 * How a walk ends, stated once so the render below hands over a stable pair.
 *
 * TERMINAL RATHER THAN RELEASING, because a reader holds a read line and a line that
 * was let go of is not a line that can be handed to the next render: the session this
 * walk was addressed at is gone, its outstanding page belongs to nobody, and a page
 * landing afterwards must not grow a log the console has moved off. `isClosed` is what
 * makes React's double-mount survivable — the disposed reader is recognised and a
 * fresh one minted, rather than the pane spending its life pressing a control on a
 * line that can never open a live round again.
 */
const EARLIER_WINDOW_READER_DISPOSAL: SubjectScopedDisposal<LedgerEarlierWindowReader> = {
  dispose: (reader: LedgerEarlierWindowReader): void => {
    reader.abandonReads();
  },
  isClosed: (reader: LedgerEarlierWindowReader): boolean => reader.isAbandoned,
};

/**
 * Bind one session's backward walk to a React tree.
 *
 * The store is the subject rather than a parameter of the act, because the walk's base
 * is the store's window head and its rows land in the store's own log — a hook that
 * took a store per call could be handed two.
 */
export function useLedgerEarlierPaging(sessionStore: SessionStore): LedgerEarlierPaging {
  const bridge = useConsoleBridge();
  const held = useSubjectScopedResource(
    bridge,
    sessionStore.sessionId,
    () => new LedgerEarlierWindowReader(),
    EARLIER_WINDOW_READER_DISPOSAL,
  );
  const reader = held.value;
  // A settled read changes the reader's fields and nothing React watches, so the
  // settlement is what says so. A counter rather than a copy of the state: the state
  // is re-derived below from the reader itself, and a mirror would be the second
  // answer this module's header refuses.
  const [settlements, setSettlements] = useState(0);
  // The two store facts the walk's base is read from. `revision` covers the second
  // signal `#rebaseIfWindowMoved` reads — a re-pull that re-established the same head
  // and dropped the rows a walk had put in front of it moves this and moves no cursor.
  const windowHeadCursor = useSessionStore(sessionStore, readWindowHeadCursor);
  const revision = useSessionStore(sessionStore, readRevision);
  const state = useMemo(() => {
    // Named so the dependency list is honest about what it is watching for: neither
    // value is read here, and both are the reason this is re-asked.
    void windowHeadCursor;
    void revision;
    void settlements;
    return reader.state(sessionStore);
  }, [reader, sessionStore, windowHeadCursor, revision, settlements]);
  const loadEarlier = useCallback(() => {
    const settle = (): void => {
      setSettlements((current) => current + 1);
    };
    // Marked settled before the call as well as after it, so the in-flight state the
    // control renders is reachable: the reader raises its own flag synchronously and
    // nothing else would tell React it had.
    settle();
    void reader.loadEarlier(bridge, sessionStore).then(settle, settle);
  }, [bridge, reader, sessionStore]);
  return useMemo(() => ({ ...state, loadEarlier }), [state, loadEarlier]);
}

/** Stable selectors, so the subscription does not re-subscribe every render. */
function readWindowHeadCursor(state: {
  readonly windowHeadCursor: string | undefined;
}): string | undefined {
  return state.windowHeadCursor;
}

function readRevision(state: { readonly revision: number }): number {
  return state.revision;
}
