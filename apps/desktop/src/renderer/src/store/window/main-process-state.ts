// What a window makes of the supervisor's `daemon.status` topic: the state it holds before main's
// first delivery, the comparison that keeps an unchanged delivery from re-rendering, where the
// app's boot stands, and the words a connection state reads as. The topic's vocabulary is
// `#shared/daemon/status-topic.ts`; this half lives in `store/` because the settings pages
// read it and `store/` sits below features.
//
// `unreported` is the state before main's first delivery: not `connected` and not `degraded`,
// since either would be a guess.

import {
  describeDaemonRepairingLine,
  type DaemonRepairProgress,
} from "@ai-sidekicks/contracts/daemon/recovery";

import {
  figurePart,
  joinFigureSentence,
  type FigureSentencePart,
} from "#renderer/lib/figure-sentence.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import {
  NOT_ANSWERING_MESSAGE,
  type DaemonConnection,
  type MainProcessNegotiation,
  type MainProcessState,
  type ServiceCannotStart,
} from "#shared/daemon/status-topic.js";

/**
 * Where the app's first meeting with the service stands: `awaitingAnswer` while main looks for it,
 * starts it, waits out its repair or brings back a link this window never saw up, `notAnswering`
 * once main has given up or the service is gone, and `answered` once a handshake came back.
 */
export type ServiceBootStage = "awaitingAnswer" | "notAnswering" | "answered";

/** What a window holds before anything has reported. The store is born on it. */
export const UNREPORTED_MAIN_PROCESS_STATE: MainProcessState = {
  connection: { kind: "unreported" },
  negotiation: undefined,
  startedByApp: undefined,
  whileSignedOut: undefined,
  cannotStart: undefined,
};

/**
 * Whether two reports say the same thing. The subscription answers with a fresh object per
 * frame, so without a comparison every frame would re-render every reader. Written over the
 * union so a new arm is a compile error rather than a silent "always different".
 */
export function mainProcessReportsAreEqual(
  left: MainProcessState,
  right: MainProcessState,
): boolean {
  return (
    left.startedByApp === right.startedByApp &&
    left.whileSignedOut === right.whileSignedOut &&
    cannotStartsAreEqual(left.cannotStart, right.cannotStart) &&
    mainProcessNegotiationsAreEqual(left.negotiation, right.negotiation) &&
    daemonConnectionsAreEqual(left.connection, right.connection)
  );
}

/**
 * The boot stage a connection state reads as. A handshake answered, refused or not, is the
 * service answering.
 */
export function serviceBootStageOf(connection: DaemonConnection): ServiceBootStage {
  switch (connection.kind) {
    case "unreported":
    case "connecting":
    case "starting":
    case "repairing":
    case "transient_disconnect":
      return "awaitingAnswer";
    case "connected":
    case "version_incompatible":
      return "answered";
    case "unknown":
    case "degraded":
    case "stopped":
      return "notAnswering";
  }
}

/** What a window with no report says about the service, spelled once for the settings state row. */
export const UNREPORTED_DAEMON_NOTICE: { readonly title: string } = {
  title: "Reading the background service…",
};

/**
 * One supervisor state in a person's words. Here rather than in `layout/` because the Runtime
 * settings page renders it and imports point one way.
 */
export function describeDaemonConnection(connection: DaemonConnection): string {
  switch (connection.kind) {
    case "unreported":
      return UNREPORTED_DAEMON_NOTICE.title;
    case "connecting":
      return "Connecting to the background service…";
    case "starting":
      return "Starting the background service…";
    case "repairing":
      return joinFigureSentence(daemonRepairingSentence(connection.progress));
    case "connected":
      return "Running";
    case "transient_disconnect":
      return "Reconnecting…";
    case "version_incompatible":
      return "Version mismatch";
    // A loss main does not recognize reads exactly as one it gave up on, never as running.
    case "unknown":
    case "degraded":
      return NOT_ANSWERING_MESSAGE;
    case "stopped":
      return "Stopped";
  }
}

/**
 * One supervisor state as a sentence whose figures draw through the figure components: the repair
 * line with the service's own count as wire figures, and every other state's words alone.
 */
export function describeDaemonConnectionSentence(
  connection: DaemonConnection,
): readonly FigureSentencePart[] {
  return connection.kind === "repairing"
    ? daemonRepairingSentence(connection.progress)
    : [describeDaemonConnection(connection)];
}

function daemonConnectionsAreEqual(left: DaemonConnection, right: DaemonConnection): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "unreported":
    case "connecting":
    case "starting":
    case "connected":
    case "version_incompatible":
    case "stopped":
      return true;
    case "repairing":
      return (
        right.kind === "repairing" &&
        left.progress?.done === right.progress?.done &&
        left.progress?.total === right.progress?.total
      );
    case "transient_disconnect":
      return (
        right.kind === "transient_disconnect" &&
        left.attempt === right.attempt &&
        left.attemptLimit === right.attemptLimit
      );
    case "unknown":
      return right.kind === "unknown" && left.lastError === right.lastError;
    case "degraded":
      return (
        right.kind === "degraded" &&
        left.attemptLimit === right.attemptLimit &&
        left.lastError === right.lastError
      );
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
    left.deviceId === right.deviceId &&
    left.reason === right.reason &&
    left.behind === right.behind &&
    left.appProtocolVersion === right.appProtocolVersion &&
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

/** The repair line with each count the service sent as a wire figure. */
function daemonRepairingSentence(
  progress: DaemonRepairProgress | undefined,
): readonly FigureSentencePart[] {
  return describeDaemonRepairingLine(progress, (count) => figurePart("wire", formatCount(count)));
}
