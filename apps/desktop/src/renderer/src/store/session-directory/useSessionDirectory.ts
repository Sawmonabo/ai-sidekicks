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
 * Read the node's session directory, for as long as the caller is mounted.
 *
 * The effect is keyed on the call, so a re-render never re-reads and a replaced call
 * does. THE REVISION IS NOT THE SUBJECT: a stale directory re-reads over the SAME
 * address, so the answer already on screen stays there until the new one lands.
 *
 * THE WINDOW HALF OF THE TRIGGER SET AND NOT THE SESSION HALF, on the rule
 * `store/read/read-triggers.ts` states: this read is addressed at the NODE, so no one
 * session's repair and no one session's timeline bear on it. The transport signal is
 * the caller's because it is the BRIDGE's.
 *
 * A rejected call is not caught here: the effect discards the promise, so the rejection
 * reaches the host as an unhandled rejection and the state stays `reading`.
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
  // A number, so `useSyncExternalStore` compares it by value and a call whose revision
  // has not moved re-renders nothing at all.
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
          // `subscribe` is the read the subject read above already put on this mount.
          // Routing it into the revision would put a second call on the wire for one
          // arrival.
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
