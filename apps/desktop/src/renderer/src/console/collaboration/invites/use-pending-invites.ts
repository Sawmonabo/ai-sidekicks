// The mount: one deep-link lifecycle per bridge, and the two triggers that keep its
// channel up.
//
// SEPARATE FROM `pending-invite.ts` for the reason `bridge/queue/queue-feed.ts` is
// separate from the reading it hands out — this decides how long the lifecycle LIVES
// and who wakes it, and that decides what it says. Neither file holds both halves, so
// a suite can drive the whole state machine without rendering and a surface can hold
// it without knowing how a feed re-opens.

import { useCallback, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  useSubjectScopedResource,
  useWindowReadTriggers,
  type SubjectScopedDisposal,
} from "../../store/index.js";
import { PendingInviteAdapter, type PendingInviteSnapshot } from "./pending-invite.js";

/**
 * The adapter's own disposal, as one module-level object.
 *
 * Minted once rather than in a render body, because the resource seam holds `dispose`
 * and `isClosed` on dependencies of their own and a fresh literal each pass would
 * restart the lifetime beneath it.
 */
const PENDING_INVITE_DISPOSAL: SubjectScopedDisposal<PendingInviteAdapter> = {
  dispose: (adapter) => {
    adapter.dispose();
  },
  isClosed: (adapter) => adapter.isDisposed,
};

/**
 * The subject key this lifetime is held under.
 *
 * A CONSTANT, and deliberately not a session id: a deep-link invitation is about a
 * session this window is not in, so keying the feeds by the session on screen would
 * close and reopen them every time a person navigated — and an invitation that
 * arrived during the gap would be re-delivered rather than seen.
 */
const PENDING_INVITE_SUBJECT_KEY = "pending-invites";

/** What a surface holds: the current reading, and the acts it can dispatch. */
export interface PendingInviteBinding {
  readonly snapshot: PendingInviteSnapshot;
  readonly adapter: PendingInviteAdapter;
}

/**
 * Own one lifecycle for as long as this bridge is the window's, and read it.
 *
 * Through the resource seam rather than a `useMemo` and a cleanup: the adapter holds
 * two open feeds, so it is exactly the class of value that seam exists to close
 * exactly once — including under a bridge replaced beneath a live mount.
 *
 * WINDOW TRIGGERS AND NOT SESSION ONES, which is the same claim the empty
 * `triggeringEventKinds` set makes from the other side: an invitation is about a
 * session this window is not in, so no session's timeline and no session's repair
 * bear on it, and tying this reading to whichever session happened to be open would
 * close its channel the moment somebody navigated away.
 */
export function usePendingInvites(bridge: ConsoleBridge): PendingInviteBinding {
  const { value: adapter } = useSubjectScopedResource(
    bridge,
    PENDING_INVITE_SUBJECT_KEY,
    () => new PendingInviteAdapter(bridge),
    PENDING_INVITE_DISPOSAL,
  );
  useWindowReadTriggers(adapter);
  // Held identities, so a render does not tear the subscription down and rebuild it:
  // `useSyncExternalStore` resubscribes whenever `subscribe` changes, and an inline
  // arrow is a fresh function on every pass.
  const subscribe = useCallback(
    (onStoreChange: () => void) => adapter.subscribe(onStoreChange),
    [adapter],
  );
  const read = useCallback(() => adapter.snapshot(), [adapter]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return { snapshot, adapter };
}
