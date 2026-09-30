// What a window makes of the supervisor's `daemon.status` topic: the state it holds before
// main's first delivery, the comparison that keeps an unchanged delivery from re-rendering,
// and the words a connection state reads as.
//
// The topic's vocabulary is `@shared/daemon-status-topic.ts`, which main writes and the
// renderer reads. This module is the renderer's half, and it lives in `store/` because the
// settings pages read it for the supervisor detail and `store/` sits below every feature.
//
// NOTHING HERE READS A CLOCK, A TIMER, OR A WIRE.
//
// THE UNREPORTED ARM IS THE ONE THAT MAKES THIS HONEST. Main does not publish the topic yet,
// so the ordinary state of a shipped window is "nobody has said". That is not `connected`
// and it is not `offline`: a window that synthesized `connected` from a call that happened
// to succeed would be doing exactly what the console's trust stance forbids, and one that
// assumed `offline` would report a working console as down. So the arm exists and it
// renders as the _not checked_ kind of nothing.

import type {
  DaemonConnection,
  MainProcessNegotiation,
  MainProcessState,
  ServiceCannotStart,
} from "@shared/daemon-status-topic.js";

/** What a window holds before anything has reported. The store is born on it. */
export const UNREPORTED_MAIN_PROCESS_STATE: MainProcessState = {
  connection: { kind: "unreported" },
  negotiation: undefined,
  lastHeartbeatAt: undefined,
  transport: undefined,
  keystore: undefined,
  startedByApp: undefined,
  whileSignedOut: undefined,
  cannotStart: undefined,
};

/**
 * Whether two reports say the same thing.
 *
 * The subscription that fills this state answers with a fresh object per frame, so
 * without a comparison every heartbeat would re-render every reader of the state for
 * a value that did not move.
 *
 * Written over the union rather than as a deep equality, so a new arm is a compile error
 * here rather than a silent "always different".
 */
export function mainProcessReportsAreEqual(
  left: MainProcessState,
  right: MainProcessState,
): boolean {
  return (
    left.lastHeartbeatAt === right.lastHeartbeatAt &&
    left.transport === right.transport &&
    left.keystore === right.keystore &&
    left.startedByApp === right.startedByApp &&
    left.whileSignedOut === right.whileSignedOut &&
    cannotStartsAreEqual(left.cannotStart, right.cannotStart) &&
    mainProcessNegotiationsAreEqual(left.negotiation, right.negotiation) &&
    daemonConnectionsAreEqual(left.connection, right.connection)
  );
}

/**
 * One supervisor state in a person's words.
 *
 * HERE RATHER THAN IN `layout/` because the local-runtime settings page renders it
 * and imports point one way, so a sentence declared in `layout/` is one a feature
 * cannot reach without a second spelling of it.
 */
export function describeDaemonConnection(connection: DaemonConnection): string {
  switch (connection.kind) {
    case "unreported":
      return "Local runtime";
    case "probing":
      return "Checking the local runtime";
    case "starting":
      return "Starting the local runtime";
    case "connected":
      return "Local runtime connected";
    case "reconnecting":
      return `Reconnecting — attempt ${String(connection.attempt)} of ${String(connection.attemptLimit)}`;
    case "version-incompatible":
      return "Version mismatch";
    case "offline":
      return "Local runtime offline";
    case "stopped":
      return "Local runtime stopped";
  }
}

function daemonConnectionsAreEqual(left: DaemonConnection, right: DaemonConnection): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "unreported":
    case "probing":
    case "starting":
    case "connected":
    case "stopped":
      return true;
    case "reconnecting":
      return (
        right.kind === "reconnecting" &&
        left.attempt === right.attempt &&
        left.attemptLimit === right.attemptLimit
      );
    case "offline":
      return (
        right.kind === "offline" &&
        left.attemptLimit === right.attemptLimit &&
        left.lastError === right.lastError
      );
    case "version-incompatible":
      return true;
  }
}

/** The handshake's facts, compared member by member. Absent equals absent. */
function mainProcessNegotiationsAreEqual(
  left: MainProcessNegotiation | undefined,
  right: MainProcessNegotiation | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.compatible === right.compatible &&
    left.reason === right.reason &&
    left.behind === right.behind &&
    left.consoleProtocolVersion === right.consoleProtocolVersion &&
    left.daemonProtocolVersion === right.daemonProtocolVersion &&
    left.daemonSupportedProtocols.length === right.daemonSupportedProtocols.length &&
    left.daemonSupportedProtocols.every(
      (version, position) => version === right.daemonSupportedProtocols[position],
    )
  );
}

/** Why the service cannot start, compared reason and error. Absent equals absent. */
function cannotStartsAreEqual(
  left: ServiceCannotStart | undefined,
  right: ServiceCannotStart | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.reason === right.reason &&
    (left.reason !== "restartsExhausted" ||
      (right.reason === "restartsExhausted" && left.error === right.error))
  );
}

/**
 * What a window with no report says about the runtime, in one place.
 *
 * The settings page's state row renders this absence, and it is one fact, so it has one
 * spelling.
 */
export const UNREPORTED_DAEMON_NOTICE: { readonly title: string; readonly detail: string } = {
  title: "Local runtime",
  detail:
    "This build has no channel carrying the supervisor's state, so this window has not been told whether the local runtime is running.",
};
