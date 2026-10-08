// The daemon as a running process. Its start takes the data-folder lock before anything else, so of
// two starts on one data folder only one goes on. It then starts capturing the login shell's
// environment, which providers are built from, and loading the session services' modules; while
// those run, it opens the database, through its writer for writes and a read-only connection for
// reads, starts the search thread, which opens its own read-only connection and the search index,
// building the index again when it cannot serve, while the start goes on, kills the terminal
// children a previous run left running and knows this machine. It builds the terminal host over
// this run's orphan guard, listens on its socket and writes this start's session token once the
// bind has succeeded, then runs its recovery pass, refusing writes until that pass leaves the node
// healthy. A client that reads the previous token in the moment between the bind and the write is
// refused once, and its next read finds this start's token. Its stop, asked for over the socket or
// by a terminate signal, ends it cleanly.

import { randomBytes } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import * as path from "node:path";

import {
  DAEMON_STOP_DRAIN_BOUND_MS,
  DAEMON_STOP_TERMINAL_DRAIN_MS,
  DAEMON_STOP_TERMINAL_HOST_DRAIN_MS,
} from "@ai-sidekicks/contracts/daemon/lifecycle";
import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import type { DaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import type { DaemonProcessState } from "@ai-sidekicks/contracts/daemon/status";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import { MACHINE_SETTINGS_FILE_PATH_SEGMENTS } from "@ai-sidekicks/contracts/machine-settings";
import { DeviceIdSchema } from "@ai-sidekicks/contracts/trust-statement";

import { bootstrap } from "../bootstrap/index.js";
import { waitWithin } from "../bounded-wait.js";
import { withCleanupFailures } from "../cleanup-failures.js";
import {
  closeDatabaseConnections,
  openDatabaseConnections,
  type DatabaseConnections,
} from "../database/connections.js";
import { findBranchPatternRefusal } from "../git/branch-name-pattern.js";
import { InFlightMutations } from "../ipc/in-flight-mutations.js";
import { LocalIpcGateway } from "../ipc/local-gateway.js";
import { ProtocolNegotiator } from "../ipc/protocol-negotiation.js";
import { MethodRegistryImpl } from "../ipc/registry.js";
import { StreamingPrimitive } from "../ipc/streaming-primitive.js";
import { ProviderRegistry } from "../provider/driver/registry.js";
import type { SpawnEnvPair } from "../provider/spawn-env.js";
import type { DrainResult, PtyHost } from "../pty/host/contract.js";
import type { OrphanGuard } from "../pty/orphan/guard.js";
import { describeOrphanSweep, type OrphanSweepResult } from "../pty/orphan/sweep.js";
import { ProjectionRebuildService } from "../recovery/projection-rebuild.js";
import { StartupRecovery } from "../recovery/startup.js";
import { RecoveryStatusTracker } from "../recovery/status.js";
import { RecoveryWriteGate } from "../recovery/write-gate.js";
import { RunEngine } from "../session/run/engine.js";
import { RUNS_PROJECTION } from "../session/run/projection.js";
import { RunStateReader } from "../session/run/read.js";
import { SearchThread } from "../session/search/thread/handle.js";
import { DaemonAlreadyRunningError } from "./already-running-error.js";
import { takeDataFolderLock, type DataFolderLock } from "./data-folder-lock.js";
import { registerLifecycleMethods } from "./lifecycle-methods.js";
import { readOrMintLocalMachine, type LocalMachine } from "./machine/local.js";
import { MachineSettingsFile } from "./machine/settings/file.js";
import { registerMachineSettingsMethods } from "./machine/settings/methods.js";
import type { ProcessTreeUsage } from "./process-tree-usage.js";
import { prepareRunFolder, writeSessionToken } from "./run-folder.js";
import type { registerSessionMethods } from "./session-methods.js";
import { registerStatusMethods } from "./status-methods.js";

const DATABASE_FILE_NAME = "daemon.db";
// The search index's folder, beside the database it is built from.
const SEARCH_INDEX_FOLDER_NAME = "search-index";

// The session token's size: 256 bits from the system's secure random source.
const SESSION_TOKEN_BYTES = 32;

/** The data folder the daemon holds inside `homeDirectory`. */
export function resolveDataFolder(homeDirectory: string): string {
  return path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME);
}

