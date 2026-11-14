// Main's supervisor of the background service: it connects to the service through the client
// helper, starts the service detached when none answers, and brings a lost link back with backoff,
// forking the helper again when it exited. The client owns every wait: the handshake deadline, the
// retries while a started service binds its socket, the flush bound and the ending's signals. Main
// decides only when to start and how long to back off. It never owns the service's life: a quit
// sends `daemon.flush` alone and ends the helper, leaving the service, every run and every shell
// running. Only the person's `Stop` and `Restart` end it, through the client's one ending, which
// the helper runs; a service that stopped answering, whose link is down, or that this app started
// and never answered, is ended by its process identity at once. A service that cannot start over
// its saved sessions is not started again until the person's `Retry`. What the supervisor knows,
// the service's status file included, is published on main's `DaemonLink`.

import type { DaemonEnded, DaemonEndingOutcome } from "@ai-sidekicks/client-sdk";
import { DAEMON_LIFECYCLE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import {
  DAEMON_REPAIRING_CODE,
  validateDaemonRepairingDetails,
  type DaemonRepairingDetails,
  type DaemonRepairProgress,
} from "@ai-sidekicks/contracts/daemon/recovery";
import type {
  DaemonCannotStart,
  ServiceStatusFile,
} from "@ai-sidekicks/contracts/daemon/service-status";
import { DAEMON_STATUS_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/status";
import {
  CONNECTION_UNAVAILABLE_CODE,
  type JsonRpcError,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  CURRENT_PROTOCOL_VERSION,
  NEGOTIATION_REASON_CEILING_EXCEEDED,
  NEGOTIATION_REASON_FLOOR_EXCEEDED,
  type ConnectionInitializeResponse,
} from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import { SERVICE_START_BACKOFF_MS } from "#shared/daemon/restart-backoff.js";
import type {
  DaemonConnection,
  MainProcessNegotiation,
  MainProcessState,
  ServiceCannotStop,
} from "#shared/daemon/status-topic.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { describeFailure } from "#shared/failure-message.js";
import { signalWords } from "#shared/signal-words.js";
import {
  DaemonRefusal,
  ServiceAskFailed,
  type ClientHelperConnectOutcome,
  type ClientHelperListener,
  type ClientHelperProcess,
} from "./client/process.js";
import type { ClientHelperLinkState } from "./client/messages.js";
import { NOT_CONNECTED_MESSAGE, unlinkedState, type DaemonLink } from "./link/status.js";
import type { ServiceExit, StartedService } from "./service/start.js";

const LOG_SOURCE = "main/services/daemon";

/** What the supervisor reaches the service through, and where it records what went wrong. */
export interface DaemonSupervisorOptions {
  /** Where the supervisor publishes the service's state and the connected client. */
  readonly link: DaemonLink;
  /**
   * The client helper, which holds the one connection to the service and runs the client's
   * ending and its process identity reads.
   */
  readonly helper: Pick<
    ClientHelperProcess,
    | "connect"
    | "closeLink"
    | "dispose"
    | "listen"
    | "call"
    | "subscribe"
    | "facts"
    | "endDaemon"
    | "endDaemonProcess"
    | "readProcessIdentity"
  >;
  /** Starts the service detached; rejects when it cannot start. */
  readonly startService: () => Promise<StartedService>;
  /** The fact the service's status file holds; `undefined` when it wrote none. */
  readonly readServiceStatus: () => Promise<ServiceStatusFile | undefined>;
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

/** One link that is up: the service process it reaches, and what its handshake settled. */
interface CurrentLink {
  /** Absent only for a service that would not name its process, which this app did not start. */
  readonly identity: ProcessIdentity | undefined;
}

/** Main's supervisor of the background service. */
export class DaemonSupervisor implements ClientHelperListener {
  readonly #link: DaemonLink;
  readonly #helper: DaemonSupervisorOptions["helper"];
  readonly #options: DaemonSupervisorOptions;
  readonly #log: Pick<MainDiagnosticLog, "write">;
  #phase: SupervisorPhase = "idle";
  #current: CurrentLink | undefined;
  /** The service this app started last, while it has not been seen to exit. */
  #startedService: StartedService | undefined;
  /** An ending under way; the next start waits it out, so the service can take the data folder. */
  #ending: Promise<void> | undefined;
  #consecutiveFailedStarts = 0;
  /** Waits taken since the last link, loss or `Retry`; each start after one takes the next. */
  #startWaitsInARow = 0;
  /** Whether a link has been lost since the service last answered, so starts read as a return. */
  #isBringingBack = false;
  #lastError: string | undefined;
  #isStopRequested = false;
  /** Why the service cannot start, as its status file or the last connect's failure said. */
  #cannotStart: MainProcessState["cannotStart"];
  /** Why the service cannot start, as the last failed connect of a start said. */
  #connectCannotStart: DaemonCannotStart | undefined;
  /** Why the person's last `Stop` did not happen. */
  #cannotStop: ServiceCannotStop | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: DaemonSupervisorOptions) {
    this.#options = options;
    this.#link = options.link;
    this.#helper = options.helper;
    options.helper.listen(this);
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
    this.#cannotStop = undefined;
    // A fresh start reads as one, not as the return of a link lost before it.
    this.#isBringingBack = false;
    void this.#attemptStart();
  }

  /**
   * The service stopped answering or the link is down: the service is ended as one that stopped
   * answering, unless an ending is already under way, and main brings it back through its own
   * start. A link the client is bringing back after its socket dropped is left to the client.
   */
  public linkStateChanged(state: ClientHelperLinkState): void {
    if (this.#phase !== "linked" || (state !== "silent" && state !== "down")) {
      return;
    }
    const identity = this.#current?.identity;
    this.#helper.closeLink();
    if (identity !== undefined && this.#ending === undefined) {
      this.#endProcess(identity);
    }
    this.#linkLost(`the link reported ${state}`);
  }

  /** A starting service answered that it is repairing its database file. */
  public repairing(details: DaemonRepairingDetails): void {
    if (!this.#isBringingBack && this.#phase === "starting") {
      this.#reportUnlinked({ kind: "repairing", progress: details.progress });
    }
  }

  /** The helper exited: a link it held is lost, and the next start forks it again. */
  public exited(): void {
    if (this.#phase === "linked") {
      this.#linkLost("the client helper exited");
    }
  }

  /**
   * The person's `Stop` or `Restart`, through the client's ending, whether this app started the
   * service or found it running. After a stop the loss that follows reads as stopped and nothing
   * starts the service again until `requestStart`; after a restart the loss is brought back once
   * the old service has ended. A stop that did not happen is put on the link as `cannotStop`, read
   * from the status file or from the ending's own error. Resolves with the end that took effect;
   * rejects when no link is up, and with a {@link DaemonRefusal} when the ending failed.
   */
  public async endService(method: ServiceEndingMethod): Promise<DaemonEnded> {
    if (this.#current === undefined) {
      throw new Error(NOT_CONNECTED_MESSAGE);
    }
    const isStop = method === "daemon.stop";
    // Set before anything is sent, so a loss landing before the ending settles reads as the stop.
    this.#isStopRequested = isStop;
    this.#cannotStop = undefined;
    const ending = this.#helper.endDaemon(isStop ? "stop" : "restart");
    this.#trackEnding(ending.then(() => undefined));
    let outcome: DaemonEndingOutcome;
    try {
      outcome = await ending;
    } catch (failure) {
      // The helper answered that no ending ran, so a later loss is not the person's stop. An ending
      // its exit cut short may have stopped the service, and the loss that follows still reads so.
      if (failure instanceof ServiceAskFailed) {
        this.#isStopRequested = false;
      }
      throw failure;
    }
    if (isStop) {
      await this.#readCannotStop(outcome.error as JsonRpcError | undefined);
    }
    if (outcome.end === undefined) {
      // The ending failed: the service may still run, and its link with it.
      this.#isStopRequested = false;
      throw new DaemonRefusal(outcome.error as JsonRpcError);
    }
    return outcome.end;
  }

  /**
   * The quit: send `daemon.flush` alone and wait for its answer, and for an ending still under
   * way, then let the service go as `dispose` does. A refusal is an answer; with no link up there
   * is nothing to flush. The quit's own wait bounds both. Nothing starts once the quit begins, so
   * a `Restart` the quit interrupts leaves no new service.
   */
  public async flushAtQuit(): Promise<void> {
    this.#phase = "quitting";
    this.#clearRetry();
    try {
      if (this.#current !== undefined) {
        await flushService(this.#helper);
      }
    } finally {
      // The ending's signals are due while main runs, whatever the flush did; a quit before them
      // would leave a hung service running.
      await this.#ending;
      await this.dispose();
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
    await this.#ending;
    if (this.#isLettingGo()) {
      return;
    }
    let initializeResponse: ConnectionInitializeResponse;
    try {
      initializeResponse = await this.#connectOrStart();
    } catch (failure) {
      await this.#readCannotStart();
      this.#startFailed(failure);
      return;
    }
    const started = this.#liveStartedService();
    let identity: ProcessIdentity | undefined;
    try {
      // The helper reported its bounds before it connected.
      const { handshakeDeadlineMs } = await this.#helper.facts();
      // Bounded by the handshake deadline, so a service that answers it and then nothing fails.
      const linked = await settleWithin(this.#linkedIdentity(started), handshakeDeadlineMs);
      if (!linked.isSettled) {
        throw new Error(
          `The background service did not answer daemon.status.read within ` +
            `${String(handshakeDeadlineMs / 1000)} seconds`,
        );
      }
      identity = linked.value;
    } catch (readFailure) {
      this.#helper.closeLink();
      // One this app started is ended, so the next start does not meet it on the socket again.
      this.#endStartedService();
      this.#startFailed(readFailure);
      return;
    }
    if (this.#isLettingGo()) {
      this.#helper.closeLink();
      return;
    }
    this.#current = { identity };
    this.#phase = "linked";
    this.#consecutiveFailedStarts = 0;
    this.#startWaitsInARow = 0;
    this.#isBringingBack = false;
    this.#cannotStart = undefined;
    this.#cannotStop = undefined;
    const negotiation = negotiationOf(initializeResponse);
    this.#log.write({
      level: "notice",
      source: LOG_SOURCE,
      message: negotiation.compatible
        ? "The link to the background service is up."
        : `The link to the background service is up and serves reads alone: ${String(negotiation.reason)}.`,
    });
    this.#link.attach(this.#helper, {
      ...this.#stateOf(
        negotiation.compatible ? { kind: "connected" } : { kind: "version_incompatible" },
      ),
      negotiation,
      startedByApp:
        started !== undefined && identity !== undefined && identity.processId === started.processId,
    });
  }

  /**
   * Connect to a running service, or start one when no socket answers and wait for it. A service
   * found on its socket that is still writing its token, or is repairing its database file, is
   * waited for and never started over. Rejects with the connect's refusal, or with how a started
   * service exited before it answered.
   */
  async #connectOrStart(): Promise<ConnectionInitializeResponse> {
    this.#connectCannotStart = undefined;
    const probe = await this.#helper.connect(false);
    if (!("error" in probe)) {
      return probe.initializeResponse;
    }
    if (!isNoService(probe.error)) {
      if (probe.error.data?.type === DAEMON_REPAIRING_CODE && !this.#isBringingBack) {
        this.#reportUnlinked({ kind: "repairing", progress: this.#repairProgressOf(probe.error) });
      }
      return this.#linkedOrThrow(await this.#helper.connect(true));
    }
    // A quit that began while the probe ran starts nothing.
    if (this.#isLettingGo()) {
      throw new Error("The app is quitting.");
    }
    if (!this.#isBringingBack) {
      this.#reportUnlinked({ kind: "starting" });
    }
    const started = await this.#options.startService();
    this.#startedService = started;
    const exitedFirst = started.whenExited().then((exit) => {
      throw new Error(
        `The background service exited before it answered its connect (${describeExit(exit)})`,
      );
    });
    // An exit after the link is up is the link's loss, which the helper reports.
    exitedFirst.catch(() => undefined);
    let waited: ClientHelperConnectOutcome;
    try {
      waited = await Promise.race([this.#helper.connect(true), exitedFirst]);
    } catch (failure) {
      this.#helper.closeLink();
      throw failure;
    }
    if ("error" in waited) {
      // Still running once the client's wait ran out, it would hold the socket against every
      // later start.
      this.#endStartedService();
    }
    return this.#linkedOrThrow(waited);
  }

  /**
   * The handshake answer of a connect that linked; rejects with the refusal of one that did not,
   * keeping why the service cannot start when the failure says.
   */
  #linkedOrThrow(outcome: ClientHelperConnectOutcome): ConnectionInitializeResponse {
    if ("error" in outcome) {
      this.#connectCannotStart = outcome.cannotStart;
      throw new DaemonRefusal(outcome.error);
    }
    return outcome.initializeResponse;
  }

  /**
   * The identity of the process behind a link that just came up, as the service reports it. When
   * the service does not name its process, only the one this app started is known.
   */
  async #linkedIdentity(started: StartedService | undefined): Promise<ProcessIdentity | undefined> {
    try {
      const { processIdentity } = await this.#helper.call(
        DAEMON_STATUS_METHOD_DESCRIPTORS["daemon.status.read"],
        {},
      );
      return processIdentity;
    } catch (failure) {
      this.#log.write({
        level: "warning",
        source: LOG_SOURCE,
        message: "The background service did not name its process: " + describeFailure(failure),
      });
      return started === undefined
        ? undefined
        : await this.#helper.readProcessIdentity(started.processId);
    }
  }

  /**
   * The count a repairing answer carries, read from its fields. Fields the app cannot read are
   * logged, and the repair is reported without a count.
   */
  #repairProgressOf(refusal: JsonRpcError): DaemonRepairProgress | undefined {
    const fields: unknown = refusal.data?.fields ?? {};
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
      this.#link.detach(this.#stateOf({ kind: "stopped" }));
      return;
    }
    this.#isBringingBack = true;
    this.#consecutiveFailedStarts = 0;
    this.#startWaitsInARow = 0;
    this.#link.detach(this.#stateOf(this.#returningConnection()));
    this.#scheduleStart();
  }

  /** The service this app started, while it has not been seen to exit. */
  #liveStartedService(): StartedService | undefined {
    const started = this.#startedService;
    return started !== undefined && !started.hasExited() ? started : undefined;
  }

  /**
   * End the service this app started, if it still runs, as one that never answered. The ending is
   * held from now, its identity read included, so the next start waits for both.
   */
  #endStartedService(): void {
    const started = this.#liveStartedService();
    if (started === undefined) {
      return;
    }
    this.#trackEnding(
      this.#helper.readProcessIdentity(started.processId).then(async (identity) => {
        if (identity !== undefined) {
          await this.#endingOf(identity);
        }
      }),
    );
  }

  /** End the service process `identity` names at once; the next start waits for it. */
  #endProcess(identity: ProcessIdentity): void {
    this.#trackEnding(this.#endingOf(identity));
  }

  /** The helper's ending of the process `identity` names; an ending that failed is logged. */
  async #endingOf(identity: ProcessIdentity): Promise<void> {
    const outcome = await this.#helper.endDaemonProcess(identity);
    if (outcome.error !== undefined) {
      this.#logEndingFailure((outcome.error as JsonRpcError).message);
    }
  }

  /** Hold `ending` until it settles, so the next start and the quit wait for it; logs a failure. */
  #trackEnding(ending: Promise<void>): void {
    const tracked = ending.then(
      () => undefined,
      (failure: unknown) => {
        this.#logEndingFailure(failure);
      },
    );
    this.#ending = tracked;
    void tracked.then(() => {
      if (this.#ending === tracked) {
        this.#ending = undefined;
      }
    });
  }

  #logEndingFailure(failure: unknown): void {
    this.#log.write({
      level: "error",
      source: LOG_SOURCE,
      message: `Ending the background service failed: ${typeof failure === "string" ? failure : describeFailure(failure)}`,
    });
  }

  /**
   * After a `Stop`, why it did not happen, put on the link: the status file's `cannotStop`, the
   * step it says was still running when the ending failed, or the ending's own error.
   */
  async #readCannotStop(endingError: JsonRpcError | undefined): Promise<void> {
    const status = await this.#readStatusFile();
    if (status !== undefined && "cannotStop" in status) {
      this.#cannotStop = status.cannotStop;
    } else if (endingError !== undefined) {
      this.#cannotStop =
        status !== undefined && "stopping" in status
          ? { reason: "stillStopping", step: status.stopping.step }
          : { reason: "notEnded", error: endingError.message };
    }
    if (this.#cannotStop !== undefined) {
      this.#link.report({ ...this.#link.state, cannotStop: this.#cannotStop });
    }
  }

  /**
   * Why the service cannot start, kept for every state reported: as its status file says, or else
   * as the start's failed connect said.
   */
  async #readCannotStart(): Promise<void> {
    const status = await this.#readStatusFile();
    this.#cannotStart =
      status !== undefined && "cannotStart" in status
        ? status.cannotStart
        : this.#connectCannotStart;
  }

  /** The status file's fact; a file that cannot be read counts as none, and is logged. */
  async #readStatusFile(): Promise<ServiceStatusFile | undefined> {
    try {
      return await this.#options.readServiceStatus();
    } catch (failure) {
      this.#log.write({
        level: "warning",
        source: LOG_SOURCE,
        message: `The background service's status file could not be read: ${describeFailure(failure)}`,
      });
      return undefined;
    }
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
    // Saved sessions the service cannot open stay so until the person acts, so it is not started
    // again until `Retry`.
    if (
      this.#consecutiveFailedStarts >= SERVICE_START_BACKOFF_MS.length ||
      isOverSavedSessions(this.#cannotStart)
    ) {
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
    } else if (this.#cannotStart !== undefined) {
      this.#reportUnlinked(this.#link.state.connection);
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

  /** The state of `connection` with no service linked, and what the status file said. */
  #stateOf(connection: DaemonConnection): MainProcessState {
    return {
      ...unlinkedState(connection),
      cannotStart: this.#cannotStart,
      cannotStop: this.#cannotStop,
    };
  }

  #reportUnlinked(connection: DaemonConnection): void {
    this.#link.report(this.#stateOf(connection));
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

/** What the handshake settled, as the status topic carries it. */
function negotiationOf(response: ConnectionInitializeResponse): MainProcessNegotiation {
  return {
    compatible: response.compatible,
    deviceId: response.deviceId,
    daemonProtocolVersion: response.protocolVersion,
    appProtocolVersion: CURRENT_PROTOCOL_VERSION,
    daemonSupportedProtocols: response.daemonSupportedProtocols ?? [],
    reason: response.reason,
    // Too old for the service is the app's update to make; too new is the service's.
    behind:
      response.reason === NEGOTIATION_REASON_FLOOR_EXCEEDED
        ? "app"
        : response.reason === NEGOTIATION_REASON_CEILING_EXCEEDED
          ? "service"
          : undefined,
  };
}

/** Whether the service cannot start over its saved sessions, which no later start mends. */
function isOverSavedSessions(cannotStart: DaemonCannotStart | undefined): boolean {
  return (
    cannotStart?.reason === "savedSessionsUnrepaired" ||
    cannotStart?.reason === "savedSessionsFromAnotherVersion"
  );
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
function isNoService(refusal: JsonRpcError): boolean {
  return refusal.data?.type === CONNECTION_UNAVAILABLE_CODE;
}

function describeExit(exit: ServiceExit): string {
  if (exit.signal !== null) {
    return signalWords(exit.signal);
  }
  return exit.code === null ? "how it ended is unknown" : `exit code ${String(exit.code)}`;
}
