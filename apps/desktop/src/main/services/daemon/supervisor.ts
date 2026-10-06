// Main's supervisor of the background service: it finds the service where it listens, starts it
// detached when none answers, handshakes with `daemon.hello`, watches the link, and brings a lost
// link back with backoff. It never owns the service's life: a quit sends `daemon.flush` alone and
// closes main's connection, leaving the service, every run and every shell running. Only the
// person's `Stop` and `Restart` end it: each flushes first, waiting at most as long as a quit
// does, then asks, and a service still running once its drain bound has passed since the request
// went out gets SIGTERM and, 2 seconds later, SIGKILL. A service that stops answering, or never
// answers the request, gets SIGTERM at once, which starts its drain, and SIGKILL only once the
// drain bound and 2 seconds have passed. Main knows the service's process by the identity the
// service reports when the link comes up, so a service it found running is ended as one it
// started. What the supervisor knows is published on main's `DaemonLink`.

import {
  connectToDaemon,
  JsonRpcRemoteError,
  JsonRpcTransportClosedError,
  JsonRpcTransportUnavailableError,
  type DaemonConnection as DaemonClientConnection,
  type DaemonConnectionObserver,
} from "@ai-sidekicks/client-sdk";
import {
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS,
  DAEMON_STOP_DRAIN_BOUND_MS,
  type DaemonLifecycleAccepted,
} from "@ai-sidekicks/contracts/daemon/lifecycle";
import { DAEMON_STATUS_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/status";
import {
  CURRENT_PROTOCOL_VERSION,
  NEGOTIATION_REASON_CEILING_EXCEEDED,
  NEGOTIATION_REASON_FLOOR_EXCEEDED,
  NEGOTIATION_TOKEN_INVALID_CODE,
  type DaemonHelloAck,
} from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import {
  ProcessIdentitySchema,
  type ProcessIdentity,
} from "@ai-sidekicks/contracts/process-identity";
import { z } from "zod";

import { SERVICE_START_BACKOFF_MS } from "#shared/daemon/restart-backoff.js";
import type {
  DaemonConnection,
  MainProcessNegotiation,
  MainProcessState,
} from "#shared/daemon/status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { describeFailure } from "#shared/failure-message.js";
import { NOT_CONNECTED_MESSAGE, unlinkedState, type DaemonLink } from "./link/status.js";
import { LinkLifetime, type LinkEvents, type LinkLossCause } from "./link/lifetime.js";
import type { ServiceEnding, ServiceExit, ServiceProcess } from "./service/process.js";

/** How long main waits for a started or found service to answer `daemon.hello`. */
export const SERVICE_HELLO_WAIT_MS = 10_000;

/**
 * How long main waits for the service's flush, at a quit and before a stop or restart, before it
 * goes ahead without the answer: a service that never answers cannot hold the app open or keep
 * the person's `Stop` from ending it.
 */
export const SERVICE_FLUSH_WAIT_MS = 10_000;

/**
 * The most values one forwarded subscription holds while main hands the previous one to the page.
 * Main forwards each value as it arrives, so the queue holds only what lands during one send.
 */
const MAIN_SUBSCRIPTION_QUEUE_LIMIT = 256;

const LOG_SOURCE = "main/services/daemon";

/** The first pause between connects while a just-started service binds its socket. */
const SOCKET_WAIT_FIRST_PAUSE_MS = 50;

/** The longest pause between those connects. */
const SOCKET_WAIT_LONGEST_PAUSE_MS = 1_000;

/**
 * The part of the status read a link needs: the service's process. Read whatever else the reply
 * holds, so a service on a protocol main cannot speak still names its process.
 */
const LINKED_SERVICE_SCHEMA: z.ZodType<{ processIdentity: ProcessIdentity }> = z.object({
  processIdentity: ProcessIdentitySchema,
});

/** What the supervisor reaches the service through, and where it records what went wrong. */
export interface DaemonSupervisorOptions {
  /** Where the supervisor publishes the service's state and the connected client. */
  readonly link: DaemonLink;
  /**
   * Opens one connection, handshake included, reporting its frames and close to `observer`; an
   * abort of `signal` closes its socket and rejects.
   */
  readonly connect: (
    observer: DaemonConnectionObserver,
    signal: AbortSignal,
  ) => Promise<DaemonClientConnection>;
  /** Starts the service detached; rejects when it cannot start. */
  readonly startService: () => Promise<ServiceProcess>;
  /** The service process with `identity`, for a service main found running rather than started. */
  readonly attachServiceProcess: (identity: ProcessIdentity) => ServiceProcess;
  readonly log: Pick<MainDiagnosticLog, "write">;
}

/**
 * Connect main to this account's service over its socket, the handshake presenting the session
 * token read from its file at this connect. An abort of `signal` closes the socket and rejects.
 */
export function connectMainToDaemon(
  observer: DaemonConnectionObserver,
  signal: AbortSignal,
): Promise<DaemonClientConnection> {
  return connectToDaemon({
    maxQueuedValuesPerSubscription: MAIN_SUBSCRIPTION_QUEUE_LIMIT,
    observer,
    signal,
  });
}

/** The person's two requests that end the service's work. */
export type ServiceEndingMethod = "daemon.stop" | "daemon.restart";

/** Where the supervisor is: running a start, waiting to start again, linked, or done trying. */
type SupervisorPhase =
  | "idle"
  | "starting"
  | "waiting"
  | "linked"
  | "degraded"
  | "stopped"
  | "quitting"
  | "disposed";

/** One link that is up: its connection, its watch, and the service process it reaches. */
interface CurrentLink {
  readonly connection: DaemonClientConnection;
  readonly lifetime: LinkLifetime;
  /** Absent only for a service on a protocol main cannot speak, which this app did not start. */
  readonly service: ServiceProcess | undefined;
}

/** Main's supervisor of the background service. */
export class DaemonSupervisor {
  readonly #link: DaemonLink;
  readonly #connect: DaemonSupervisorOptions["connect"];
  readonly #startService: () => Promise<ServiceProcess>;
  readonly #attachServiceProcess: (identity: ProcessIdentity) => ServiceProcess;
  readonly #log: Pick<MainDiagnosticLog, "write">;
  #phase: SupervisorPhase = "idle";
  #current: CurrentLink | undefined;
  /** The service this app started, while it has not been seen to exit. */
  #startedService: ServiceProcess | undefined;
  /** A service being ended, which the next start waits out so it can take the data folder. */
  #endingService: ServiceProcess | undefined;
  #consecutiveFailedStarts = 0;
  /** Waits taken since the last link, loss or `Retry`; each start after one takes the next. */
  #startWaitsInARow = 0;
  /** Whether a link has been lost since the service last answered, so starts read as a return. */
  #isBringingBack = false;
  /** Set when the loss being brought back had a cause main does not recognize. */
  #isLossUnrecognized = false;
  #lastError: string | undefined;
  #isStopRequested = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: DaemonSupervisorOptions) {
    this.#link = options.link;
    this.#connect = options.connect;
    this.#startService = options.startService;
    this.#attachServiceProcess = options.attachServiceProcess;
    this.#log = options.log;
  }

  /** Look for the service, starting it when none answers. Called once, at startup. */
  public start(): void {
    if (this.#phase !== "idle") {
      return;
    }
    void this.#attemptStart();
  }

  /**
   * The boot card's `Retry`: start again at once with a full set of attempts. Does nothing while
   * a start is running or a link is up.
   */
  public requestStart(): void {
    if (this.#phase === "starting" || this.#phase === "linked" || this.#isLettingGo()) {
      return;
    }
    this.#clearRetry();
    this.#consecutiveFailedStarts = 0;
    this.#startWaitsInARow = 0;
    this.#isStopRequested = false;
    // A fresh start reads as one, not as the return of a link lost before it.
    this.#isBringingBack = false;
    this.#isLossUnrecognized = false;
    void this.#attemptStart();
  }

  /**
   * The person's `Stop` or `Restart`: flush, waiting at most {@link SERVICE_FLUSH_WAIT_MS}, then
   * ask, then end the service if it still runs once its drain bound has passed since the request
   * went out, whether this app started it or found it running. After a stop the loss that follows
   * reads as stopped and nothing starts the service again until `requestStart`; after a restart
   * the loss is brought back once the old service has exited. A refused flush is an answer, as at
   * a quit. Rejects with the service's refusal of the request, when no link is up, and when the
   * request goes unanswered, in which case the service is still ended as one that stopped
   * answering.
   */
  public async endService(method: ServiceEndingMethod): Promise<DaemonLifecycleAccepted> {
    const current = this.#current;
    if (current === undefined) {
      throw new Error(NOT_CONNECTED_MESSAGE);
    }
    const { client } = current.connection;
    // Set before anything is sent, so a loss that lands before an answer reads as the stop.
    this.#isStopRequested = method === "daemon.stop";
    try {
      const flushOutcome = await settleWithin(flushService(client), SERVICE_FLUSH_WAIT_MS);
      if (!flushOutcome.isSettled) {
        this.#log.write({
          level: "warning",
          source: LOG_SOURCE,
          message:
            `The background service's flush did not answer within ` +
            `${String(SERVICE_FLUSH_WAIT_MS / 1000)} seconds; ${method} went ahead without it.`,
        });
      }
      const ending = DAEMON_LIFECYCLE_METHOD_DESCRIPTORS[method];
      // The service's drain runs from this request, so its bound is counted from the send.
      const askedAt = performance.now();
      const reply = await settleWithin(
        client.call(ending.method, {}, ending.requestSchema, ending.responseSchema),
        DAEMON_STOP_DRAIN_BOUND_MS,
      ).catch((failure: unknown) => {
        if (!(failure instanceof JsonRpcRemoteError)) {
          this.#endServiceProcess(current.service, { cause: "unanswered" });
        }
        throw failure;
      });
      if (!reply.isSettled) {
        // It may never have taken the request, so SIGTERM starts its drain afresh.
        this.#endServiceProcess(current.service, { cause: "unanswered" });
        throw new Error(
          `The background service did not answer ${method} within ` +
            `${String(DAEMON_STOP_DRAIN_BOUND_MS / 1000)} seconds; it is being ended.`,
        );
      }
      this.#endServiceProcess(current.service, { cause: "stopAsked", askedAt });
      return reply.value;
    } catch (failure) {
      // A refusal leaves the service running and the link up.
      if (failure instanceof JsonRpcRemoteError) {
        this.#isStopRequested = false;
      }
      throw failure;
    }
  }

  /**
   * The quit: send `daemon.flush` alone and wait for its answer, and for a service a `Stop` or
   * `Restart` is still ending to exit, then let the service go as `dispose` does. A refusal is an
   * answer; with no link up there is nothing to flush. The quit's own wait bounds both. Nothing
   * starts once the quit begins, so a `Restart` the quit interrupts leaves no new service.
   */
  public async flushAtQuit(): Promise<void> {
    this.#phase = "quitting";
    this.#clearRetry();
    const client = this.#current?.connection.client;
    try {
      if (client !== undefined) {
        await flushService(client);
      }
    } finally {
      try {
        // The ending's signals are due while main runs, whatever the flush did; a quit before
        // them would leave a hung service running.
        await this.#endingService?.whenExited();
      } catch (failure) {
        this.#log.write({
          level: "error",
          source: LOG_SOURCE,
          message: `Waiting for the background service to exit failed: ${describeFailure(failure)}`,
        });
      } finally {
        await this.dispose();
      }
    }
  }

  /**
   * Let the service go at quit: stop every timer, cancel a pending start and close main's
   * connection. The service is never signaled, and nothing starts afterward.
   */
  public async dispose(): Promise<void> {
    this.#phase = "disposed";
    this.#clearRetry();
    const current = this.#current;
    this.#current = undefined;
    if (current !== undefined) {
      current.lifetime.end();
      await current.connection.close();
    }
  }

  async #attemptStart(): Promise<void> {
    this.#phase = "starting";
    if (!this.#isBringingBack) {
      this.#reportUnlinked({ kind: "connecting" });
    }
    // A service being ended still holds the data folder, so a new one would refuse to start.
    const ending = this.#endingService;
    if (ending !== undefined) {
      try {
        await ending.whenExited();
      } catch (failure) {
        // The start goes ahead; a service still holding the data folder fails it, as a start.
        this.#log.write({
          level: "error",
          source: LOG_SOURCE,
          message: `Waiting for the background service to exit failed: ${describeFailure(failure)}`,
        });
      }
      this.#endingService = undefined;
      if (this.#isLettingGo()) {
        return;
      }
    }
    // The watch's close reads the connection once the handshake hands it over.
    let opened: DaemonClientConnection | undefined;
    const lifetime = new LinkLifetime(
      this.#linkEvents(() => opened),
      () => {
        void opened?.close();
      },
    );
    let startedByApp: boolean;
    try {
      opened = await this.#connectWithin(lifetime, false);
      startedByApp = this.#startedService !== undefined && !this.#startedService.hasExited();
    } catch (probeFailure) {
      if (!(probeFailure instanceof JsonRpcTransportUnavailableError)) {
        this.#startFailed(probeFailure);
        return;
      }
      // A quit that began while the probe ran starts nothing.
      if (this.#isLettingGo()) {
        return;
      }
      try {
        opened = await this.#startAndConnect(lifetime);
        startedByApp = true;
      } catch (startFailure) {
        this.#startFailed(startFailure);
        return;
      }
    }
    let service: ServiceProcess | undefined;
    try {
      // Bounded like the handshake: until the read answers, no silence watch runs on the link.
      const linked = await settleWithin(
        this.#linkedServiceProcess(opened, startedByApp),
        SERVICE_HELLO_WAIT_MS,
      );
      if (!linked.isSettled) {
        await opened.close();
        // It answered the handshake and then nothing: one this app started is ended, so the
        // next start does not meet it on the socket again.
        if (startedByApp) {
          this.#endServiceProcess(this.#startedService, { cause: "unanswered" });
        }
        this.#startFailed(
          new Error(
            `The background service did not answer daemon.status.read within ` +
              `${String(SERVICE_HELLO_WAIT_MS / 1000)} seconds`,
          ),
        );
        return;
      }
      service = linked.value;
    } catch (readFailure) {
      await opened.close();
      this.#startFailed(readFailure);
      return;
    }
    if (this.#isLettingGo()) {
      await opened.close();
      return;
    }
    this.#current = { connection: opened, lifetime, service };
    this.#phase = "linked";
    this.#consecutiveFailedStarts = 0;
    this.#startWaitsInARow = 0;
    this.#isBringingBack = false;
    this.#isLossUnrecognized = false;
    this.#link.attach(
      opened.client,
      this.#linkedState(opened.hello, service !== undefined && service === this.#startedService),
    );
    lifetime.open();
  }

  /**
   * The process behind a link that just came up, by the identity the service reports: the one this
   * app started when the id is its, otherwise the one found running. A service on a protocol main
   * cannot speak still answers the read; when even its identity cannot be read, the link comes up
   * and only the service this app started is known.
   */
  async #linkedServiceProcess(
    opened: DaemonClientConnection,
    isStartedByApp: boolean,
  ): Promise<ServiceProcess | undefined> {
    const started = this.#startedService;
    const statusRead = DAEMON_STATUS_METHOD_DESCRIPTORS["daemon.status.read"];
    let identity: ProcessIdentity;
    try {
      ({ processIdentity: identity } = await opened.client.call(
        statusRead.method,
        {},
        statusRead.requestSchema,
        LINKED_SERVICE_SCHEMA,
      ));
    } catch (failure) {
      if (opened.hello.compatible) {
        throw failure;
      }
      this.#log.write({
        level: "warning",
        source: LOG_SOURCE,
        message:
          "The background service on another protocol did not name its process: " +
          describeFailure(failure),
      });
      return isStartedByApp ? started : undefined;
    }
    return started !== undefined && started.processId === identity.processId && !started.hasExited()
      ? started
      : this.#attachServiceProcess(identity);
  }

  /** Start the service, then connect once it has bound its socket, all within the hello wait. */
  async #startAndConnect(lifetime: LinkLifetime): Promise<DaemonClientConnection> {
    if (!this.#isBringingBack) {
      this.#reportUnlinked({ kind: "starting" });
    }
    this.#startedService = await this.#startService();
    return this.#connectWithin(lifetime, true);
  }

  /**
   * Connect and handshake within the hello wait. A just-started service is tried again, at
   * growing pauses, while its socket is not bound or its token not yet written; a found one is
   * tried again only while its token is not written yet, since a socket nothing answers means
   * there is none to find. The wait ends early, with the exit's reason, when the started service
   * exits. A service this app started that is still running when the wait runs out is ended as
   * one that never answered, since it would hold the socket against every later start.
   */
  async #connectWithin(
    lifetime: LinkLifetime,
    isServiceStarting: boolean,
  ): Promise<DaemonClientConnection> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let hasTimedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        hasTimedOut = true;
        reject(
          new Error(
            `The background service did not answer daemon.hello within ` +
              `${String(SERVICE_HELLO_WAIT_MS / 1000)} seconds`,
          ),
        );
      }, SERVICE_HELLO_WAIT_MS);
    });
    const started = isServiceStarting ? this.#startedService : undefined;
    const exitedFirst = new Promise<never>((_resolve, reject) => {
      void started?.whenExited().then((exit) => {
        reject(
          new Error(
            `The background service exited before it answered daemon.hello (${describeExit(exit)})`,
          ),
        );
      });
    });
    // An exit after the link is up is the link's loss, which its watch reports.
    exitedFirst.catch(() => undefined);
    let connecting: Promise<DaemonClientConnection> | undefined;
    const handshakeAbort = new AbortController();
    let isLinked = false;
    try {
      let pauseMs = SOCKET_WAIT_FIRST_PAUSE_MS;
      for (;;) {
        connecting = this.#connect(lifetime, handshakeAbort.signal);
        try {
          const opened = await Promise.race([connecting, deadline, exitedFirst]);
          isLinked = true;
          return opened;
        } catch (failure) {
          // No socket at a found service's place means none is running, so one is started; a
          // found one still writing its token is waited for, as a started one is.
          const isNoSocket = failure instanceof JsonRpcTransportUnavailableError;
          if (!isServiceNotReadyYet(failure) || (isNoSocket && !isServiceStarting)) {
            throw failure;
          }
        }
        await Promise.race([pause(pauseMs), deadline, exitedFirst]);
        pauseMs = Math.min(pauseMs * 2, SOCKET_WAIT_LONGEST_PAUSE_MS);
      }
    } catch (failure) {
      if (hasTimedOut) {
        this.#endServiceProcess(this.#startedService, { cause: "unanswered" });
      }
      throw failure;
    } finally {
      clearTimeout(deadlineTimer);
      if (!isLinked) {
        // A service that took the socket and never answered would keep it open past the wait.
        handshakeAbort.abort(new Error("The wait for the background service's handshake ended."));
        // A handshake that answers after the wait ended without it has lost, to the deadline or
        // to the service's exit: its connection is closed unused. Its failure was the race's.
        void connecting?.then(
          (late) => late.close(),
          () => undefined,
        );
      }
    }
  }

  #linkEvents(currentConnection: () => DaemonClientConnection | undefined): LinkEvents {
    return {
      connected: () => {
        this.#log.write({
          level: "notice",
          source: LOG_SOURCE,
          message: "The link to the background service is up.",
        });
      },
      quiet: () => {
        const client = currentConnection()?.client;
        if (client !== undefined) {
          this.#ping(client);
        }
      },
      errored: (message) => {
        this.#lastError = message;
        this.#log.write({
          level: "error",
          source: LOG_SOURCE,
          message: `The link to the background service failed: ${message}`,
        });
      },
      lost: (cause) => {
        this.#linkLost(cause);
      },
    };
  }

  #ping(client: DaemonClientConnection["client"]): void {
    const descriptor = DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.ping"];
    client
      .call(descriptor.method, {}, descriptor.requestSchema, descriptor.responseSchema)
      .catch((failure: unknown) => {
        // A refusal is an answer: it arrived as a frame, which is all the ping asks. A closed
        // transport is the link's loss, which its watch reports.
        if (
          failure instanceof JsonRpcRemoteError ||
          failure instanceof JsonRpcTransportClosedError
        ) {
          return;
        }
        this.#log.write({
          level: "error",
          source: LOG_SOURCE,
          message: `The ping to the background service failed: ${describeFailure(failure)}`,
        });
      });
  }

  #linkLost(cause: LinkLossCause): void {
    const lost = this.#current;
    this.#current = undefined;
    this.#log.write({
      level: "warning",
      source: LOG_SOURCE,
      message: `The link to the background service was lost (${cause.kind}).`,
    });
    if (this.#isLettingGo() || cause.kind === "closedByMain") {
      return;
    }
    if (cause.kind === "silence") {
      // A service that stopped answering cannot be asked to stop, so SIGTERM asks it, whether this
      // app started it or found it, and the next start can take its place. A stop under way
      // ends it too: its own request may never have been sent.
      this.#endServiceProcess(lost?.service, { cause: "unanswered" });
    }
    if (this.#isStopRequested) {
      this.#phase = "stopped";
      this.#link.detach(unlinkedState({ kind: "stopped" }));
      return;
    }
    this.#isBringingBack = true;
    this.#isLossUnrecognized = cause.kind === "unrecognized";
    this.#consecutiveFailedStarts = 0;
    this.#startWaitsInARow = 0;
    this.#link.detach(unlinkedState(this.#returningConnection()));
    this.#scheduleStart();
  }

  #endServiceProcess(service: ServiceProcess | undefined, ending: ServiceEnding): void {
    if (service === undefined || service.hasExited()) {
      return;
    }
    this.#endingService = service;
    service.end(ending).catch((failure: unknown) => {
      this.#log.write({
        level: "error",
        source: LOG_SOURCE,
        message: `Ending the background service failed: ${describeFailure(failure)}`,
      });
    });
  }

  #startFailed(failure: unknown): void {
    if (this.#isLettingGo()) {
      return;
    }
    this.#consecutiveFailedStarts += 1;
    this.#lastError = describeFailure(failure);
    this.#log.write({
      level: "error",
      source: LOG_SOURCE,
      message: `The background service did not start: ${this.#lastError}`,
    });
    if (this.#consecutiveFailedStarts >= SERVICE_START_BACKOFF_MS.length) {
      this.#phase = "degraded";
      this.#reportUnlinked({
        kind: "degraded",
        attemptLimit: SERVICE_START_BACKOFF_MS.length,
        lastError: this.#lastError,
      });
      return;
    }
    if (this.#isBringingBack) {
      this.#reportUnlinked(this.#returningConnection());
    }
    this.#scheduleStart();
  }

  #scheduleStart(): void {
    this.#phase = "waiting";
    // A first start runs at once, so the waits after it begin at the first, as after a loss.
    const waitMs = SERVICE_START_BACKOFF_MS[this.#startWaitsInARow] ?? 0;
    this.#startWaitsInARow += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#attemptStart();
    }, waitMs);
  }

  /** How a link being brought back reads: by its attempt, or `unknown` for a cause not known. */
  #returningConnection(): DaemonConnection {
    return this.#isLossUnrecognized
      ? { kind: "unknown", lastError: this.#lastError }
      : {
          kind: "transient_disconnect",
          attempt: this.#consecutiveFailedStarts + 1,
          attemptLimit: SERVICE_START_BACKOFF_MS.length,
        };
  }

  #linkedState(hello: DaemonHelloAck, startedByApp: boolean): MainProcessState {
    return {
      ...unlinkedState(hello.compatible ? { kind: "connected" } : { kind: "version_incompatible" }),
      negotiation: negotiationOf(hello),
      startedByApp,
    };
  }

  #reportUnlinked(connection: DaemonConnection): void {
    this.#link.report(unlinkedState(connection));
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  // Whether the quit has begun letting the service go. A method rather than a field read, so the
  // narrowing an await crossed does not stick.
  #isLettingGo(): boolean {
    return this.#phase === "quitting" || this.#phase === "disposed";
  }
}