/** What a start needs from the machine it runs on; each is injected so a test can stand in. */
export interface DaemonProcessOptions {
  /** The person's home folder; the data folder is `.ai-sidekicks` inside it. */
  readonly homeDirectory: string;
  /** The run folder the socket and the session token file live in. */
  readonly runFolder: DaemonRunFolder;
  /**
   * Sweeps the data folder's orphan registry of what a previous run left and opens this run's
   * guard over it; called once the data folder is this daemon's alone.
   */
  readonly openOrphanGuard: (
    dataFolder: string,
  ) => Promise<{ guard: OrphanGuard; sweep: OrphanSweepResult }>;
  /** Builds the terminal host over the orphan guard; the daemon drains it at its stop. */
  readonly createPtyHost: (orphanGuard: OrphanGuard) => Pick<PtyHost, "shutdown">;
  /** Reads this machine's friendly name; called only at the first start. */
  readonly readMachineName: () => Promise<string>;
  /**
   * Captures the base environment every provider process is built from. A start that fails before
   * it reads the capture aborts `signal`, with "the start failed" as its reason, and the capture
   * ends at once.
   */
  readonly captureProviderBaseEnvironment: (
    signal: AbortSignal,
  ) => Promise<readonly SpawnEnvPair[]>;
  /** The service's own release version, which the status read reports. */
  readonly serviceVersion: string;
  /** The daemon's own process as the system knows it, which the status read reports. */
  readonly processIdentity: ProcessIdentity;
  /** Reads the daemon's process and every process under it, for the status read. */
  readonly readProcessTreeUsage: () => Promise<ProcessTreeUsage>;
  readonly now: () => Date;
  /** Writes one line to the service log, the daemon's standard error. */
  readonly writeServiceLog: (line: string) => void;
}

/** How a stop ended: cleanly, or with what went wrong in it. */
export type DaemonStopOutcome =
  | { readonly isClean: true }
  | { readonly isClean: false; readonly failure: unknown };

/**
 * A started daemon. A stop, asked for by `stop()` or over the socket, ends it; nothing else does.
 */
export class DaemonProcess {
  /** This machine's id and name, the same at every start. */
  readonly localMachine: LocalMachine;
  /**
   * The environment captured at this start, which every provider process's environment is built
   * from.
   */
  readonly providerBaseEnvironment: readonly SpawnEnvPair[];

  readonly #dataFolderLock: DataFolderLock;
  readonly #database: DatabaseConnections;
  readonly #searchThread: SearchThread;
  readonly #gateway: LocalIpcGateway;
  readonly #inFlightMutations: InFlightMutations;
  readonly #recoveryStatus = new RecoveryStatusTracker();
  readonly #startupRecovery: StartupRecovery;
  // The start's recovery pass, which a stop waits for before the database closes under it.
  #recoveryPass: Promise<void> = Promise.resolve();
  readonly #ptyHost: Pick<PtyHost, "shutdown">;
  readonly #orphanGuard: OrphanGuard;
  readonly #writeServiceLog: (line: string) => void;
  readonly #stopSessionServices: () => Promise<void>;
  readonly #stopOutcome = Promise.withResolvers<DaemonStopOutcome>();
  #processState: DaemonProcessState = "starting";
  #stopping: Promise<void> | undefined;

