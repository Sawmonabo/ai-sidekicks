// The service's session directory, read for as long as a caller is mounted. The state is scoped to
// the call: a replaced call re-seeds it to `reading`, and an answer from the old call writes
// nowhere. A rejected read settles `failed` and records its cause, so the list never reads
// `reading` forever.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  sessionDirectoryStaleness,
  type SessionDirectoryReadCall,
  type SessionDirectoryState,
} from "./session-directory.js";
import { NO_TRIGGERING_EVENT_KINDS, type ReadTriggerTarget } from "../reads/triggers.js";
import { useWindowReadTriggers } from "../reads/hooks/useWindowReadTriggers.js";
import { useSubjectRead, type SubjectReadProjection } from "#renderer/hooks/useSubjectRead.js";
import { type RefreshReason } from "#renderer/lib/reads/refresh/refresh-scheduler.js";
import type { TransportReconnectObservable } from "#renderer/lib/transport-reconnect.js";
import { RealClock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { isReadAbandoned } from "#renderer/lib/reads/read-scope.js";
import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";

/** `reading` until the service answers, then what the read settled as. */
const SESSION_DIRECTORY_PROJECTION: SubjectReadProjection<
  SessionDirectoryState,
  SessionDirectoryState
> = {
  unsettled: () => ({ status: "reading" }),
  settled: (state) => state,
};

/**
 * Read the service's session directory for as long as the caller is mounted.
 *
 * A re-render never re-reads; a replaced call does. A stale revision re-reads over the same
 * address, so the answer on screen stays until the new one lands. Only the window triggers
 * apply, since no one session's repair bears on the service's list.
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
    (_key, signal) => readDirectoryOnce(read, signal),
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

/** Read the directory once, settling a rejection as `failed` with its cause recorded. */
async function readDirectoryOnce(
  read: SessionDirectoryReadCall,
  signal: AbortSignal,
): Promise<SessionDirectoryState> {
  try {
    return { status: "served", sessions: await read(signal) };
  } catch (error: unknown) {
    // An abandoned read's rejection is the abandonment itself, not a failure of the list.
    if (!isReadAbandoned(signal)) {
      const refusal = normalizeWireRejection("session-directory", error);
      windowDiagnosticCapture.record({
        at: diagnosticStampAt(new RealClock()),
        severity: "warning",
        source: "store/session-directory",
        kind: "directory-read-failed",
        detail: `${refusal.code}: ${refusal.detail}`,
      });
    }
    return { status: "failed" };
  }
}
