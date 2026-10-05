// The Runtime page's status read: a read that must not be answered by a stale reply.
//
// The supervisor state is not read here. It arrives on the page's own context, from the
// one subscription the frame keeps live, so the page never gives a second answer to "is
// the runtime up". What is read here is the one fact that subscription does not carry:
// the daemon's own reported status line and version.
//
// That reading goes stale, and what stales it is declared here as a thing that happened
// rather than a clock: a control this page dispatched, or a supervisor transition. The
// read is re-put by re-addressing it, which the subject holder already does: the answer
// re-seeds to `reading` and a reply to the old subject is dropped. Nothing polls.

import { useEffect } from "react";

import type { DaemonStatusReadResponse } from "@ai-sidekicks/contracts/daemon-status";
import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { DaemonConnection } from "@shared/daemon-status-topic.js";

/**
 * The daemon verbs this page drives.
 */
export interface DaemonOperations {
  readonly readStatus: () => Promise<DaemonStatusReadResponse>;
  readonly stop: () => Promise<unknown>;
  readonly restart: () => Promise<unknown>;
}

/**
 * The read's three phases. `reading` is the seed; `read` and `failed` are its settlements, the
 * second carrying the refusal the read was answered with.
 */
export type DaemonStatusReading =
  | { readonly phase: "reading" }
  | { readonly phase: "read"; readonly status: DaemonStatusReadResponse }
  | { readonly phase: "failed"; readonly refusal: Refusal };

/**
 * What makes the daemon's own answer stale.
 *
 * Two members, each a thing that happened. A control this page dispatched is the one
 * change the page caused; a supervisor transition is every change it did not.
 */
export interface DaemonStatusFreshness {
  /** What the supervisor is reporting about the runtime right now. */
  readonly connection: DaemonConnection;
  /** How many of this page's controls have settled. `DaemonControlDispatch`'s own. */
  readonly settledControlCount: number;
}

const DAEMON_STATUS_KEY = "daemon-status";

/** The subsystem a failed status read names as its author. */
const DAEMON_STATUS_ORIGIN = "daemon-status";

const READING_DAEMON_STATUS: DaemonStatusReading = { phase: "reading" };

/**
 * Read the daemon's own status line, and read it again when it can have changed.
 *
 * The freshness rides the subject key: the holder re-seeds during the render that first
 * sees a new subject and the read is put again, so no flag beside the state can disagree
 * with which answer is current.
 */
export function useDaemonStatus(
  bridge: PlatformBridge,
  freshness: DaemonStatusFreshness,
  operations: DaemonOperations,
): DaemonStatusReading {
  const { value, publish } = useSubjectScopedState<DaemonStatusReading>(
    bridge,
    daemonStatusSubject(freshness),
    () => READING_DAEMON_STATUS,
  );
  useEffect(() => {
    void operations.readStatus().then(
      (status) => {
        publish({ phase: "read", status });
      },
      (error: unknown) => {
        publish({ phase: "failed", refusal: coerceToRefusal(error, DAEMON_STATUS_ORIGIN) });
      },
    );
  }, [operations, publish]);
  return value;
}

/**
 * The subject one status answer belongs to.
 *
 * The connection's kind and never the whole connection: `transient_disconnect` carries an
 * attempt number and the healthy path a heartbeat timestamp, and keying on either would
 * put a read on the wire per attempt and per beat.
 */
function daemonStatusSubject(freshness: DaemonStatusFreshness): string {
  return `${DAEMON_STATUS_KEY}:${freshness.connection.kind}:${freshness.settledControlCount}`;
}