/** What the handshake settled, in the topic's terms. */
function negotiationOf(hello: DaemonHelloAck): MainProcessNegotiation {
  return {
    compatible: hello.compatible,
    daemonProtocolVersion: hello.protocolVersion,
    appProtocolVersion: CURRENT_PROTOCOL_VERSION,
    daemonSupportedProtocols: hello.daemonSupportedProtocols ?? [],
    reason: hello.reason,
    behind:
      hello.reason === NEGOTIATION_REASON_FLOOR_EXCEEDED
        ? "app"
        : hello.reason === NEGOTIATION_REASON_CEILING_EXCEEDED
          ? "service"
          : undefined,
  };
}

/**
 * Settles with `promise`'s value, or as unsettled once `waitMs` has passed; rejects with its
 * failure when that comes first. A failure after the wait is left to the caller's own handling.
 */
async function settleWithin<T>(
  promise: Promise<T>,
  waitMs: number,
): Promise<{ readonly isSettled: true; readonly value: T } | { readonly isSettled: false }> {
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const waitEnded = new Promise<{ readonly isSettled: false }>((resolve) => {
    waitTimer = setTimeout(() => {
      resolve({ isSettled: false });
    }, waitMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ isSettled: true, value }) as const),
      waitEnded,
    ]);
  } finally {
    clearTimeout(waitTimer);
  }
}

/**
 * Send `daemon.flush` and settle once it is answered; a refusal is an answer. Rejects when the
 * link fails under it.
 */
async function flushService(client: DaemonClientConnection["client"]): Promise<void> {
  const flush = DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.flush"];
  try {
    await client.call(flush.method, {}, flush.requestSchema, flush.responseSchema);
  } catch (failure) {
    if (!(failure instanceof JsonRpcRemoteError)) {
      throw failure;
    }
  }
}

// A just-started service binds its socket, then writes its session token: a connect in between
// finds no socket, no token file, or the previous start's token.
function isServiceNotReadyYet(failure: unknown): boolean {
  return (
    failure instanceof JsonRpcTransportUnavailableError ||
    (failure instanceof JsonRpcRemoteError &&
      failure.data?.type === NEGOTIATION_TOKEN_INVALID_CODE) ||
    (failure instanceof Error && (failure as NodeJS.ErrnoException).code === "ENOENT")
  );
}

function describeExit(exit: ServiceExit): string {
  if (exit.signal !== null) {
    return `ended by ${exit.signal}`;
  }
  return exit.code === null ? "how it ended is unknown" : `exit code ${String(exit.code)}`;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
