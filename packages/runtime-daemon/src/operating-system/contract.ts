// What the daemon takes from the operating system it runs on. One module per system supplies it,
// and the daemon's entry point picks one at its start and hands it to everything it builds, so no
// other module tests the platform.

import type {
  DaemonRunFolder,
  DaemonRunFolderFacts,
} from "@ai-sidekicks/contracts/daemon/run-folder";
import type { SupportedPlatform } from "@ai-sidekicks/contracts/platform";
import type {
  ProcessIdentityReader,
  ProcessIdentitySystem,
} from "@ai-sidekicks/contracts/process-identity";

import type { ProcessPeakReader } from "../admission/process-peak/contract.js";
import type { ProviderBaseEnvironmentCapture } from "../daemon/login-shell-environment.js";
import type { MachineNameSources } from "../daemon/machine/name.js";
import type { DiskFlush } from "../disk-flush/contract.js";
import type { FolderRenames } from "../git/filesystem.js";
import type { TreeWatchCeiling } from "../git/worktree/watch.js";
import type { PathRules } from "../path-rules/contract.js";
import type { ProcessTreeEnding } from "../process-tree/contract.js";
import type { ProviderOperatingSystem } from "../provider/operating-system/contract.js";
import type { SpawnEnvPair } from "../provider/spawn-env.js";
import type { TerminalOperatingSystem } from "../pty/operating-system/contract.js";
import type { OrphanOperatingSystem } from "../pty/orphan/operating-system.js";
import type { DatabaseFileOperatingSystem } from "../recovery/database-file/operating-system.js";
import type { WrappingShell } from "../session/spawn-cwd-translator.js";
import type { FolderPlace } from "../workspace/folder/place.js";

/** The facts and readers of one operating system that the daemon's parts take. */
export interface DaemonOperatingSystem {
  /** The system in Node's spelling, which names the terminal sidecar's published package. */
  readonly platform: SupportedPlatform;
  /** What the terminal host and its shells take. */
  readonly terminal: TerminalOperatingSystem;
  /** What the provider drivers take. */
  readonly provider: ProviderOperatingSystem;
  /** What the database file's check, repair and copies aside take. */
  readonly databaseFile: DatabaseFileOperatingSystem;
  /** The memory gate's read of a provider process's peak. */
  readonly processPeak: ProcessPeakReader;
  /** How a child the daemon starts is ended with every process it started in turn. */
  readonly processTree: ProcessTreeEnding;
  /** How a written file, and a changed folder, are flushed to disk. */
  readonly diskFlush: DiskFlush;
  /** How a path is spelled and compared, which every folder comparison follows. */
  readonly pathRules: PathRules;
  /** How a folder rename behaves, which a worktree's move and put-back follow. */
  readonly folderRenames: FolderRenames;
  /**
   * The account's ceiling on file watches, which a worktree's watch is counted against; `null`
   * where one recursive watch costs one handle whatever the tree's size.
   */
  readonly treeWatchCeiling: TreeWatchCeiling | null;
  /** Whether git's question program has a launcher here, without which no clone service starts. */
  readonly hasAskpassLauncher: boolean;
  /** The shell a terminal spawn moved off its worktree is wrapped in to `cd` back into it. */
  readonly wrappingShell: WrappingShell;
  /** The file name of the program `base` the daemon's install builds: `.exe` on Windows. */
  executableFileName(base: string): string;
  /** A reader of this system's processes, through Node's calls in `system`. */
  createProcessIdentityReader(system: ProcessIdentitySystem): ProcessIdentityReader;
  /** The daemon's run folder, from the facts its process reads. Throws where it has none. */
  resolveRunFolder(facts: DaemonRunFolderFacts): DaemonRunFolder;
  /**
   * Opens the parts of the orphan defense this system has built; `onWatchFailure` hears an exit
   * watch that stopped. Rejects when a part fails to load.
   */
  openOrphanOperatingSystem(onWatchFailure: (error: Error) => void): Promise<OrphanOperatingSystem>;
  /** Captures the environment every provider process's environment is built from. */
  captureProviderBaseEnvironment(
    capture: ProviderBaseEnvironmentCapture,
  ): Promise<readonly SpawnEnvPair[]>;
  /**
   * Reads this machine's friendly name the way the system names it. Throws when the system's own
   * source names nothing, since no other source is the name the person gave the machine.
   */
  readMachineName(sources: MachineNameSources): Promise<string>;
  /**
   * Reads where folders sit on this computer, from the daemon's `environment` and, inside a WSL
   * distribution, its mount table. Rejects when the mount table cannot be read.
   */
  readFolderPlace(environment: NodeJS.ProcessEnv): Promise<FolderPlace>;
}
