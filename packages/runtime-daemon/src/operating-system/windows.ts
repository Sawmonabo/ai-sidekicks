// What the daemon takes from Windows.

import { refuseWindowsDaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import { createWindowsProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { WINDOWS_PROCESS_PEAK_READER } from "../admission/process-peak/windows.js";
import { requireMachineName } from "../daemon/machine/name.js";
import { WINDOWS_DISK_FLUSH } from "../disk-flush/windows.js";
import { WINDOWS_PROCESS_TREE_ENDING } from "../process-tree/windows.js";
import { WINDOWS_PROVIDER_OPERATING_SYSTEM } from "../provider/operating-system/windows.js";
import type { SpawnEnvPair } from "../provider/spawn-env.js";
import { windowsTerminalOperatingSystem } from "../pty/operating-system/windows.js";
import {
  builtSqliteShellProgram,
  copyFileInChildProcess,
} from "../recovery/database-file/operating-system.js";
import { WINDOWS_FOLDER_PLACE } from "../workspace/folder/place.js";
import type { DaemonOperatingSystem } from "./contract.js";

const executableFileName = (base: string): string => `${base}.exe`;

/**
 * Windows, given the daemon's `environment`, whose `ComSpec` the terminal starts: a tree is ended
 * from its root by `taskkill`; a file is flushed through a read-write open and a folder not at all;
 * a rename is refused while a program holds a file open and never replaces a folder; git's question
 * program has no launcher, so no clone service starts; the daemon is reached on a named pipe, and
 * neither its processes nor its run folder are read here; providers start with the account's
 * own environment; and the machine's name is its DNS host name.
 */
export function windowsDaemonOperatingSystem(
  environment: NodeJS.ProcessEnv,
): DaemonOperatingSystem {
  return {
    platform: "win32",
    terminal: windowsTerminalOperatingSystem(environment["ComSpec"]),
    provider: WINDOWS_PROVIDER_OPERATING_SYSTEM,
    databaseFile: {
      sqliteShellProgram: builtSqliteShellProgram(executableFileName("sqlite3")),
      copyFile: copyFileInChildProcess,
    },
    processPeak: WINDOWS_PROCESS_PEAK_READER,
    processTree: WINDOWS_PROCESS_TREE_ENDING,
    diskFlush: WINDOWS_DISK_FLUSH,
    folderRenames: {
      heldFileErrorCodes: new Set(["EPERM", "EACCES", "EBUSY"]),
      canReplaceEmptyFolder: false,
    },
    treeWatchCeiling: null,
    hasAskpassLauncher: false,
    readSocketPathLimit: null,
    executableFileName,
    createProcessIdentityReader: createWindowsProcessIdentityReader,
    resolveRunFolder: refuseWindowsDaemonRunFolder,
    openOrphanOperatingSystem: () => Promise.resolve({}),
    captureProviderBaseEnvironment: (capture) =>
      Promise.resolve(
        Object.entries(capture.serviceEnvironment).flatMap(([name, value]): SpawnEnvPair[] =>
          value === undefined ? [] : [[name, value]],
        ),
      ),
    // The DNS host name without its domain, never `%COMPUTERNAME%`, the 15-byte uppercase NetBIOS
    // name.
    readMachineName: (sources) =>
      Promise.resolve(requireMachineName(sources.readHostname(), "os.hostname()")),
    readFolderPlace: () => Promise.resolve(WINDOWS_FOLDER_PLACE),
  };
}
