// What a daemon start takes from the host that runs it: the machine's folders, readers and
// system parts, each injected so a test can stand in for it.

import type { DaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import type { CallerProcessReader } from "../ipc/caller-process/contract.js";
import type { DaemonOperatingSystem } from "../operating-system/contract.js";
import type { SpawnEnvPair } from "../provider/spawn-env.js";
import type { PtyHost } from "../pty/host/contract.js";
import type { OrphanGuard } from "../pty/orphan/guard.js";
import type { OrphanSweepResult } from "../pty/orphan/sweep.js";
import type { ProcessTreeUsage } from "./process-tree-usage.js";
import type { ServiceLogFiles } from "./service-log.js";

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
  /**
   * Builds the terminal host over the orphan guard, which every session's shells run in; the daemon
   * drains it at its stop.
   */
  readonly createPtyHost: (orphanGuard: OrphanGuard) => PtyHost;
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
  /** The operating system the daemon runs on, picked once at its start. */
  readonly operatingSystem: DaemonOperatingSystem;
  /** Reads which process opened each connection on the socket, and each process's parent. */
  readonly callerProcessReader: CallerProcessReader;
  /** The login shell a project's setup commands run in; `null` runs the system's default one. */
  readonly commandShell: string | null;
  /**
   * Reads the person's login shell at each shell open, so a shell changed with `chsh` opens next;
   * `null` where the account names none.
   */
  readonly readLoginShell: () => string | null;
  /** The service's own release version, which the status read reports. */
  readonly serviceVersion: string;
  /** The daemon's own process as the system knows it, which the status read reports. */
  readonly processIdentity: ProcessIdentity;
  /** Reads the daemon's process and every process under it, for the status read. */
  readonly readProcessTreeUsage: () => Promise<ProcessTreeUsage>;
  /** Reads the free bytes on the volume holding a folder, which an upload is admitted against. */
  readonly readVolumeFreeBytes: (folderPath: string) => Promise<number>;
  readonly now: () => Date;
  /** Writes one line to the service log, the daemon's standard error. */
  readonly writeServiceLog: (line: string) => void;
  /** The service log's files, which the diagnostic-log expiry turns by age and expires. */
  readonly serviceLogFiles: ServiceLogFiles;
  /**
   * Aborts when a terminate signal asks the daemon to stop. Before the daemon listens it ends the
   * start; once it listens it stops the daemon as a stop over the socket does.
   */
  readonly stopSignal: AbortSignal;
}
