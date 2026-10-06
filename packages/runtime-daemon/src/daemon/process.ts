// The daemon as a running process. Its start takes the data-folder lock before anything else, so of
// two starts on one data folder only one goes on; it then opens the database, through its writer
// for writes and a read-only connection for reads, knows this machine, captures the environment
// providers are built from, listens on its socket and writes this start's session token once the
// bind has succeeded. A client that reads the previous token in the moment between the bind and
// the write is refused once, and its next read finds this start's token. Its stop, asked for over
// the socket or by a terminate signal, ends it cleanly.

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

import { bootstrap } from "../bootstrap/index.js";
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
import type { SpawnEnvPair } from "../provider/spawn-env.js";
import type { DrainResult, PtyHost } from "../pty/host/contract.js";
import { DaemonAlreadyRunningError } from "./already-running-error.js";
import { takeDataFolderLock, type DataFolderLock } from "./data-folder-lock.js";
import { registerLifecycleMethods } from "./lifecycle-methods.js";
import { readOrMintLocalMachine, type LocalMachine } from "./machine/local.js";
import { MachineSettingsFile } from "./machine/settings/file.js";
import { registerMachineSettingsMethods } from "./machine/settings/methods.js";
import type { ProcessTreeUsage } from "./process-tree-usage.js";
import { prepareRunFolder, writeSessionToken } from "./run-folder.js";
import { registerStatusMethods } from "./status-methods.js";

const DATABASE_FILE_NAME = "daemon.db";

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
  /** The terminal host; the daemon drains it at its stop. */
  readonly ptyHost: Pick<PtyHost, "shutdown">;
  /** Reads this machine's friendly name; called only at the first start. */
  readonly readMachineName: () => Promise<string>;
  /** Captures the base environment every provider process is built from. */
  readonly captureProviderBaseEnvironment: () => Promise<readonly SpawnEnvPair[]>;
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
  readonly #gateway: LocalIpcGateway;
  readonly #inFlightMutations: InFlightMutations;
  readonly #ptyHost: Pick<PtyHost, "shutdown">;
  readonly #writeServiceLog: (line: string) => void;
  readonly #stopOutcome = Promise.withResolvers<DaemonStopOutcome>();
  #processState: DaemonProcessState = "starting";
  #stopping: Promise<void> | undefined;

  private constructor(parts: {
    options: DaemonProcessOptions;
    startedAt: Date;
    dataFolder: string;
    dataFolderLock: DataFolderLock;
    database: DatabaseConnections;
    localMachine: LocalMachine;
    providerBaseEnvironment: readonly SpawnEnvPair[];
    sessionToken: string;
  }) {
    const { options } = parts;
    this.localMachine = parts.localMachine;
    this.providerBaseEnvironment = parts.providerBaseEnvironment;
    this.#dataFolderLock = parts.dataFolderLock;
    this.#database = parts.database;
    this.#ptyHost = options.ptyHost;
    this.#writeServiceLog = options.writeServiceLog;

    // The negotiation gate wraps the recording registry, so a refused call is never recorded.
    this.#inFlightMutations = new InFlightMutations();
    const negotiator = new ProtocolNegotiator(parts.sessionToken);
    const registry = negotiator.wrap(this.#inFlightMutations.wrap(new MethodRegistryImpl()));
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
      settingsFile: new MachineSettingsFile({
        filePath: path.join(options.homeDirectory, ...MACHINE_SETTINGS_FILE_PATH_SEGMENTS),
        now: options.now,
      }),
      streamingPrimitive,
      findBranchPatternRefusal,
    });

    this.#gateway = new LocalIpcGateway({
      registry,
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
    // A dead writer fails every write from then on, so the service reads as degraded too.
    void this.#database.writer.whenWorkerFailed.then((error) => {
      this.#markDegraded();
      options.writeServiceLog(`The database writer failed: ${describeError(error)}`);
    });
  }

  /**
   * Starts the daemon and resolves once it listens. Throws `DaemonAlreadyRunningError` when another
   * daemon holds the data folder or answers on the socket; any failure releases what the start had
   * taken.
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
    try {
      const database = await openDatabaseConnections({
        databasePath: path.join(dataFolder, DATABASE_FILE_NAME),
        writeServiceLog: options.writeServiceLog,
      });
      try {
        const localMachine = await readOrMintLocalMachine(
          database,
          options.readMachineName,
          options.now,
        );
        const providerBaseEnvironment = await options.captureProviderBaseEnvironment();

        await prepareRunFolder(options.runFolder);
        // A new token at every start, so the previous start's token no longer opens a connection.
        const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
        const daemon = new DaemonProcess({
          options,
          startedAt,
          dataFolder,
          dataFolderLock,
          database,
          localMachine,
          providerBaseEnvironment,
          sessionToken,
        });
        await daemon.#listen(options.runFolder, sessionToken);
        return daemon;
      } catch (startError) {
        try {
          await closeDatabaseConnections(database);
        } catch (closeError) {
          throw new AggregateError(
            [startError, closeError],
            "The daemon's start failed, and closing its database after that failed too",
            { cause: closeError },
          );
        }
        throw startError;
      }
    } catch (startError) {
      try {
        dataFolderLock.release();
      } catch (releaseError) {
        throw new AggregateError(
          [startError, releaseError],
          "The daemon's start failed, and letting its data folder go after that failed too",
          { cause: releaseError },
        );
      }
      throw startError;
    }
  }

  /**
   * Stops the daemon: closes the socket and every connection, then, side by side and each within
   * the drain bound, waits for the calls already under way and drains every terminal (each gets
   * its graceful signal, then a kill); then, in what is left of the bound, waits for every write
   * taken to commit, failing any still unfinished, closes the database and lets the data folder go.
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
    // The calls under way and the terminals are independent, so both finish inside one drain
    // bound. A call still running at the bound fails once the database closes under it.
    const [stillWriting, drain] = await Promise.allSettled([
      this.#inFlightMutations.waitForPendingWithin(DAEMON_STOP_DRAIN_BOUND_MS),
      this.#ptyHost.shutdown({
        perSessionTimeoutMs: DAEMON_STOP_TERMINAL_DRAIN_MS,
        hostTimeoutMs: DAEMON_STOP_TERMINAL_HOST_DRAIN_MS,
      }),
    ]);
    if (stillWriting.status === "fulfilled" && stillWriting.value > 0) {
      this.#writeServiceLog(
        `The stop's drain bound passed; writes still running: ${String(stillWriting.value)}.`,
      );
    }
    if (drain.status === "fulfilled") {
      this.#writeServiceLog(describeDrain(drain.value));
    } else {
      failures.push(drain.reason);
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