  private constructor(parts: {
    options: DaemonProcessOptions;
    startedAt: Date;
    dataFolder: string;
    dataFolderLock: DataFolderLock;
    database: DatabaseConnections;
    orphanGuard: OrphanGuard;
    searchThread: SearchThread;
    localMachine: LocalMachine;
    providerBaseEnvironment: readonly SpawnEnvPair[];
    sessionToken: string;
    registerSessionMethods: typeof registerSessionMethods;
  }) {
    const { options } = parts;
    this.localMachine = parts.localMachine;
    this.providerBaseEnvironment = parts.providerBaseEnvironment;
    this.#dataFolderLock = parts.dataFolderLock;
    this.#database = parts.database;
    this.#orphanGuard = parts.orphanGuard;
    this.#searchThread = parts.searchThread;
    this.#ptyHost = options.createPtyHost(parts.orphanGuard);
    this.#writeServiceLog = options.writeServiceLog;

    // The negotiation gate wraps the recovery gate, which wraps the recording registry, so a
    // refused call is never recorded.
    this.#inFlightMutations = new InFlightMutations();
    const negotiator = new ProtocolNegotiator(parts.sessionToken);
    const writeGate = new RecoveryWriteGate(() => this.#recoveryStatus.readOverall());
    const registry = negotiator.wrap(
      writeGate.wrap(this.#inFlightMutations.wrap(new MethodRegistryImpl())),
    );
    negotiator.registerHandshakeMethod(registry);
    registerLifecycleMethods(registry, {
      flush: async () => {
        await this.#inFlightMutations.waitForPending();
        await this.#database.writer.flush();
      },
      acceptStop: () => this.#acceptStop(),
    });
    registerStatusMethods(registry, {
      processIdentity: options.processIdentity,
      readProcessState: () => this.#processState,
      readRecovery: () => this.#recoveryStatus.read(),
      version: options.serviceVersion,
      transportEndpoint: options.runFolder.socketPath,
      dataDirectory: parts.dataFolder,
      startedAt: parts.startedAt,
      now: options.now,
      readProcessTreeUsage: options.readProcessTreeUsage,
      writeServiceLog: options.writeServiceLog,
    });
    // A subscription's values go out on its own connection; the gateway is built just below and
    // sends nothing before it listens.
    const streamingPrimitive = new StreamingPrimitive({
      registry,
      send: (transportId, notification) => {
        this.#gateway.notify(transportId, notification);
      },
    });
    const settingsFile = new MachineSettingsFile({
      filePath: path.join(options.homeDirectory, ...MACHINE_SETTINGS_FILE_PATH_SEGMENTS),
      now: options.now,
    });
    registerMachineSettingsMethods(registry, {
      settingsFile,
      streamingPrimitive,
      findBranchPatternRefusal,
    });
    const sessionServices = parts.registerSessionMethods(registry, {
      database: parts.database,
      homeDirectory: options.homeDirectory,
      nodeId: parts.localMachine.nodeId,
      settingsFile,
      providers: new ProviderRegistry(),
      streamingPrimitive,
      // The gateway is built just below; a stream reads its queues only once it listens.
      outboundQueue: {
        isFull: (transportId) => this.#gateway.isFull(transportId),
        onceDrained: (transportId, listener) => this.#gateway.onceDrained(transportId, listener),
      },
      searchThread: parts.searchThread,
      writeServiceLog: options.writeServiceLog,
    });
    this.#stopSessionServices = sessionServices.stop;
    // The pass appends through the daemon's one event log, so its run endings reach the sessions
    // list like any other event.
    const { reader, writer } = parts.database;
    this.#startupRecovery = new StartupRecovery({
      nodeId: parts.localMachine.nodeId,
      reader,
      sessionEvents: sessionServices.eventLog,
      projectionRebuild: new ProjectionRebuildService({
        reader,
        writer,
        sessionEvents: sessionServices.sessions,
        projections: [RUNS_PROJECTION],
      }),
      runs: new RunStateReader(reader),
      runEngine: new RunEngine({ reader, sessionEvents: sessionServices.eventLog }),
      status: this.#recoveryStatus,
      now: options.now,
      writeServiceLog: options.writeServiceLog,
    });

    this.#gateway = new LocalIpcGateway({
      registry,
      // Every local connection comes from this machine, so its id is the calling device.
      deviceId: DeviceIdSchema.parse(parts.localMachine.nodeId),
      hooks: {
        onDisconnect: (transport) => {
          negotiator.cleanupTransport(transport.id);
          streamingPrimitive.cleanupTransport(transport.id);
        },
        onError: (transport, error) => {
          options.writeServiceLog(
            `Connection ${String(transport.id)} failed: ${describeError(error)}`,
          );
        },
        // The service reads as degraded from a listener failure until it stops.
        onListenerError: (error) => {
          this.#markDegraded();
          options.writeServiceLog(`The socket's listener failed: ${describeError(error)}`);
        },
      },
    });
    // A dead writer fails every write from then on, so the service reads as degraded and its
    // recovery as blocked.
    void this.#database.writer.whenWorkerFailed.then((error) => {
      this.#markDegraded();
      this.#recoveryStatus.markStoreFailed();
      options.writeServiceLog(`The database writer failed: ${describeError(error)}`);
    });
    // A search thread whose index failed to open, rebuild or apply, or that died, fails every
    // search from then on, so the service reads as degraded too, while every other service goes on.
    void this.#searchThread.whenWorkerFailed.then((error) => {
      this.#markDegraded();
      options.writeServiceLog(`The search thread failed: ${describeError(error)}`);
    });
  }

  /**
   * Starts the daemon and resolves once it listens and its recovery pass has ended; a pass that
   * fails leaves the node's recovery state saying so and never fails the start. Throws
   * `DaemonAlreadyRunningError` when another daemon holds the data folder or answers on the
   * socket; any other failure releases what the start had taken.
   */
  static async start(options: DaemonProcessOptions): Promise<DaemonProcess> {
    const startedAt = options.now();
    // The validated settings are in force before anything can bind.
    bootstrap({ localIpcPath: options.runFolder.socketPath });

    const dataFolder = resolveDataFolder(options.homeDirectory);
    // Readable by the person alone. An existing folder keeps its own mode, so the mode is set
    // again.
    await mkdir(dataFolder, { recursive: true, mode: 0o700 });
    await chmod(dataFolder, 0o700);
    const dataFolderLock = takeDataFolderLock(dataFolder);
    // The login shell and the session services' load are the start's longest steps, so both begin
    // first and run while the rest of the start does. Each settles into an outcome at once, so a
    // failure is never left unhandled: the start reads both once the rest is done, or in its
    // cleanup when it fails before then. A start that fails, the load included, ends the login
    // shell rather than wait for it.
    const captureAbort = new AbortController();
    const sessionMethodsAndCapture = Promise.allSettled([
      import("./session-methods.js").catch((error: unknown) => {
        captureAbort.abort("the start failed");
        throw error;
      }),
      options.captureProviderBaseEnvironment(captureAbort.signal),
    ]);
    let isSessionMethodsAndCaptureRead = false;
    try {
      const databasePath = path.join(dataFolder, DATABASE_FILE_NAME);
      const database = await openDatabaseConnections({
        databasePath,
        writeServiceLog: options.writeServiceLog,
      });
      // The search thread opens the index on its own thread from here on, building it again if it
      // must; the start never waits for it, and a search waits for its open.
      const searchThread = SearchThread.start({
        databasePath,
        indexFolderPath: path.join(dataFolder, SEARCH_INDEX_FOLDER_NAME),
        writer: database.writer,
        writeServiceLog: options.writeServiceLog,
      });
      let orphanGuard: OrphanGuard | undefined;
      let daemon: DaemonProcess | undefined;
      try {
        const orphans = await options.openOrphanGuard(dataFolder);
        orphanGuard = orphans.guard;
        options.writeServiceLog(describeOrphanSweep(orphans.sweep));
        const localMachine = await readOrMintLocalMachine(
          database,
          options.readMachineName,
          options.now,
        );
        const [sessionMethods, capture] = await sessionMethodsAndCapture;
        isSessionMethodsAndCaptureRead = true;
        if (sessionMethods.status === "rejected" && capture.status === "rejected") {
          throw new AggregateError(
            [sessionMethods.reason, capture.reason],
            "The session services' load and the login shell's read both failed",
          );
        }
        if (sessionMethods.status === "rejected") {
          throw sessionMethods.reason;
        }
        if (capture.status === "rejected") {
          throw capture.reason;
        }
        const providerBaseEnvironment = capture.value;

        await prepareRunFolder(options.runFolder);
        // A new token at every start, so the previous start's token no longer opens a connection.
        const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
        daemon = new DaemonProcess({
          options,
          startedAt,
          dataFolder,
          dataFolderLock,
          database,
          orphanGuard,
          searchThread,
          localMachine,
          providerBaseEnvironment,
          sessionToken,
          registerSessionMethods: sessionMethods.value.registerSessionMethods,
        });
        await daemon.#listen(options.runFolder, sessionToken);
        daemon.#recoveryPass = daemon.#startupRecovery.run();
        await daemon.#recoveryPass;
        return daemon;
      } catch (startError) {
        const cleanupFailures: unknown[] = [];
        // The session services' background work reads the database, so it ends first.
        if (daemon !== undefined) {
          try {
            await daemon.#stopSessionServices();
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
        const closes = await Promise.allSettled([
          searchThread.close(),
          orphanGuard?.close(),
          closeDatabaseConnections(database),
        ]);
        for (const close of closes) {
          if (close.status === "rejected") {
            cleanupFailures.push(close.reason);
          }
        }
        throw withCleanupFailures(startError, cleanupFailures, "The daemon's start");
      }
    } catch (startError) {
      const cleanupFailures: unknown[] = [];
      if (!isSessionMethodsAndCaptureRead) {
        captureAbort.abort("the start failed");
        for (const outcome of await sessionMethodsAndCapture) {
          if (outcome.status === "rejected") {
            cleanupFailures.push(outcome.reason);
          }
        }
      }
      try {
        dataFolderLock.release();
      } catch (releaseError) {
        cleanupFailures.push(releaseError);
      }
      throw withCleanupFailures(startError, cleanupFailures, "The daemon's start");
    }
  }

  /**
   * Stops the daemon: closes the socket and every connection, then, side by side and each within
   * the drain bound, waits for the calls already under way, the start's recovery pass and the
   * session services' background work, lets the searches under way finish and ends the search
   * thread, and drains every terminal (each gets its graceful signal, then a kill); then stops
   * watching terminal children's exits and, in what is left of the bound, waits for every write
   * taken to commit, failing any still unfinished, closes the database and lets the data folder
   * go.
   * Repeated calls share the first stop.
   */
  stop(): Promise<void> {
    if (this.#stopping === undefined) {
      this.#processState = "stopping";
      const stopping = this.#runStop();
      this.#stopping = stopping;
      stopping.then(
        () => {
          this.#stopOutcome.resolve({ isClean: true });
        },
        (failure: unknown) => {
          this.#stopOutcome.resolve({ isClean: false, failure });
        },
      );
    }
    return this.#stopping;
  }

  /** Resolves once the daemon has stopped, however the stop was asked for, with how it ended. */
  whenStopped(): Promise<DaemonStopOutcome> {
    return this.#stopOutcome.promise;
  }

  async #listen(runFolder: DaemonRunFolder, sessionToken: string): Promise<void> {
    try {
      await this.#gateway.start();
    } catch (error) {
      // Another start bound the socket between this start's check of the run folder and its bind.
      if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
        throw new DaemonAlreadyRunningError(`the socket ${runFolder.socketPath}`, { cause: error });
      }
      throw error;
    }
    try {
      await writeSessionToken(runFolder, sessionToken);
    } catch (error) {
      await this.#gateway.stop();
      throw error;
    }
    if (this.#processState === "starting") {
      this.#processState = "running";
    }
  }

  // A stop or restart over the socket answers at once, since the caller counts the drain bound
  // from its request; the stop starts one turn of the event loop later, after this call's reply
  // has been handed to the socket, and the gateway's close lets it out before the socket goes.
  #acceptStop(): Promise<void> {
    this.#processState = "stopping";
    setImmediate(() => {
      void this.stop();
    });
    return Promise.resolve();
  }

  #markDegraded(): void {
    if (this.#processState === "starting" || this.#processState === "running") {
      this.#processState = "degraded";
    }
  }

  // Each step runs even when an earlier one fails, so a stop never leaves terminals running, the
  // database open or the data folder held; the failures are thrown together once all have run.
  async #runStop(): Promise<void> {
    const stopStartedAt = performance.now();
    const failures: unknown[] = [];
    try {
      await this.#gateway.stop();
    } catch (error) {
      failures.push(error);
    }
    // The calls under way, the recovery pass, the session services' background work, the searches
    // and the terminals are independent, so all finish inside one drain bound. A call, a pass or a
    // background write still running at the bound fails once the database closes under it, and its
    // batch rolls back.
    const [stillWriting, hasPassEnded, drain, haveSessionServicesEnded, haveSearchesEnded] =
      await Promise.allSettled([
        this.#inFlightMutations.waitForPendingWithin(DAEMON_STOP_DRAIN_BOUND_MS),
        waitWithin(this.#recoveryPass, DAEMON_STOP_DRAIN_BOUND_MS),
        this.#ptyHost.shutdown({
          perSessionTimeoutMs: DAEMON_STOP_TERMINAL_DRAIN_MS,
          hostTimeoutMs: DAEMON_STOP_TERMINAL_HOST_DRAIN_MS,
        }),
        endWithinDrainBound(this.#stopSessionServices(), failures),
        endWithinDrainBound(this.#searchThread.close(), failures),
      ]);
    if (haveSessionServicesEnded.status === "fulfilled" && !haveSessionServicesEnded.value) {
      this.#writeServiceLog(
        "The stop's drain bound passed; the session services' background work is still running.",
      );
    }
    if (haveSearchesEnded.status === "fulfilled" && !haveSearchesEnded.value) {
      this.#writeServiceLog("The stop's drain bound passed; a search is still running.");
    }
    if (stillWriting.status === "fulfilled" && stillWriting.value > 0) {
      this.#writeServiceLog(
        `The stop's drain bound passed; writes still running: ${String(stillWriting.value)}.`,
      );
    }
    if (hasPassEnded.status === "fulfilled" && !hasPassEnded.value) {
      this.#writeServiceLog("The stop's drain bound passed; the recovery pass was still running.");
    }
    if (drain.status === "fulfilled") {
      this.#writeServiceLog(describeDrain(drain.value));
    } else {
      failures.push(drain.reason);
    }
    // After the drain, so the exit of every child it ended is still retired.
    try {
      await this.#orphanGuard.close();
    } catch (error) {
      failures.push(error);
    }
    // The writer's queue drains in what is left of the drain bound, so the caller's signal never
    // cuts a commit short; a write still unfinished then fails, and its batch rolls back whole.
    const drainLeftMs = Math.max(
      0,
      DAEMON_STOP_DRAIN_BOUND_MS - (performance.now() - stopStartedAt),
    );
    try {
      const unfinishedCount = await closeDatabaseConnections(this.#database, drainLeftMs);
      if (unfinishedCount > 0) {
        this.#writeServiceLog(
          `The stop's drain bound passed; writes never committed: ${String(unfinishedCount)}.`,
        );
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#dataFolderLock.release();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "The daemon's stop failed in more than one step");
    }
  }
}

function describeDrain(drain: DrainResult): string {
  return (
    `The terminals drained at the stop: ${String(drain.sessionsDrained)} ended, ` +
    `${String(drain.sessionsForcedKilled)} killed; the terminal host ` +
    `${drain.sidecarExitedCleanly ? "exited cleanly" : "did not exit cleanly"}` +
    `${drain.taskkillEscalated ? " and was killed" : ""}.`
  );
}

// Waits for `work` within the stop's drain bound: resolves `true` once it ended, its failure, if
// any, added to `failures`, or `false` when the bound passed first.
async function endWithinDrainBound(work: Promise<unknown>, failures: unknown[]): Promise<boolean> {
  const failure = work.then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  if (!(await waitWithin(failure, DAEMON_STOP_DRAIN_BOUND_MS))) {
    return false;
  }
  const ended = await failure;
  if (ended !== undefined) {
    failures.push(ended.error);
  }
  return true;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
