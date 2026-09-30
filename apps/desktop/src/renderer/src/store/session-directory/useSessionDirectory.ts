// The node's session directory, read for as long as a caller is mounted. The state is scoped to
// the call: a replaced call re-seeds it to `reading`, and an answer from the old call writes
// nowhere.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  sessionDirectoryStaleness,
  type SessionDirectoryEntry,
  type SessionDirectoryReadCall,
  type SessionDirectoryState,
} from "./session-directory.js";
import { NO_TRIGGERING_EVENT_KINDS, type ReadTriggerTarget } from "../reads/read-triggers.js";
import { useWindowReadTriggers } from "../reads/hooks/useWindowReadTriggers.js";
import { useSubjectRead, type SubjectReadProjection } from "@renderer/hooks/useSubjectRead.js";
import { type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import type { TransportReconnectObservable } from "@renderer/lib/transport-reconnect.js";

/** `reading` until the node answers, then the sessions it listed. */
const SESSION_DIRECTORY_PROJECTION: SubjectReadProjection<
  readonly SessionDirectoryEntry[],
  SessionDirectoryState
> = {
  unsettled: () => ({ status: "reading" }),
  settled: (sessions) => ({ status: "served", sessions }),
};

/**
 * Read the node's session directory for as long as the caller is mounted.
 *
 * A re-render never re-reads; a replaced call does. A stale revision re-reads over the same
 * address, so the answer on screen stays until the new one lands. Only the window triggers
 * apply, since no one session's repair bears on the node's list. A rejected call is not
 * caught: it surfaces as an unhandled rejection and the state stays `reading`.
 */
export function useSessionDirectory(
  read: SessionDirectoryReadCall,
  transportReconnect: TransportReconnectObservable,
): SessionDirectoryState {
  const watchDirectoryRevision = useCallback(
    (wake: () => void) => sessionDirectoryStaleness.watch(read, wake),
    [read],
  );
  const readDirectoryRevision = useCallback(
    () => sessionDirectoryStaleness.revisionFor(read),
    [read],
  );
  // A number, so an unmoved revision re-renders nothing.
  const directoryRevision = useSyncExternalStore(
    watchDirectoryRevision,
    readDirectoryRevision,
    readDirectoryRevision,
  );
  const { value: state } = useSubjectRead(
    read,
    undefined,
    (_key, signal) => read(signal),
    SESSION_DIRECTORY_PROJECTION,
    directoryRevision,
  );
  useWindowReadTriggers(
    useMemo<ReadTriggerTarget>(
      () => ({
        triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
        requestRead: (reason: RefreshReason): void => {
          // The subject read above already covers `subscribe`; routing it here would double it.
          if (reason === "subscribe") {
            return;
          }
          sessionDirectoryStaleness.declareStale(read);
        },
      }),
      [read],
    ),
    transportReconnect,
  );
  return state;
}
