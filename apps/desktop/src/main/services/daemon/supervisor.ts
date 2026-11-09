// Main's supervisor of the background service: it connects to the service through the client
// helper, starts the service detached when none answers, and brings a lost link back with backoff,
// forking the helper again when it exited. It never owns the service's life: a quit sends
// `daemon.flush` alone and ends the helper, leaving the service, every run and every shell running.
// Only the person's `Stop` and `Restart` end it: each flushes first, waiting at most as long as a
// quit does, then asks, and a service still running once its drain bound has passed since the
// request went out gets SIGTERM and, 2 seconds later, SIGKILL. A service that never answers the
// request gets SIGTERM at once, which starts its drain, and SIGKILL only once the drain bound and 2
// seconds have passed. Main knows the service's process by the identity the service reports when
// the link comes up, so a service it found running is ended as one it started. What the supervisor
// knows is published on main's `DaemonLink`.

import {
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS,
  DAEMON_STOP_DRAIN_BOUND_MS,
  type DaemonLifecycleAccepted,
} from "@ai-sidekicks/contracts/daemon/lifecycle";
import {
  DAEMON_REPAIRING_CODE,
  validateDaemonRepairingDetails,
  type DaemonRepairProgress,
} from "@ai-sidekicks/contracts/daemon/recovery";
import { DAEMON_STATUS_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/status";
import {
  CONNECTION_UNAVAILABLE_CODE,
  type JsonRpcError,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import { AUTH_TOKEN_INVALID_CODE } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import { SERVICE_START_BACKOFF_MS } from "#shared/daemon/restart-backoff.js";
import type { DaemonConnection } from "#shared/daemon/status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { describeFailure } from "#shared/failure-message.js";
import {
  DaemonRefusal,
  type ClientHelperListener,
  type ClientHelperProcess,
} from "./client/process.js";
import type { ClientHelperLinkState } from "./client/messages.js";
import { NOT_CONNECTED_MESSAGE, unlinkedState, type DaemonLink } from "./link/status.js";
import type { ServiceEnding, ServiceExit, ServiceProcess } from "./service/process.js";

/**
 * How long main waits for a started or found service to answer its connect, counted from the
 * start, or from the service's latest answer that it is repairing its database file.
 */
export const SERVICE_HELLO_WAIT_MS = 10_000;

const LOG_SOURCE = "main/services/daemon";

/** The first pause between connects while a just-started service binds its socket. */
const SOCKET_WAIT_FIRST_PAUSE_MS = 50;

/** The longest pause between those connects. */
const SOCKET_WAIT_LONGEST_PAUSE_MS = 1_000;

/** What the supervisor reaches the service through, and where it records what went wrong. */
export interface DaemonSupervisorOptions {
  /** Where the supervisor publishes the service's state and the connected client. */
  readonly link: DaemonLink;
  /** The client helper, which holds the one connection to the service. */
  readonly helper: Pick<
    ClientHelperProcess,
    "connect" | "closeLink" | "dispose" | "listen" | "call" | "subscribe" | "flushWaitMs"
  >;
  /** Starts the service detached; rejects when it cannot start. */
  readonly startService: () => Promise<ServiceProcess>;
  /** The service process with `identity`, for a service main found running rather than started. */
  readonly attachServiceProcess: (identity: ProcessIdentity) => ServiceProcess;
  readonly log: Pick<MainDiagnosticLog, "write">;
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

/** One link that is up: the service process it reaches. */
interface CurrentLink {
  /** Absent only for a service that would not name its process, which this app did not start. */
  readonly service: ServiceProcess | undefined;
}

/** Main's supervisor of the background service. */
export class DaemonSupervisor implements ClientHelperListener {
  readonly #link: DaemonLink;
  readonly #helper: DaemonSupervisorOptions["helper"];
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
  #lastError: string | undefined;
  #isStopRequested = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: DaemonSupervisorOptions) {
    this.#link = options.link;
    this.#helper = options.helper;
    options.helper.listen(this);
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
    void this.#attemptStart();
  }

  /** The link is reconnecting or down: main brings it back through its own start. */
  public linkStateChanged(state: ClientHelperLinkState): void {
    if (this.#phase === "linked" && (state === "reconnecting" || state === "down")) {
      this.#helper.closeLink();
      this.#linkLost(`the link reported ${state}`);
    }
  }

  /** The helper exited: a link it held is lost, and the next start forks it again. */
  public exited(): void {
    if (this.#phase === "linked") {
      this.#linkLost("the client helper exited");
    }
  }

  /**
   * The person's `Stop` or `Restart`: flush, waiting at most the client's flush bound, then
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
    const helper = this.#helper;
    // Set before anything is sent, so a loss that lands before an answer reads as the stop.
    this.#isStopRequested = method === "daemon.stop";
    try {
      const flushWaitMs = helper.flushWaitMs;
      const flushOutcome = await settleWithin(flushService(helper), flushWaitMs);
      if (!flushOutcome.isSettled) {
        this.#log.write({
          level: "warning",
          source: LOG_SOURCE,
          message:
            `The background service's flush did not answer within ` +
            `${String(flushWaitMs / 1000)} seconds; ${method} went ahead without it.`,
        });
      }
      // The service's drain runs from this request, so its bound is counted from the send.
      const askedAt = performance.now();
      const reply = await settleWithin(
        helper.call(DAEMON_LIFECYCLE_METHOD_DESCRIPTORS[method], {}),
        DAEMON_STOP_DRAIN_BOUND_MS,
      ).catch((failure: unknown) => {
        if (!(failure instanceof DaemonRefusal)) {
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
      if (failure instanceof DaemonRefusal) {
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
    try {
      if (this.#current !== undefined) {
        await flushService(this.#helper);
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
   * Let the service go at quit: stop every timer, cancel a pending start and end the client
   * helper, which closes main's connection. The service is never signaled, and nothing starts
   * afterward.
   */
  public dispose(): Promise<void> {
    this.#phase = "disposed";
    this.#clearRetry();
    this.#current = undefined;
    this.#helper.dispose();
    return Promise.resolve();
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
    let startedByApp: boolean;
    try {
      await this.#connectWithin(false);
      startedByApp = this.#startedService !== undefined && !this.#startedService.hasExited();
    } catch (probeFailure) {
      if (!isNoService(probeFailure)) {
        this.#startFailed(probeFailure);
        return;
      }
      // A quit that began while the probe ran starts nothing.
      if (this.#isLettingGo()) {
        return;
      }
      try {
        await this.#startAndConnect();
        startedByApp = true;
      } catch (startFailure) {
        this.#startFailed(startFailure);
        return;
      }
    }
    let service: ServiceProcess | undefined;
    try {
      // Bounded like the connect, so a service that answers it and then nothing fails the start.
      const linked = await settleWithin(
        this.#linkedServiceProcess(startedByApp),
        SERVICE_HELLO_WAIT_MS,
      );
      if (!linked.isSettled) {
        this.#helper.closeLink();
        // It answered the connect and then nothing: one this app started is ended, so the next
        // start does not meet it on the socket again.
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
      this.#helper.closeLink();
      this.#startFailed(readFailure);
      return;
    }
    if (this.#isLettingGo()) {
      this.#helper.closeLink();
      return;
    }
    this.#current = { service };
    this.#phase = "linked";
    this.#consecutiveFailedStarts = 0;
    this.#startWaitsInARow = 0;
    this.#isBringingBack = false;
    this.#log.write({
      level: "notice",
      source: LOG_SOURCE,
      message: "The link to the background service is up.",
    });
    this.#link.attach(this.#helper, {
      ...unlinkedState({ kind: "connected" }),
      startedByApp: service !== undefined && service === this.#startedService,
    });
  }

  /**
   * The process behind a link that just came up, by the identity the service reports: the one this
   * app started when the id is its, otherwise the one found running. When the service does not
   * name its process, the link comes up and only the service this app started is known.
   */
  async #linkedServiceProcess(isStartedByApp: boolean): Promise<ServiceProcess | undefined> {
    const started = this.#startedService;
    let identity: ProcessIdentity;
    try {
      ({ processIdentity: identity } = await this.#helper.call(
        DAEMON_STATUS_METHOD_DESCRIPTORS["daemon.status.read"],
        {},
      ));
    } catch (failure) {
      this.#log.write({
        level: "warning",
        source: LOG_SOURCE,
        message: "The background service did not name its process: " + describeFailure(failure),
      });
      return isStartedByApp ? started : undefined;
    }
    return started !== undefined && started.processId === identity.processId && !started.hasExited()
      ? started
      : this.#attachServiceProcess(identity);
  }

  /** Start the service, then connect once it has bound its socket, all within the hello wait. */
  async #startAndConnect(): Promise<void> {
    if (!this.#isBringingBack) {
      this.#reportUnlinked({ kind: "starting" });
    }
    this.#startedService = await this.#startService();
    await this.#connectWithin(true);
  }

  /**
   * Connect and handshake within the hello wait. A just-started service is tried again, at
   * growing pauses, while its socket is not bound or its token not yet written; a found one is
   * tried again only while its token is not written yet, since a socket nothing answers means
   * there is none to find. A service, started or found, that answers it is repairing its
   * database file is waited for as long as it keeps answering so: the wait runs again from each
   * such answer, reported with its count unless a lost link is being brought back, and the gap
   * while it binds its socket again is waited out as a start's. The wait ends early, with the
   * exit's reason, when the started service exits. A service this app started that is still
   * running when the wait runs out is ended as one that never answered, since it would hold the
   * socket against every later start.
   */
  async #connectWithin(isServiceStarting: boolean): Promise<void> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let hasTimedOut = false;
    const deadline = Promise.withResolvers<never>();
    // Armed once here and again at each answer that the service is repairing.
    const armDeadline = (): void => {
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => {
        hasTimedOut = true;
        deadline.reject(
          new Error(
            `The background service did not answer its connect within ` +
              `${String(SERVICE_HELLO_WAIT_MS / 1000)} seconds`,
          ),
        );
      }, SERVICE_HELLO_WAIT_MS);
    };
    armDeadline();
    // Whether a missing socket means one still to be bound rather than no service at all.
    let isSocketExpected = isServiceStarting;
    const started = isServiceStarting ? this.#startedService : undefined;
    const exitedFirst = new Promise<never>((_resolve, reject) => {
      void started?.whenExited().then((exit) => {
        reject(
          new Error(
            `The background service exited before it answered its connect (${describeExit(exit)})`,
          ),
        );
      });
    });
    // An exit after the link is up is the link's loss, which the helper reports.
    exitedFirst.catch(() => undefined);
    let connecting: Promise<JsonRpcError | undefined> | undefined;
    let isLinked = false;
    try {
      let pauseMs = SOCKET_WAIT_FIRST_PAUSE_MS;
      for (;;) {
        connecting = this.#helper.connect();
        const refused = await Promise.race([connecting, deadline.promise, exitedFirst]);
        if (refused === undefined) {
          isLinked = true;
          return;
        }
        const failure = new DaemonRefusal(refused);
        // No socket at a found service's place means none is running, so one is started, unless
        // it answered that it is repairing; a found one still writing its token is waited for.
        const isNoSocket = isNoService(failure);
        if (isServiceRepairing(failure)) {
          // Alive and busy for as long as the repair takes: it binds its socket again after.
          isSocketExpected = true;
          armDeadline();
          if (!this.#isBringingBack) {
            this.#reportUnlinked({
              kind: "repairing",
              progress: this.#repairProgressOf(failure),
            });
          }
        } else if (!isServiceNotReadyYet(failure) || (isNoSocket && !isSocketExpected)) {
          throw failure;
        }
        await Promise.race([pause(pauseMs), deadline.promise, exitedFirst]);
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
        // A connect that answers after the wait ended without it has lost, to the deadline or to
        // the service's exit: its link is closed unused. Its failure was the race's.
        void connecting?.then(
          (late) => {
            if (late === undefined) {
              this.#helper.closeLink();
            }
          },
          () => undefined,
        );
      }
    }
  }

  /**
   * The count a repairing answer carries, read from its fields. Fields the app cannot read are
   * logged, and the repair is reported without a count.
   */
  #repairProgressOf(failure: DaemonRefusal): DaemonRepairProgress | undefined {
    const fields: unknown = failure.refusal.data?.fields ?? {};
    if (!validateDaemonRepairingDetails(fields)) {
      this.#log.write({
        level: "warning",
        source: LOG_SOURCE,
        message: "The background service's repair count could not be read.",
      });
      return undefined;
    }
    return fields.progress;
  }

  #linkLost(cause: string): void {
    this.#current = undefined;
    this.#lastError = cause;
    this.#log.write({
      level: "warning",
      source: LOG_SOURCE,
      message: `The link to the background service was lost: ${cause}.`,
    });
    if (this.#isLettingGo()) {
      return;
    }
    if (this.#isStopRequested) {
      this.#phase = "stopped";
      this.#link.detach(unlinkedState({ kind: "stopped" }));
      return;
    }
    this.#isBringingBack = true;
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

  /** How a link being brought back reads: by its attempt. */
  #returningConnection(): DaemonConnection {
    return {
      kind: "transient_disconnect",
      attempt: this.#consecutiveFailedStarts + 1,
      attemptLimit: SERVICE_START_BACKOFF_MS.length,
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
async function flushService(helper: DaemonSupervisorOptions["helper"]): Promise<void> {
  try {
    await helper.call(DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.flush"], {});
  } catch (failure) {
    if (!(failure instanceof DaemonRefusal)) {
      throw failure;
    }
  }
}

// No socket answers where the service listens.
function isNoService(failure: unknown): boolean {
  return (
    failure instanceof DaemonRefusal && failure.refusal.data?.type === CONNECTION_UNAVAILABLE_CODE
  );
}

// A just-started service binds its socket, then writes its session token: a connect in between
// finds no socket, no token file (an error with no refusal code), or the previous start's token.
function isServiceNotReadyYet(failure: DaemonRefusal): boolean {
  const type = failure.refusal.data?.type;
  return (
    type === undefined || type === CONNECTION_UNAVAILABLE_CODE || type === AUTH_TOKEN_INVALID_CODE
  );
}

// A service repairing its database file refuses the connect with this until it is done.
function isServiceRepairing(failure: DaemonRefusal): boolean {
  return failure.refusal.data?.type === DAEMON_REPAIRING_CODE;
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
