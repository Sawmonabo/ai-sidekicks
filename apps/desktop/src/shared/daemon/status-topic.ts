// The supervisor's `daemon.status` topic: what main knows about the background service and
// its link to it, published to every window on `daemon.subscribe`.
//
// Main is the one writer and the renderer the one reader. The topic is not part of the
// daemon's method map because it must speak while no service answers: at boot, while a start
// is retried, and on Windows when the service wrote down why it cannot start.

/**
 * What the app says when the background service does not answer: a call the operating system
 * broke, a call rejected with no code of its own, and a link main gave up on.
 */
export const NOT_ANSWERING_MESSAGE = "The background service is not answering.";

/** The topic's name on `daemon.subscribe`. */
export const DAEMON_STATUS_TOPIC = "daemon.status";

/** The topic's name as a type, so `daemon.subscribe` types its payload by it. */
export type DaemonStatusTopic = typeof DAEMON_STATUS_TOPIC;

/** What the topic is opened with: nothing, as there is one service per machine. */
export type DaemonStatusRequest = Readonly<Record<string, never>>;

/**
 * What the handshake settled, as `DaemonHelloAck` carries it. The members are the ack's own;
 * the app renders them and compares nothing.
 */
export interface MainProcessNegotiation {
  readonly compatible: boolean;
  /** The daemon's chosen protocol version, verbatim. */
  readonly daemonProtocolVersion: string;
  /** The version this build proposed, verbatim. */
  readonly appProtocolVersion: string;
  /** The daemon's full supported set, where the refused ack carried one. */
  readonly daemonSupportedProtocols: readonly string[];
  /** The ack's own `reason`, present only on the incompatible arm. */
  readonly reason: string | undefined;
  /**
   * Which side is behind when the two are outside each other's range (each app accepts its own
   * service version and the one before it); its update fixes it. Absent while compatible.
   */
  readonly behind: "app" | "service" | undefined;
}

/**
 * Where this window stands with the background service. Before a link exists: `connecting` while
 * main looks for a running service and handshakes, `starting` while a service main started comes
 * up. With a link: `connected`, or `version_incompatible` when the handshake was refused and the
 * link serves reads alone. After a link is lost: `transient_disconnect` while main brings it back
 * with backoff, `unknown` for a loss whose cause main does not recognize, drawn as `degraded` and
 * never as `connected`, and `degraded` once the backoff gives up. `stopped` is the service ended
 * on the person's `Stop`. `unreported` is what a window holds before main's first delivery; main
 * never publishes it.
 */
export type DaemonConnection =
  | { readonly kind: "unreported" }
  | { readonly kind: "connecting" }
  | { readonly kind: "starting" }
  | { readonly kind: "connected" }
  /** The handshake was refused. The facts are on `MainProcessState.negotiation`. */
  | { readonly kind: "version_incompatible" }
  | {
      readonly kind: "transient_disconnect";
      /** The start being made now, counted from 1 since the loss. */
      readonly attempt: number;
      readonly attemptLimit: number;
    }
  | {
      readonly kind: "unknown";
      /** The loss's own error, verbatim, where it carried one. */
      readonly lastError: string | undefined;
    }
  | {
      readonly kind: "degraded";
      readonly attemptLimit: number;
      /** The supervisor's last recorded loss or start failure, verbatim. */
      readonly lastError: string | undefined;
    }
  | { readonly kind: "stopped" };

/**
 * Whether the service keeps running while the person is signed out of Windows or logged out of
 * the Mac: `on`, `off`, `passwordOutOfDate` when the Windows task last failed on a changed
 * password, `notOffered` where the machine allows no such service, and on macOS alone
 * `waitingForApproval` before an administrator approves it and `turnedOffInLoginItems` after one
 * turns it off.
 */
export type WhileSignedOut =
  | "on"
  | "off"
  | "passwordOutOfDate"
  | "notOffered"
  | "waitingForApproval"
  | "turnedOffInLoginItems";

/**
 * On Windows, why the service cannot start, as the service's Windows half wrote it down: WSL
 * not responding, its restarts used up (with the error it gave, verbatim), the place it ran
 * in gone, or its connection's name held by another program.
 */
export type ServiceCannotStart =
  | { readonly reason: "wslNotResponding" }
  | { readonly reason: "restartsExhausted"; readonly error: string }
  | { readonly reason: "placeGone" }
  | { readonly reason: "connectionNameTaken" };

/**
 * One delivery of the topic, the first being the current state. Every member other than the
 * connection is `undefined` until main has read it, and `undefined` means unreported, never a
 * default: rendering `startedByApp: false` before anything said so would claim a fact never read.
 */
export interface MainProcessState {
  readonly connection: DaemonConnection;
  /** What the handshake settled, on every arm it settled on. */
  readonly negotiation: MainProcessNegotiation | undefined;
  /** Whether this app started the service itself or found one already running. */
  readonly startedByApp: boolean | undefined;
  /** Windows only; absent elsewhere. */
  readonly whileSignedOut: WhileSignedOut | undefined;
  /** Windows only, and only while the service has written down why it cannot start. */
  readonly cannotStart: ServiceCannotStart | undefined;
}
