// The daemon as a running process. Its start takes the data-folder lock before anything else, so of
// two starts on one data folder only one goes on. It then starts capturing the login shell's
// environment, which providers are built from, and loading the session services' modules; while
// those run, it opens the database file, through its writer for writes and a read-only connection
// for reads, repairing it first, while the socket answers that it is repairing, when a previous run
// found it damaged, and starts the file's structural check beside it (`database-file.ts`). Damage
// the check or any read or write meets is recorded beside the file and stops the daemon, so its
// next start repairs the file before anything opens it. The start then starts the search thread, which
// opens its own read-only connection and the search index, building the index again when it
// cannot serve, while the start goes on, kills the terminal children a previous run left running
// and knows this machine. It builds the terminal host over this run's orphan guard, listens on its
// socket and writes this start's session token once the bind has succeeded, then runs its recovery
// pass, refusing writes until that pass has ended and, after it, only the writes of a session
// whose history is damaged; the session services' background work starts once the pass has ended.
// A client that reads the previous token in the moment between the bind and the write is refused
// once, and its next read finds this start's token. Its stop, asked for over the socket or by a
// terminate signal, ends it cleanly at any point of the start or after it, and records the clean
// stop once the database has closed; a start that nothing stopped says the daemon is ready.

import { chmod, mkdir } from "node:fs/promises";
import * as path from "node:path";

