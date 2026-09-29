// What the main process knows about itself.
//
// The console's honest chrome has three facts behind it and they arrive together:
// which step of the daemon supervisor's own state machine this window is on, which
// protocol the handshake settled on, and the two ways an install can be quietly
// weaker than the default (a loopback transport, an unusable OS keystore). One
// value carries all three, because they are one report from one owner — the main
// process — and three slices would be three chances for a window to render a
// connection state from one report beside a keystore state from another.
//
// IT LIVES IN `store/` RATHER THAN IN `layout/`, and the reason is who reads it. The
// settings pages read it for the supervisor detail, and a feature may not import
// `layout/`, which sits above every feature, so a vocabulary declared there is one they
// could not reach. `store/` sits below every feature and holds the window store this
// value is published into.
//
// NOTHING HERE READS A CLOCK, A TIMER, OR A WIRE. This module is the vocabulary and
// the comparison every consumer shares.
//
// THE UNREPORTED ARM IS THE ONE THAT MAKES THIS HONEST. No bridge namespace carries the
// main process's status yet, so the ordinary state of a shipped window is "nobody has said".
// That is not `connected` and it is not `offline`: a window that synthesized
// `connected` from a call that happened to succeed would be doing exactly what the
// console's trust stance forbids, and one that assumed `offline` would report a working
// console as down. So the arm exists and it renders as the _not checked_ kind of nothing.

/**
 * What the handshake settled, as `DaemonHelloAck` carries it.
 *
 * The members are the ack's own (`packages/contracts/src/jsonrpc-negotiation.ts`):
 * whether the daemon called this build compatible, the version it chose, its full
 * supported set where it sent one, and the reason string on the incompatible arm.
 * The console renders them and compares nothing — what it shows is a
 * verdict the daemon reached, and a floor comparison performed here would be the
 * second source of truth the corpus forbids.
 */
export interface MainProcessNegotiation {
  readonly compatible: boolean;
  /** The daemon's chosen protocol version, verbatim. */
  readonly daemonProtocolVersion: string;
  /** The version this build proposed, verbatim. */
  readonly consoleProtocolVersion: string;
  /** The daemon's full supported set, where the refused ack carried one. */
  readonly daemonSupportedProtocols: readonly string[];
  /** The ack's own `reason`, present only on the incompatible arm. */
  readonly reason: string | undefined;
}

/**
 * Where this window stands with its local runtime.
 *
 * THE ONLY ENUMERATION OF THE SUPERVISOR'S STATES. A tuple beside this union would be a
 * second closed set free to disagree with it, and the union is the one a view actually
 * narrows on. The daemon supervision lifecycle numbers six steps and these are its arms:
 * `probing` is step 1's startup probe, `starting` step 2's spawn and ten-second readiness
 * wait, `version-incompatible` step 3, `connected` step 4's live heartbeat,
 * `reconnecting` step 5's backoff ladder, `offline` that ladder's terminal after the
 * fifth failed attempt, and `stopped` step 6's deliberate shutdown — which is not a
 * failure and does not read as one.
 *
 * A discriminated union rather than a state plus optional fields, because the fields
 * are not optional per state: a reconnecting window HAS an attempt and a connected
 * one does not, and a shape carrying `attempt?: number` would let a view render
 * "attempt 3 of 5" beside "connected".
 */
export type DaemonConnection =
  /** Nobody has reported. Renders as _not checked_; never as connected, never as down. */
  | { readonly kind: "unreported" }
  | { readonly kind: "probing" }
  | { readonly kind: "starting" }
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly attemptLimit: number }
  /** The handshake was refused. The facts are on `MainProcessState.negotiation`. */
  | { readonly kind: "version-incompatible" }
  | {
      readonly kind: "offline";
      readonly attemptLimit: number;
      /** The supervisor's last recorded exit or spawn failure, verbatim. */
      readonly lastError: string | undefined;
    }
  | { readonly kind: "stopped" };

/** Which transport reached the daemon. `loopback` is the visibly second-class one. */
export type DaemonTransport = "os-local" | "loopback";

/** Whether long-lived auth material can be persisted at all on this host. */
export type MainProcessKeystoreState = "available" | "unavailable";

/**
 * The whole report, as one window holds it.
 *
 * Every member is `undefined` until something says otherwise, and `undefined` means
 * "unreported" rather than a default: a console that rendered `os-local` because
 * nothing had said would be claiming a transport posture it never read.
 */
export interface MainProcessState {
  readonly connection: DaemonConnection;
  /**
   * What the handshake settled, on every arm it settled on.
   *
   * Beside the connection rather than inside its refused arm, because the daemon
   * answers `protocolVersion` on the ACCEPTED ack too and the daemon page names the
   * version a connected runtime speaks. One home for the handshake's facts means a
   * reader never has to ask which arm it may read the version from.
   */
  readonly negotiation: MainProcessNegotiation | undefined;
  /** The last heartbeat the supervisor observed, verbatim from the wire. */
  readonly lastHeartbeatAt: string | undefined;
  readonly transport: DaemonTransport | undefined;
  readonly keystore: MainProcessKeystoreState | undefined;
}

/** What a window holds before anything has reported. The store is born on it. */
export const UNREPORTED_MAIN_PROCESS_STATE: MainProcessState = {
  connection: { kind: "unreported" },
  negotiation: undefined,
  lastHeartbeatAt: undefined,
  transport: undefined,
  keystore: undefined,
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
    left.consoleProtocolVersion === right.consoleProtocolVersion &&
    left.daemonProtocolVersion === right.daemonProtocolVersion &&
    left.daemonSupportedProtocols.length === right.daemonSupportedProtocols.length &&
    left.daemonSupportedProtocols.every(
      (version, position) => version === right.daemonSupportedProtocols[position],
    )
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
