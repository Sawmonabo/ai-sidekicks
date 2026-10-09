// One Codex service: the `codex app-server --listen` process for one credential home, started as
// the daemon's child (or, on the person's own home, the service already there), the connection
// the daemon holds on it, and what happens when either ends on its own. A process that exits is a
// crash, restarted on the crash window's waits; a connection that drops is a reconnect.

import { DAEMON_STOP_TERMINAL_DRAIN_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { parseCliVersionReport } from "../../../capability/refresh.js";
import { CrashWindow } from "../../../../crash-window.js";
import { assertValidCliVersionReport } from "../../../output-validation.js";
import { buildProviderSpawnEnv, type SpawnEnvPair } from "../../../spawn-env.js";
import {
  DEFAULT_PROVIDER_VERSION_CLIENT_NAME,
  resolveProviderExecutable,
  type SpawnedProviderVersionReading,
} from "../../../spawned-version.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import { CODEX_DRIVER_DESCRIPTOR } from "../descriptor.js";
import { reportCodexFrameOutsideTable } from "../event-normalizer.js";
import type { CodexAskKind, CodexServerRequestAnswer } from "../server-requests.js";
import {
  CodexProviderRequestError,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "../session/errors.js";
import {
  CODEX_THREAD_FRAME_ROUTER_CONFIG,
  readCodexChildThreadAnnouncement,
  readCodexFrameThreadId,
} from "../session/state.js";
import {
  type CodexAppServerConnection,
  type CodexForgottenRequest,
  defaultScheduleTimeout,
  openCodexConnection,
} from "../transport/connection.js";
import {
  type CodexScheduleTimeout,
  type CodexTransportDiagnostic,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import {
  CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD,
  type CodexRateLimitObservation,
  observeCodexRateLimitUpdate,
} from "../usage-limit-signal.js";
import { composeCodexServiceArguments } from "./command-line.js";
import type { CodexServiceDependencies, CodexServiceHome } from "./dependencies.js";
import type { CodexServiceProcess } from "./process.js";
import { CodexServiceAsks } from "./asks.js";
import { CodexConfigWarnings } from "./config-warnings.js";
import { CodexServiceThreads } from "./threads.js";
import { trustCodexDaemonHooks } from "./trust.js";

/** Deadline from a service start to its `initialize` answer. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

// Codex bounds its models fetch at 5 s (`MODELS_REFRESH_TIMEOUT`,
// `codex-rs/model-provider/src/models_endpoint.rs`); the rest is the measured start of
// `codex debug models`, at most 119.5 ms over 20 signed-out runs.
const CODEX_CATALOG_READ_DEADLINE_MS = 5_120;

// Lifecycle broadcasts every connection sees for every conversation on the service, including
// ones no session here holds (the person's own, or a throwaway title thread); never a fault.
const CODEX_UNHELD_THREAD_BROADCASTS: ReadonlySet<string> = new Set([
  "thread/started",
  "thread/closed",
]);

/** Sent once a conversation is unloaded, so another service may take it. */
const CODEX_THREAD_CLOSED_METHOD = "thread/closed";

/** The service-wide config warning, which names no thread and goes to every session. */
export const CODEX_CONFIG_WARNING_METHOD = "configWarning";

// The refusals that mean the connection must be dropped and opened again: an overloaded service
// and one that is draining.
const CODEX_OVERLOADED_ERROR_CODE = -32001;
const CODEX_DRAINING_MESSAGE = "Server is draining";

type CodexServiceState = "stopped" | "starting" | "up" | "recovering" | "crash-loop" | "stopping";

/**
 * One Codex service and the daemon's connection on it. Its conversations' sessions are kept in
 * {@link CodexService.threads}; its frames reach them through the driver's events.
 */
export class CodexService {
  readonly home: CodexServiceHome;
  /** Which session each conversation on this service belongs to. */
  readonly threads: CodexServiceThreads = new CodexServiceThreads(
    CODEX_THREAD_FRAME_ROUTER_CONFIG.maxPendingHoldFrames,
  );
  /** The config warnings the service sent, and which sessions were told each. */
  readonly configWarnings: CodexConfigWarnings = new CodexConfigWarnings();
  readonly #dependencies: CodexServiceDependencies;
  readonly #scheduleTimeout: CodexScheduleTimeout;
  readonly #now: () => number;
  readonly #crashWindow = new CrashWindow();
  readonly #asks: CodexServiceAsks;
  #state: CodexServiceState = "stopped";
  #starting: Promise<void> | null = null;
  #process: CodexServiceProcess | null = null;
  #connection: CodexAppServerConnection | null = null;
  #versionReading: SpawnedProviderVersionReading | null = null;
  // The account's rate-limit readings this service has seen, which a failed turn's usage limit
  // is read from; the account outlives a connection, so a reconnect keeps them.
  #rateLimitObservation: CodexRateLimitObservation = { latestRead: null, rollingUpdate: null };
  // Every start and reconnect takes a new generation, so a continuation from an older one stands
  // down instead of acting on a newer connection.
  #generation = 0;
  // Set by a stop the daemon asked for, so a restart already waiting stands down.
  #isStopRequested = false;
  // Set once the daemon shuts the service down; nothing starts it again.
  #isShutDown = false;
  // Ends the wait before a crash restart early, so a stop need not wait it out.
  #wakeRestartWait: (() => void) | null = null;
  readonly #closedWaiters = new Map<string, (() => void)[]>();
  // The `codex debug models` read in flight, which every caller meanwhile shares.
  #catalogDumpRead: Promise<string> | null = null;

  constructor(dependencies: CodexServiceDependencies) {
    this.home = dependencies.home;
    this.#dependencies = dependencies;
    this.#scheduleTimeout = dependencies.scheduleTimeout ?? defaultScheduleTimeout;
    this.#now = dependencies.now ?? Date.now;
    this.#asks = new CodexServiceAsks({
      threads: this.threads,
      responderFor: (sessionId) => dependencies.events.responderFor(sessionId),
      onHeldRequestsDropped: (sessionId, dropped) => {
        dependencies.events.onHeldRequestsDropped(sessionId, dropped);
      },
      reportDiagnostic: dependencies.reportDiagnostic,
    });
  }

  /** The build the running service reported, with the executable resolved at its start. */
  get versionReading(): SpawnedProviderVersionReading | undefined {
    return this.#versionReading ?? undefined;
  }

  /** Whether the service runs and its connection is open. */
  get isRunning(): boolean {
    return this.#state === "up";
  }

  /** Whether the service runs the daemon's hooks, which hold a paused run's next tool call. */
  get runsDaemonHooks(): boolean {
    return this.home.isManaged && this.#dependencies.hooks !== undefined;
  }

  /** The account's rate-limit readings this service has seen so far. */
  get rateLimitObservation(): CodexRateLimitObservation {
    return this.#rateLimitObservation;
  }

  /**
   * Starts the service, or connects to the person's own, once; concurrent callers share the
   * start, and a restart or reconnect already under way is waited for. Throws
   * `CodexTransportError` while the service is down after a crash loop, and the start's failure.
   */
  async ensureStarted(): Promise<void> {
    while (this.#starting !== null) {
      await this.#starting;
    }
    if (this.#state === "up") {
      return;
    }
    if (this.#state === "crash-loop") {
      throw new CodexTransportError(
        "The Codex service ended too many times in a short window and was not restarted.",
        { codexHome: this.home.codexHome },
      );
    }
    if (this.#isShutDown) {
      throw new CodexTransportError("The Codex service was shut down with the daemon.", {
        codexHome: this.home.codexHome,
      });
    }
    this.#isStopRequested = false;
    await this.#track(this.#start());
  }

  /**
   * Sends one request on the current connection. A refusal that asks for a new connection drops
   * this one, which reconnects and resumes; the refusal still reaches the caller.
   */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const connection = this.#requireConnection(method);
    try {
      return await connection.request(method, params, timeoutMs);
    } catch (cause) {
      if (asksForReconnect(cause)) {
        this.#handleDropped(connection, normalizeProviderFailureDetail(cause));
      }
      throw cause;
    }
  }

  /** Answers an ask a session's responder held. Throws when this service holds no such ask. */
  async answerHeldRequest(requestId: string, answer: CodexServerRequestAnswer): Promise<void> {
    await this.#requireConnection("respond").answerHeldRequest(requestId, answer);
  }

  /**
   * Opens a second connection on the running service that has started no conversation, for a
   * read that must not touch one, such as the capability probe. The caller closes it.
   */
  async openDetachedConnection(): Promise<CodexAppServerConnection> {
    await this.ensureStarted();
    const startupTimeoutMs = this.#dependencies.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const abort = this.#abortAfterStartupDeadline(startupTimeoutMs);
    try {
      const opened = await openCodexConnection({
        connectSocket: this.#dependencies.connectSocket,
        socketPath: this.#dependencies.socketPath,
        dialOptions: { awaitSocket: false, codexHome: this.home.codexHome, signal: abort.signal },
        options: {
          reportDiagnostic: this.#dependencies.reportDiagnostic,
          scheduleTimeout: this.#scheduleTimeout,
          requestTimeoutMs: this.#dependencies.requestTimeoutMs,
        },
        handlers: {
          // Nothing on this connection belongs to a session.
          onServerNotification: (method) => {
            this.#reportQuietly({ kind: "unconsumed-server-notification", method });
          },
          serverRequestResponder: undefined,
          // A drop fails the reads in flight on it, which is all it carries.
          onDropped: () => undefined,
          onHeldRequestsDropped: () => undefined,
        },
        handshakeTimeoutMs: startupTimeoutMs,
      });
      return opened.connection;
    } finally {
      abort.cancelDeadline();
    }
  }

  /**
   * The model catalog of this service's home, as `codex debug models` prints it, run by the Codex
   * command the daemon resolved at the service's start: the build the service runs when the daemon
   * started it, and on the person's own service, which the daemon only joins, the daemon's
   * configured build, which may differ from the one running. Calls made while a read runs share
   * it; nothing is kept once it settles. Throws when the command fails.
   */
  async readModelCatalogDump(): Promise<string> {
    this.#catalogDumpRead ??= this.#runCatalogDump().finally(() => {
      this.#catalogDumpRead = null;
    });
    return await this.#catalogDumpRead;
  }

  async #runCatalogDump(): Promise<string> {
    await this.ensureStarted();
    const reading = this.#versionReading;
    if (reading === null) {
      throw new Error("The Codex service has not started, so its catalog cannot be read.");
    }
    return await this.#dependencies.runCommand(
      {
        command: reading.resolvedExecutablePath,
        args: ["debug", "models"],
        environment: this.#spawnEnvironment(),
        workingDirectory: this.home.codexHome,
      },
      CODEX_CATALOG_READ_DEADLINE_MS,
    );
  }

  /** Whether this service holds the ask `requestId` for the person. */
  holdsRequest(requestId: string): boolean {
    return this.#connection?.holdsRequest(requestId) ?? false;
  }

  /**
   * Lets go of a held ask Codex settled itself, so no answer is sent for it later. Answers the
   * kind of ask it was, or `undefined` when none was held under `requestId`.
   */
  forgetHeldRequest(requestId: string): CodexAskKind | undefined {
    return this.#connection?.forgetHeldRequest(requestId);
  }

  /** Lets go of every held ask a turn that ended made; see the connection's own docs. */
  forgetHeldRequestsOfTurn(threadId: string, turnId: string): CodexForgottenRequest[] {
    return this.#connection?.forgetHeldRequestsOfTurn(threadId, turnId) ?? [];
  }

  /**
   * Restarts the service on purpose: a managed service is stopped and started on the command
   * resolved now; the person's own is connected to again. The caller resumes the conversations.
   */
  async restart(): Promise<void> {
    while (this.#starting !== null) {
      await this.#starting;
    }
    await this.stop();
    await this.ensureStarted();
  }

  /**
   * Forgets the crash window and leaves a crash loop, so the next start goes ahead; the person's
   * restart does this.
   */
  clearCrashWindow(): void {
    this.#crashWindow.clear();
    if (this.#state === "crash-loop") {
      this.#state = "stopped";
    }
  }

  /** Stops the service once it holds no conversation; the person's own is only disconnected. */
  async stop(): Promise<void> {
    this.#isStopRequested = true;
    this.#wakeRestartWait?.();
    await this.#teardown();
  }

  /**
   * Stops the service for good as the daemon stops, as {@link stop} does, and resolves once a
   * start, reconnect or restart under way has stood down too; nothing starts it again. Idempotent.
   */
  async shutdown(): Promise<void> {
    this.#isShutDown = true;
    await this.stop();
    while (this.#starting !== null) {
      // The start's own caller receives its failure; here only its end is waited for.
      await this.#starting.catch(() => undefined);
    }
  }

  async #teardown(): Promise<void> {
    this.#state = "stopping";
    this.#generation += 1;
    this.#connection?.close();
    this.#connection = null;
    this.#settleClosedWaiters(undefined);
    const serviceProcess = this.#process;
    if (serviceProcess !== null) {
      serviceProcess.stop();
      // A process that ignores the stop is killed once the wait a stopping daemon gives its
      // children runs out.
      const cancelKill = this.#scheduleTimeout(() => {
        serviceProcess.kill();
      }, DAEMON_STOP_TERMINAL_DRAIN_MS);
      try {
        await serviceProcess.exited;
      } catch (cause) {
        this.#reportQuietly({
          kind: "teardown-step-failed",
          step: "service-stop",
          detail: normalizeProviderFailureDetail(cause),
        });
      } finally {
        cancelKill();
      }
      this.#process = null;
    }
    this.#state = "stopped";
  }

  /**
   * `closed` settles once Codex sends `threadId`'s `thread/closed`, or once this connection ends,
   * which unloads it too; `stopWaiting` drops a wait no longer needed. Armed before the step that
   * leads to the close, so the notice cannot come first.
   */
  waitForThreadClosed(threadId: string): { closed: Promise<void>; stopWaiting: () => void } {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#closedWaiters.set(threadId, [...(this.#closedWaiters.get(threadId) ?? []), resolve]);
    return {
      closed: promise,
      stopWaiting: () => {
        const remaining = (this.#closedWaiters.get(threadId) ?? []).filter(
          (waiter) => waiter !== resolve,
        );
        if (remaining.length === 0) {
          this.#closedWaiters.delete(threadId);
        } else {
          this.#closedWaiters.set(threadId, remaining);
        }
      },
    };
  }

  /** Opens a claim on the thread a start or fork in flight is about to name; see the index. */
  beginThreadClaim(): () => void {
    const closeClaim = this.threads.beginClaim();
    return () => {
      for (const unclaimed of closeClaim()) {
        this.#reportQuietly({
          kind: "unrouted-thread-frame",
          method: unclaimed.method,
          threadId: unclaimed.threadId,
        });
      }
    };
  }

  /** Records a thread as a session's and delivers the frames held for it. */
  registerThread(threadId: string, sessionId: SessionId): void {
    for (const held of this.threads.register(threadId, sessionId)) {
      this.#deliver(sessionId, held.method, held.params);
    }
  }

  async #start(): Promise<void> {
    this.#state = "starting";
    this.#generation += 1;
    const generation = this.#generation;
    const environment = this.#spawnEnvironment();
    try {
      // Resolved at every start, so a relaunch runs what the command names now.
      const executable = await resolveProviderExecutable(
        CODEX_DRIVER_NAME,
        await this.#dependencies.providerCommand(),
        environment,
        this.#dependencies.executableResolver ?? {},
      );
      const hooks = this.home.isManaged ? this.#dependencies.hooks : undefined;
      // Listening before the service starts, so no hook it runs finds the daemon away.
      await hooks?.listen();
      // A stop while the command was read leaves nothing to launch.
      this.#assertCurrent(generation);
      if (this.home.isManaged) {
        this.#launch(executable.resolvedExecutablePath, environment);
      }
      const opened = await this.#connect(generation);
      this.#versionReading = {
        driverName: CODEX_DRIVER_NAME,
        resolvedExecutablePath: executable.resolvedExecutablePath,
        report: readServiceVersion(opened.initializeReply),
      };
      if (hooks !== undefined) {
        // Before any conversation starts, forks or resumes: an untrusted hook never runs.
        await trustCodexDaemonHooks(
          (method, params) => opened.connection.request(method, params),
          hooks.commands,
        );
      }
      this.#state = "up";
    } catch (cause) {
      await this.#teardown();
      throw cause;
    }
  }

  #spawnEnvironment(): readonly SpawnEnvPair[] {
    return buildProviderSpawnEnv({
      driverName: CODEX_DRIVER_NAME,
      baseEnv: this.#dependencies.providerBaseEnvironment,
      hostEnvNameMatch: this.#dependencies.environmentNameMatch,
      ...(this.home.isManaged ? { codexHome: this.home.codexHome } : {}),
    });
  }

  /** Keeps `work` as the start in flight until it settles, so callers wait for it. */
  #track(work: Promise<void>): Promise<void> {
    const tracked: Promise<void> = work.finally(() => {
      if (this.#starting === tracked) {
        this.#starting = null;
      }
    });
    this.#starting = tracked;
    return tracked;
  }

  #launch(executablePath: string, environment: readonly SpawnEnvPair[]): void {
    const serviceProcess = this.#dependencies.launchProcess({
      command: executablePath,
      args: composeCodexServiceArguments({
        listenAddress: this.#dependencies.listenAddress,
        hookCommands: this.#dependencies.hooks?.commands,
        additionalConfigOverrides: this.#dependencies.additionalConfigOverrides,
      }),
      environment,
      workingDirectory: this.home.codexHome,
    });
    this.#process = serviceProcess;
    void serviceProcess.exited.then(
      (exit) => {
        this.#handleProcessExit(serviceProcess, exit);
      },
      (cause: unknown) => {
        this.#reportQuietly({
          kind: "service-start-failed",
          codexHome: this.home.codexHome,
          detail: normalizeProviderFailureDetail(cause),
        });
      },
    );
  }

  /** Opens the connection, bounded by the startup deadline and by the process ending first. */
  async #connect(
    generation: number,
  ): Promise<{ connection: CodexAppServerConnection; initializeReply: unknown }> {
    const startupTimeoutMs = this.#dependencies.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const abort = this.#abortAfterStartupDeadline(startupTimeoutMs);
    // Marked handled: the process's own end is handled where it was launched.
    void this.#process?.exited.then(
      (exit) => {
        abort.abort(
          new CodexTransportError("The Codex service ended before it answered.", {
            codexHome: this.home.codexHome,
            outputTail: exit.outputTail,
          }),
        );
      },
      (cause: unknown) => {
        abort.abort(cause);
      },
    );
    // Warnings belong to one connection: the service sends them again to each new one.
    this.configWarnings.startConnection();
    try {
      const opened = await openCodexConnection({
        connectSocket: this.#dependencies.connectSocket,
        socketPath: this.#dependencies.socketPath,
        dialOptions: {
          awaitSocket: this.home.isManaged,
          codexHome: this.home.codexHome,
          signal: abort.signal,
        },
        options: {
          reportDiagnostic: this.#dependencies.reportDiagnostic,
          scheduleTimeout: this.#scheduleTimeout,
          requestTimeoutMs: this.#dependencies.requestTimeoutMs,
        },
        handlers: {
          onServerNotification: (method, params) => {
            this.#route(generation, method, params);
          },
          serverRequestResponder: { answer: (request) => this.#asks.answer(request) },
          onDropped: (detail) => {
            if (this.#generation === generation && this.#connection !== null) {
              this.#handleDropped(this.#connection, detail);
            }
          },
          onHeldRequestsDropped: (dropped) => {
            this.#asks.withdrawDropped(dropped);
          },
        },
        handshakeTimeoutMs: startupTimeoutMs,
      });
      if (abort.signal.aborted) {
        opened.connection.close();
        throw abort.signal.reason;
      }
      if (generation !== this.#generation) {
        // A stop while the connection opened: it must not become the service's.
        opened.connection.close();
        this.#assertCurrent(generation);
      }
      this.#connection = opened.connection;
      return opened;
    } finally {
      abort.cancelDeadline();
    }
  }

  // An abort the startup deadline fires, for a dial and its handshake.
  #abortAfterStartupDeadline(startupTimeoutMs: number): {
    readonly signal: AbortSignal;
    readonly abort: (reason: unknown) => void;
    readonly cancelDeadline: () => void;
  } {
    const controller = new AbortController();
    const cancelDeadline = this.#scheduleTimeout(() => {
      controller.abort(
        new CodexTransportError(
          `The Codex service did not answer within ${startupTimeoutMs}ms of its start.`,
          { codexHome: this.home.codexHome, timeoutMs: String(startupTimeoutMs) },
        ),
      );
    }, startupTimeoutMs);
    return {
      signal: controller.signal,
      abort: (reason) => {
        controller.abort(reason);
      },
      cancelDeadline,
    };
  }

  /** Routes one notification to the session its thread belongs to, or to every session. */
  #route(generation: number, method: string, params: unknown): void {
    if (generation !== this.#generation) {
      return;
    }
    reportCodexFrameOutsideTable(method, this.#dependencies.diagnostics);
    const threadId = readCodexFrameThreadId(method, params);
    if (threadId !== null && method === CODEX_THREAD_CLOSED_METHOD) {
      this.#settleClosedWaiters(threadId);
    }
    if (threadId === null) {
      if (method === CODEX_CONFIG_WARNING_METHOD) {
        // Only the sessions not told it already, so a reconnect repeats nothing.
        for (const sessionId of this.configWarnings.recordWarning(
          params,
          this.threads.sessions(),
        )) {
          this.#deliver(sessionId, method, params);
        }
        return;
      }
      if (method === CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD) {
        this.#rateLimitObservation = observeCodexRateLimitUpdate(
          this.#rateLimitObservation,
          params,
        );
      }
      for (const sessionId of this.threads.sessions()) {
        this.#deliver(sessionId, method, params);
      }
      return;
    }
    this.#registerAnnouncedChild(threadId, params);
    const sessionId = this.threads.sessionFor(threadId);
    if (sessionId !== undefined) {
      this.#deliver(sessionId, method, params);
      return;
    }
    const held = this.threads.hold({ method, params, threadId });
    if (held === "held") {
      return;
    }
    if (held === "not-held") {
      if (!CODEX_UNHELD_THREAD_BROADCASTS.has(method)) {
        this.#reportQuietly({ kind: "unrouted-thread-frame", method, threadId });
      }
      return;
    }
    this.#reportQuietly({
      kind: "pending-thread-frame-dropped",
      method: held.method,
      threadId: held.threadId,
    });
  }

  /** A helper's thread belongs to the session its parent thread does. */
  #registerAnnouncedChild(threadId: string, params: unknown): void {
    if (this.threads.sessionFor(threadId) !== undefined) {
      return;
    }
    const parentThreadId = readCodexChildThreadAnnouncement(params)?.declaredParentThreadId;
    if (parentThreadId === undefined || parentThreadId === null) {
      return;
    }
    const parentSessionId = this.threads.sessionFor(parentThreadId);
    if (parentSessionId !== undefined) {
      this.registerThread(threadId, parentSessionId);
    }
  }

  #deliver(sessionId: SessionId, method: string, params: unknown): void {
    this.#dependencies.events.onSessionFrame(this, sessionId, method, params);
  }

  /** A connection that dropped while its service runs is opened again and its threads resumed. */
  #handleDropped(connection: CodexAppServerConnection, detail: string): void {
    if (this.#connection !== connection || this.#state !== "up") {
      return;
    }
    connection.close();
    this.#connection = null;
    this.#state = "recovering";
    this.#settleClosedWaiters(undefined);
    this.#reportQuietly({
      kind: "service-connection-dropped",
      codexHome: this.home.codexHome,
      detail,
    });
    void this.#track(this.#reconnect());
  }

  async #reconnect(): Promise<void> {
    this.#generation += 1;
    const droppedProcess = this.#process;
    try {
      await this.#connect(this.#generation);
    } catch (cause) {
      // A stop the daemon asked for ended the reconnect; it is no failure.
      if (this.#isStopRequested) {
        return;
      }
      const detail = normalizeProviderFailureDetail(cause);
      // A drop the process's own end caused is that crash, which its exit reports once.
      const isCrash = this.home.isManaged && this.#process !== droppedProcess;
      if (!isCrash) {
        this.#reportQuietly({
          kind: "service-start-failed",
          codexHome: this.home.codexHome,
          detail,
        });
      }
      if (!this.home.isManaged) {
        // The person's own service: nothing here can start it again.
        this.#state = "stopped";
        this.#dependencies.events.onServiceLost(this, detail);
        return;
      }
      // A managed service no connection reaches is ended, and its exit restarts it; one that
      // already ended is restarting, and a process a restart started since is left alone.
      if (droppedProcess !== null && this.#process === droppedProcess) {
        droppedProcess.stop();
        // A process that never started reported that where it was launched.
        await droppedProcess.exited.then(
          () => undefined,
          () => undefined,
        );
      }
      return;
    }
    this.#state = "up";
    this.#dependencies.events.onRecovered(this, "reconnect");
  }

  /** A process that ended on its own is a crash: its turns end, then it restarts or stays down. */
  #handleProcessExit(serviceProcess: CodexServiceProcess, exit: ProcessExit): void {
    if (this.#process !== serviceProcess) {
      return;
    }
    this.#process = null;
    // A stop the daemon asked for, or a start that fails on the exit itself, is no crash.
    if (this.#state === "stopping" || this.#state === "starting") {
      return;
    }
    this.#generation += 1;
    this.#connection?.close();
    this.#connection = null;
    this.#state = "recovering";
    this.#settleClosedWaiters(undefined);
    this.#dependencies.events.onProcessExited(this, exit);
    this.#scheduleRestart(exit);
  }

  #scheduleRestart(exit: ProcessExit): void {
    const outcome = this.#crashWindow.recordCrash(this.#now());
    if ("crashLoop" in outcome) {
      this.#state = "crash-loop";
      this.#dependencies.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        providerAccountId: this.home.providerAccountId,
        kind: "provider_crash_loop",
        rawWireType: null,
        dispositionReason:
          "the Codex service ended on its own too many times in the crash window, so it was " +
          "not restarted",
        details: {
          codexHome: this.home.codexHome,
          ...(exit.signal === undefined ? { exitCode: exit.exitCode } : { signal: exit.signal }),
        },
      });
      this.#dependencies.events.onCrashLoop(this, exit);
      return;
    }
    void this.#track(this.#restartAfter(outcome.restartAfterMs, exit));
  }

  async #restartAfter(delayMs: number, exit: ProcessExit): Promise<void> {
    await new Promise<void>((resolve) => {
      const cancelWait = this.#scheduleTimeout(resolve, delayMs);
      this.#wakeRestartWait = () => {
        cancelWait();
        resolve();
      };
    });
    this.#wakeRestartWait = null;
    if (this.#state !== "recovering" || this.#isStopRequested) {
      return;
    }
    try {
      await this.#start();
    } catch (cause) {
      this.#reportQuietly({
        kind: "service-start-failed",
        codexHome: this.home.codexHome,
        detail: normalizeProviderFailureDetail(cause),
      });
      if (this.#isStopRequested) {
        return;
      }
      // A restart that fails counts as another crash of the same process.
      this.#state = "recovering";
      this.#scheduleRestart(exit);
      return;
    }
    this.#dependencies.events.onRecovered(this, "crash");
  }

  /** Settles the waiters on one thread, or on every thread when `threadId` is `undefined`. */
  #settleClosedWaiters(threadId: string | undefined): void {
    const threadIds = threadId === undefined ? [...this.#closedWaiters.keys()] : [threadId];
    for (const closedThreadId of threadIds) {
      for (const resolve of this.#closedWaiters.get(closedThreadId) ?? []) {
        resolve();
      }
      this.#closedWaiters.delete(closedThreadId);
    }
  }

  // Throws when a stop began since the start or reconnect of `generation`.
  #assertCurrent(generation: number): void {
    if (generation !== this.#generation) {
      throw new CodexTransportError("The Codex service was stopped while it was starting.", {
        codexHome: this.home.codexHome,
      });
    }
  }

  #requireConnection(method: string): CodexAppServerConnection {
    const connection = this.#connection;
    if (connection === null || this.#state !== "up") {
      throw new CodexTransportError(`Cannot send "${method}": the Codex service is not running.`, {
        codexHome: this.home.codexHome,
        state: this.#state,
      });
    }
    return connection;
  }

  #reportQuietly(diagnostic: CodexTransportDiagnostic): void {
    reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, diagnostic);
  }
}

/** Whether a refusal asks for a new connection: an overloaded or draining service. */
function asksForReconnect(cause: unknown): boolean {
  return (
    cause instanceof CodexProviderRequestError &&
    (cause.providerErrorCode === CODEX_OVERLOADED_ERROR_CODE ||
      cause.providerMessage.includes(CODEX_DRAINING_MESSAGE))
  );
}

/** The version the service reported in its `initialize` reply, checked for storage. */
function readServiceVersion(initializeReply: unknown): SpawnedProviderVersionReading["report"] {
  const reading = CODEX_DRIVER_DESCRIPTOR.readReportedVersion(
    initializeReply,
    DEFAULT_PROVIDER_VERSION_CLIENT_NAME,
  );
  const report =
    "unreadableReply" in reading
      ? { rawVersion: reading.unreadableReply }
      : parseCliVersionReport(reading.version);
  assertValidCliVersionReport(CODEX_DRIVER_NAME, report);
  return report;
}