import {
  DAEMON_READY_LINE,
  DAEMON_STOP_DRAIN_BOUND_MS,
  DAEMON_STOP_TERMINAL_DRAIN_MS,
  DAEMON_STOP_TERMINAL_HOST_DRAIN_MS,
} from "@ai-sidekicks/contracts/daemon/lifecycle";
import { BACKUP_DEFAULT_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/backup";
import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import type { DaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import type { DaemonProcessState } from "@ai-sidekicks/contracts/daemon/status";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import { MACHINE_SETTINGS_FILE_PATH_SEGMENTS } from "@ai-sidekicks/contracts/machine-settings";
import { DeviceIdSchema } from "@ai-sidekicks/contracts/trust-statement";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import { bootstrap } from "../bootstrap/index.js";
import { waitWithin } from "../bounded-wait.js";
import { withCleanupFailures } from "../cleanup-failures.js";
import {
  closeDatabaseConnections,
  type DatabaseConnections,
} from "../database/connection/lifecycle.js";
import { findBranchPatternRefusal } from "../git/branch-name-pattern.js";
import { createGitRunner, findGitExecutable, type GitRunner } from "../git/process.js";
import {
  createStreamedGitRunner,
  type StreamedGitRunner,
} from "../workspace/clone/streamed-git.js";
import { InFlightMutations } from "../ipc/in-flight-mutations.js";
import { LocalIpcGateway } from "../ipc/local-gateway.js";
import { ProtocolNegotiator } from "../ipc/protocol-negotiation.js";
import { DelegatingRegistry, MethodRegistryImpl } from "../ipc/registry.js";
import { StreamingPrimitive } from "../ipc/streaming-primitive.js";
import { ProviderRegistry } from "../provider/driver/registry.js";
import type { SpawnEnvPair } from "../provider/spawn-env.js";
import type { DrainResult, PtyHost } from "../pty/host/contract.js";
import type { OrphanGuard } from "../pty/orphan/guard.js";
import { describeOrphanSweep, type OrphanSweepResult } from "../pty/orphan/sweep.js";
import { DamagedHistory, registerDamagedHistoryMethods } from "../recovery/damaged-history.js";
import {
  copyDatabaseFilesAside,
  findAsideCopyOfSession,
  recordSessionInAsideCopy,
} from "../recovery/database-file/aside-copy.js";
import {
  type DatabaseDamageWatch,
  recordDatabaseDamage,
} from "../recovery/database-file/damage.js";
import { ProjectionRebuildService } from "../recovery/projection-rebuild.js";
import { refuseSessionEvent } from "../recovery/session-write-refusal.js";
import { StartupRecovery } from "../recovery/startup.js";
import { RecoveryStatusTracker } from "../recovery/status.js";
import { RecoveryWriteGate } from "../recovery/write-gate.js";
import { SESSION_DIRECTORY_PROJECTION } from "../session/directory/projection.js";
import { RunEngine } from "../session/run/engine.js";
import { RUNS_PROJECTION } from "../session/run/projection.js";
import { RunStateReader } from "../session/run/read.js";
import { SearchThread } from "../session/search/thread/handle.js";
import { readFolderPlace, type FolderPlace } from "../workspace/folder/place.js";
import { openDatabaseFile, type OpenedDatabaseFile } from "./database-file.js";
import { takeDataFolderLock, type DataFolderLock } from "./data-folder-lock.js";
import { registerLifecycleMethods } from "./lifecycle-methods.js";
import { readOrMintLocalMachine, type LocalMachine } from "./machine/local.js";
import { MachineSettingsFile } from "./machine/settings/file.js";
import { registerMachineSettingsMethods } from "./machine/settings/methods.js";
import type { ProcessTreeUsage } from "./process-tree-usage.js";
import { bindSocket, mintSessionToken, prepareRunFolder } from "./run-folder.js";
import type { registerSessionMethods } from "./session-methods.js";
import { registerStatusMethods } from "./status-methods.js";

/** The daemon's database file in its data folder. */
export const DATABASE_FILE_NAME = "daemon.db";
/** The search index's folder in the data folder, beside the database it is built from. */
export const SEARCH_INDEX_FOLDER_NAME = "search-index";

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
  /** The login shell a project's setup commands run in; `null` runs the system's default one. */
  readonly commandShell: string | null;
  /** The service's own release version, which the status read reports. */
  readonly serviceVersion: string;
  /** The daemon's own process as the system knows it, which the status read reports. */
  readonly processIdentity: ProcessIdentity;
  /** Reads the daemon's process and every process under it, for the status read. */
  readonly readProcessTreeUsage: () => Promise<ProcessTreeUsage>;
  readonly now: () => Date;
  /** Writes one line to the service log, the daemon's standard error. */
  readonly writeServiceLog: (line: string) => void;
  /**
   * Aborts when a terminate signal asks the daemon to stop. Before the daemon listens it ends the
   * start; once it listens it stops the daemon as a stop over the socket does.
   */
  readonly stopSignal: AbortSignal;
}

/**
 * How a stop ended: cleanly, saying whether damage to the database file stopped the daemon so its
 * next start repairs it, or with what went wrong in it.
 */
export type DaemonStopOutcome =
  | { readonly isClean: true; readonly isFileDamaged: boolean }
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
  readonly #databasePath: string;
  readonly #database: DatabaseConnections;
  readonly #databaseFile: OpenedDatabaseFile;
  #isFileDamaged = false;
  readonly #searchThread: SearchThread;
  readonly #gateway: LocalIpcGateway;
  readonly #inFlightMutations: InFlightMutations;
  readonly #recoveryStatus = new RecoveryStatusTracker();
  readonly #startupRecovery: StartupRecovery;
  // The start's recovery pass, which a stop ends and waits for before the database closes under it.
  #recoveryPass: Promise<void> = Promise.resolve();
  readonly #stopRequest = new AbortController();
  readonly #ptyHost: Pick<PtyHost, "shutdown">;
  readonly #orphanGuard: OrphanGuard;
  readonly #writeServiceLog: (line: string) => void;
  // The provider drivers the daemon holds, which a session's close ends its provider leg through.
  readonly #providers = new ProviderRegistry();
  readonly #startSessionServices: () => Promise<void>;
  readonly #stopSessionServices: () => Promise<void>;
  readonly #stopOutcome = Promise.withResolvers<DaemonStopOutcome>();
  #processState: DaemonProcessState = "starting";
  #stopping: Promise<void> | undefined;

  private constructor(parts: {
    options: DaemonProcessOptions;
    startedAt: Date;
    dataFolder: string;
    dataFolderLock: DataFolderLock;
    databasePath: string;
    databaseFile: OpenedDatabaseFile;
    /** The machine settings file, whose backup folder the start's repair read. */
    settingsFile: MachineSettingsFile;
    orphanGuard: OrphanGuard;
    searchThread: SearchThread;
    localMachine: LocalMachine;
    providerBaseEnvironment: readonly SpawnEnvPair[];
    /** The runner for the `git` found along the login shell's `PATH`. */
    git: GitRunner;
    /** The same `git`, run streamed for a clone or a fetch. */
    streamedGit: StreamedGitRunner;
    folderPlace: FolderPlace;
    sessionToken: string;
    registerSessionMethods: typeof registerSessionMethods;
  }) {
    const { options } = parts;
    this.localMachine = parts.localMachine;
    this.providerBaseEnvironment = parts.providerBaseEnvironment;
    this.#dataFolderLock = parts.dataFolderLock;
    this.#databasePath = parts.databasePath;
    this.#databaseFile = parts.databaseFile;
    this.#database = parts.databaseFile.database;
    const { damageWatch } = parts.databaseFile;
    this.#orphanGuard = parts.orphanGuard;
    this.#searchThread = parts.searchThread;
    this.#ptyHost = options.createPtyHost(parts.orphanGuard);
    this.#writeServiceLog = options.writeServiceLog;

    // The negotiation gate wraps the recovery gate, which wraps the recording registry, so a
    // refused call is never recorded; under them every call's failure is told to the damage watch.
    this.#inFlightMutations = new InFlightMutations();
    const negotiator = new ProtocolNegotiator(parts.sessionToken);
    const writeGate = new RecoveryWriteGate(this.#recoveryStatus);
    const registry = negotiator.wrap(
      writeGate.wrap(
        this.#inFlightMutations.wrap(reportDamageOf(new MethodRegistryImpl(), damageWatch)),
      ),
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
    registerMachineSettingsMethods(registry, {
      settingsFile: parts.settingsFile,
      streamingPrimitive,
      findBranchPatternRefusal: (pattern) => findBranchPatternRefusal(pattern, parts.git),
    });
    const sessionServices = parts.registerSessionMethods(registry, {
      database: this.#database,
      homeDirectory: options.homeDirectory,
      nodeId: parts.localMachine.nodeId,
      git: parts.git,
      streamedGit: parts.streamedGit,
      folderPlace: parts.folderPlace,
      settingsFile: parts.settingsFile,
      providers: this.#providers,
      streamingPrimitive,
      // The gateway is built just below; a stream reads its queues only once it listens.
      outboundQueue: {
        isFull: (transportId) => this.#gateway.isFull(transportId),
        onceDrained: (transportId, listener) => this.#gateway.onceDrained(transportId, listener),
      },
      searchThread: parts.searchThread,
      whenFileCheckEnds: parts.databaseFile.checkOutcome,
      commandShell: options.commandShell,
      providerBaseEnvironment: parts.providerBaseEnvironment,
      refuseSessionWrite: (sessionId, eventType) => {
        refuseSessionEvent(this.#recoveryStatus, sessionId, eventType);
      },
      readDamagedFromSequence: (sessionId) =>
        this.#recoveryStatus.readDamagedFromSequence(sessionId),
      writeServiceLog: options.writeServiceLog,
    });
    this.#startSessionServices = sessionServices.start;
    this.#stopSessionServices = sessionServices.stop;
    // The pass and the damaged history append through the daemon's one event log, so what they
    // write reaches the sessions list like any other event, and read through its session reads,
    // which stop at a damaged session's last good point.
    const { reader, writer } = this.#database;
    const runEngine = new RunEngine({ reader, sessionEvents: sessionServices.eventLog });
    // A run the restart settles releases what its execution root held, as any run's end does.
    runEngine.registerSetupGate(sessionServices.setupGate);
    const runs = new RunStateReader(reader);
    const projectionRebuild = new ProjectionRebuildService({
      reader,
      writer,
      sessionEvents: sessionServices.sessions,
      projections: [SESSION_DIRECTORY_PROJECTION, RUNS_PROJECTION],
    });
    const damagedHistory = new DamagedHistory({
      reader,
      sessionEvents: sessionServices.sessions,
      eventLog: sessionServices.eventLog,
      projectionRebuild,
      purge: sessionServices.purge,
      runs,
      runEngine,
      status: this.#recoveryStatus,
    });
    registerDamagedHistoryMethods(registry, damagedHistory);
    const asideOptions = {
      databasePath: parts.databasePath,
      dataFolder: parts.dataFolder,
      now: options.now,
      writeServiceLog: options.writeServiceLog,
    };
    this.#startupRecovery = new StartupRecovery({
      nodeId: parts.localMachine.nodeId,
      reader,
      sessionEvents: sessionServices.eventLog,
      projectionRebuild,
      damagedHistory,
      storeAside: {
        // Every write the pass queued commits first, so the copy holds them.
        copy: async () => {
          await writer.flush();
          return copyDatabaseFilesAside(asideOptions);
        },
        findCopyOfSession: (sessionId, headSequence) =>
          findAsideCopyOfSession(asideOptions, sessionId, headSequence),
        recordSession: recordSessionInAsideCopy,
      },
      runs,
      runEngine,
      status: this.#recoveryStatus,
      reportStoreFailure: (error) => {
        damageWatch.report(error);
      },
      stopSignal: this.#stopRequest.signal,
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
      damageWatch.report(error);
      this.#markDegraded();
      options.writeServiceLog(`The search thread failed: ${describeError(error)}`);
    });
    // A file the start could not check takes writes unchecked, so the service reads as degraded;
    // the check has already said why in the service log.
    void parts.databaseFile.checkOutcome.then((outcome) => {
      if (outcome === "failed") {
        this.#markDegraded();
      }
    });
    // A managed workspaces watch that could not start or failed reports no chat's write from then
    // on, so the service reads as degraded; the watch has already said why in the service log.
    void sessionServices.managedWorkspaceWrites.whenFailed.then(() => {
      this.#markDegraded();
    });
  }

  /**
   * Starts the daemon and resolves once it listens, its recovery pass has ended and the session
   * services' background work has started, then logs that it is ready; a pass that fails leaves
   * the node's recovery state saying so and never fails the start. A stop during the pass resolves
   * with the daemon stopping, its background work never started and no ready line. Throws
   * `DaemonAlreadyRunningError` when another daemon holds the data folder or answers on the
   * socket, and `DaemonStartStoppedError` when the stop signal ended a repair of the file; any
   * failure releases what the start had taken.
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
      const indexFolderPath = path.join(dataFolder, SEARCH_INDEX_FOLDER_NAME);
      const settingsFile = new MachineSettingsFile({
        filePath: path.join(options.homeDirectory, ...MACHINE_SETTINGS_FILE_PATH_SEGMENTS),
        now: options.now,
      });
      const databaseFile = await openDatabaseFile({
        databasePath,
        dataFolder,
        indexFolderPath,
        runFolder: options.runFolder,
        readBackupFolder: async () =>
          (await settingsFile.read()).settings.backup.folder ??
          path.join(dataFolder, BACKUP_DEFAULT_FOLDER_NAME),
        stopSignal: options.stopSignal,
        now: options.now,
        writeServiceLog: options.writeServiceLog,
      });
      const { database, damageWatch } = databaseFile;
      // The search thread opens the index on its own thread from here on, building it again if it
      // must; the start never waits for it, and a search waits for its open.
      const searchThread = SearchThread.start({
        databasePath,
        indexFolderPath,
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
        // Found once, along the login shell's PATH; a missing git fails where git is first used.
        const gitExecutable = await findGitExecutable(providerBaseEnvironment);
        const git = createGitRunner(gitExecutable);
        const streamedGit = createStreamedGitRunner(gitExecutable);
        const folderPlace = await readFolderPlace();

        await prepareRunFolder(options.runFolder);
        // A new token at every start, so the previous start's token no longer opens a connection.
        const sessionToken = mintSessionToken();
        daemon = new DaemonProcess({
          options,
          startedAt,
          dataFolder,
          dataFolderLock,
          databasePath,
          databaseFile,
          settingsFile,
          orphanGuard,
          searchThread,
          localMachine,
          providerBaseEnvironment,
          git,
          streamedGit,
          folderPlace,
          sessionToken,
          registerSessionMethods: sessionMethods.value.registerSessionMethods,
        });
        await daemon.#listen(options.runFolder, sessionToken);
        const listening = daemon;
        void damageWatch.whenFound.then((damage) => listening.#stopForRepair(damage));
        // A stop signaled during the start, before this point included, stops the daemon as one
        // over the socket does; the pass then never starts.
        if (options.stopSignal.aborted) {
          void daemon.stop();
        } else {
          options.stopSignal.addEventListener("abort", () => void listening.stop(), { once: true });
          daemon.#recoveryPass = daemon.#startupRecovery.run();
          await daemon.#recoveryPass;
        }
        // A stop that came during the pass, for damage, by a signal or over the socket, whose
        // own stop starts a turn later, starts no background work and says nothing is ready, nor
        // does damage the pass met, whose stop starts once this turn ends.
        if (daemon.#processState !== "stopping" && !damageWatch.isFound) {
          await daemon.#startSessionServices();
          options.writeServiceLog(
            `${DAEMON_READY_LINE} (process ${String(options.processIdentity.processId)}, ` +
              `protocol ${CURRENT_PROTOCOL_VERSION}).`,
          );
        }
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
        const searchThreadClose = searchThread.close();
        const closes = await Promise.allSettled([
          searchThreadClose,
          orphanGuard?.close(),
          // After the search thread's read-only connection and the check's, as at a stop, so the
          // writer closes last and folds the write-ahead log into the database file.
          Promise.allSettled([searchThreadClose, databaseFile.stopCheck()]).then(() =>
            closeDatabaseConnections(database),
          ),
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
   * Stops the daemon: ends the start's recovery pass before its next page, closes the socket and
   * every connection, then, side by side and each within the drain bound, waits for the calls
   * already under way, the recovery pass and the session services' background work, lets the
   * searches under way finish and ends the search thread, and drains every terminal (each gets its
   * graceful signal, then a kill); then stops watching terminal children's exits and, in what is
   * left of the bound, waits for every write taken to commit, failing any still unfinished, closes
   * the database and lets the data folder go. Repeated calls share the first stop.
   */
  stop(): Promise<void> {
    if (this.#stopping === undefined) {
      this.#processState = "stopping";
      this.#stopRequest.abort(new Error("The service is stopping"));
      const stopping = this.#runStop();
      this.#stopping = stopping;
      stopping.then(
        () => {
          this.#stopOutcome.resolve({ isClean: true, isFileDamaged: this.#isFileDamaged });
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
    await bindSocket(this.#gateway, runFolder, sessionToken);
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

  // The file cannot be replaced under open connections: the writer ends without its closing
  // checkpoint, so the damaged files go aside as they are, the damage is recorded for the next
  // start to repair, and the daemon stops.
  async #stopForRepair(damage: string): Promise<void> {
    this.#isFileDamaged = true;
    this.#recoveryStatus.markStoreFailed();
    this.#writeServiceLog(
      `The database file is damaged: ${damage}. The service stops; its next start repairs the file`,
    );
    this.#database.writer.end(
      new Error(`The database file is damaged, so no write is taken: ${damage}`),
    );
    try {
      await recordDatabaseDamage(this.#databasePath, damage);
    } catch (error) {
      this.#writeServiceLog(
        `Recording the damage failed, so the next start's check must find it again: ` +
          describeError(error),
      );
    }
    await this.stop();
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
    // The check's shell ends first, so the writer is the last to close the file and folds the
    // write-ahead log into it.
    await this.#databaseFile.stopCheck();
    let unfinishedCount = 0;
    try {
      unfinishedCount = await closeDatabaseConnections(this.#database, drainLeftMs);
      if (unfinishedCount > 0) {
        this.#writeServiceLog(
          `The stop's drain bound passed; writes never committed: ${String(unfinishedCount)}.`,
        );
      }
    } catch (error) {
      failures.push(error);
    }
    if (!this.#isFileDamaged && unfinishedCount === 0 && failures.length === 0) {
      try {
        await this.#databaseFile.recordCleanStop();
      } catch (error) {
        failures.push(error);
      }
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

// Tells `watch` of every call's failure, so damage a read meets reaches the repair; the failure
// still goes to the caller.
function reportDamageOf(inner: MethodRegistry, watch: DatabaseDamageWatch): MethodRegistry {
  return new DelegatingRegistry(inner, async (method, params, ctx) => {
    try {
      return await inner.dispatch(method, params, ctx);
    } catch (error) {
      watch.report(error);
      throw error;
    }
  });
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
