// The Runtime page's status reading, held for the page and asked again when it can have moved.
//
// The supervisor state is not read here. It arrives on the page's own context, from the one
// subscription the frame keeps live, so the page never gives a second answer to "is the runtime
// up". What is read here is what that subscription does not carry: the service's own reported
// line, its version, and what it is using of the machine.
//
// What stales that reading is declared here as a thing that happened, never a clock: a
// supervisor transition, a control this page dispatched settling, or the person pressing
// `Check again`. Each goes to the reading's own `requestRead`. Nothing polls.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import type { RefreshReason } from "#renderer/lib/reads/refresh/refresh-scheduler.js";
import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { DaemonConnection } from "#shared/daemon/status-topic.js";
import {
  DaemonStatusRead,
  type DaemonOperations,
  type DaemonStatusReading,
} from "../daemon-status-read.js";

/**
 * What makes the service's own answer stale, besides a person asking again.
 *
 * Two members, each a thing that happened. A control this page dispatched is the one change the
 * page caused; a supervisor transition is every change it did not.
 */
export interface DaemonStatusFreshness {
  /** What the supervisor is reporting about the runtime right now. */
  readonly connection: DaemonConnection;
  /** How many of this page's controls have settled. `DaemonControlDispatch`'s own. */
  readonly settledControlCount: number;
}

/** The status reading on screen, and the `Check again` that asks it once more. */
export interface DaemonStatusView {
  readonly reading: DaemonStatusReading;
  readonly checkAgain: () => void;
}

/** The key the page's one status reading is held under. */
const DAEMON_STATUS_KEY = "daemon-status";

/**
 * Read the service's own status when the page opens, and again when `freshness` moves or the
 * person presses `Check again`.
 *
 * The connection's kind and never the whole connection: `transient_disconnect` carries an
 * attempt number and the healthy path a heartbeat timestamp, and asking on either would put a
 * read on the wire per attempt and per beat.
 */
export function useDaemonStatus(
  freshness: DaemonStatusFreshness,
  operations: DaemonOperations,
): DaemonStatusView {
  const clock = useClock();
  const { value: statusRead } = useSubjectScopedResource(
    operations,
    DAEMON_STATUS_KEY,
    () => new DaemonStatusRead(operations.readStatus, clock),
    CONTROLLER_DISPOSAL,
  );
  const subscribe = useCallback(
    (onChange: () => void) => statusRead.subscribe(onChange),
    [statusRead],
  );
  const readSnapshot = useCallback(() => statusRead.reading, [statusRead]);
  const reading = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

  const connectionKind = freshness.connection.kind;
  const { settledControlCount } = freshness;
  // What the last ask answered, so each ask names the thing that happened.
  const askedFor = useRef<AskedFor | undefined>(undefined);
  useEffect(() => {
    const previous = askedFor.current;
    askedFor.current = { statusRead, connectionKind, settledControlCount };
    statusRead.requestRead(reasonFor(previous, askedFor.current));
  }, [statusRead, connectionKind, settledControlCount]);

  const checkAgain = useCallback(() => {
    statusRead.requestRead("user-request");
  }, [statusRead]);
  return { reading, checkAgain };
}

/** What one ask was made against. */
interface AskedFor {
  readonly statusRead: DaemonStatusRead;
  readonly connectionKind: DaemonConnection["kind"];
  readonly settledControlCount: number;
}

/**
 * Why the reading is asked again: it opened, the supervisor moved, or a control the person
 * confirmed settled, which is their own act asking what the service now says.
 */
function reasonFor(previous: AskedFor | undefined, current: AskedFor): RefreshReason {
  if (previous === undefined || previous.statusRead !== current.statusRead) {
    return "subscribe";
  }
  return previous.connectionKind === current.connectionKind ? "user-request" : "reconnect";
}
