// The supervisor's `daemon.status` topic: what main knows about the background service and
// its link to it, published to every window on `daemon.subscribe`.
//
// Main is the one writer and the renderer the one reader. The topic is not part of the
// daemon's method map because it must speak while no service answers: at boot, while a start
// is retried, and on Windows when the service wrote down why it cannot start.

/** The topic's name on `daemon.subscribe`. */
export const DAEMON_STATUS_TOPIC = "daemon.status";

/**
 * What the handshake settled, as `DaemonHelloAck` carries it. The members are the ack's own;
 * the console renders them and compares nothing.
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
  /**
   * Which side is behind when the two are outside each other's range (each app accepts its own
   * service version and the one before it); its update fixes it. Absent while compatible.
   */
  readonly behind: "app" | "service" | undefined;
}

/**
 * Where this window stands with its local runtime, in the supervisor's steps: `probing` is
 * the startup probe, `starting` the spawn and its readiness wait, `version-incompatible` a
 * refused handshake, `connected` the live link, `reconnecting` the backoff ladder, `offline`
 * that ladder's end, and `stopped` a deliberate shutdown. `unreported` is what a window holds
 * before main's first delivery; main never publishes it.
 */
export type DaemonConnection =
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
 * On Windows, whether the service keeps running while the person is signed out: `on`,
 * `off`, `passwordOutOfDate` when the signed-out task last failed on a changed password, and
 * `notOffered` where Windows allows no service with no one signed in.
 */
export type WhileSignedOut = "on" | "off" | "passwordOutOfDate" | "notOffered";

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
 * default: rendering `os-local` before anything said so would claim a transport never read.
 */
export interface MainProcessState {
  readonly connection: DaemonConnection;
  /** What the handshake settled, on every arm it settled on. */
  readonly negotiation: MainProcessNegotiation | undefined;
  /** The last heartbeat the supervisor observed, verbatim from the wire. */
  readonly lastHeartbeatAt: string | undefined;
  readonly transport: DaemonTransport | undefined;
  readonly keystore: MainProcessKeystoreState | undefined;
  /** Whether this app started the service itself or found one already running. */
  readonly startedByApp: boolean | undefined;
  /** Windows only; absent elsewhere. */
  readonly whileSignedOut: WhileSignedOut | undefined;
  /** Windows only, and only while the service has written down why it cannot start. */
  readonly cannotStart: ServiceCannotStart | undefined;
}
