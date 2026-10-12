// What the daemon takes from macOS.

import { userInfo } from "node:os";

import { createMacProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { MAC_PROCESS_PEAK_READER } from "../admission/process-peak/mac.js";
import {
  captureLoginShellEnvironment,
  readMacUserTempDirectory,
} from "../daemon/login-shell-environment.js";
import { requireMachineName } from "../daemon/machine/name.js";
import { openMacCallerProcessReader } from "../ipc/caller-process/mac.js";
import { MAC_PROVIDER_OPERATING_SYSTEM } from "../provider/operating-system/mac.js";
import { MAC_TERMINAL_OPERATING_SYSTEM } from "../pty/operating-system/mac.js";
import { MacProcessExitWatch } from "../pty/orphan/mac/exit-watch.js";
import { findMacProcessesCarryingNonces } from "../pty/orphan/mac/nonce-search.js";
import { loadMacSystemLibrary } from "../pty/orphan/mac/system-library.js";
import {
  builtSqliteShellProgram,
  runCopyProgram,
} from "../recovery/database-file/operating-system.js";
import { OWN_DISK_FOLDER_PLACE } from "../workspace/folder/place.js";
import type { DaemonOperatingSystem } from "./contract.js";
import { POSIX_DAEMON_OPERATING_SYSTEM_PARTS } from "./posix.js";

/**
 * macOS: the database file is copied by the system's `cp -c`, which clones on APFS where Node's
 * copy never does; a recursive watch costs one handle whatever the tree's size; the kernel watches
 * terminal children's exits and finds them by their nonce; a fallback environment carries the
 * account's own `TMPDIR`; and the machine's name is the computer name the person set.
 */
export const MAC_DAEMON_OPERATING_SYSTEM: DaemonOperatingSystem = {
  ...POSIX_DAEMON_OPERATING_SYSTEM_PARTS,
  platform: "darwin",
  terminal: MAC_TERMINAL_OPERATING_SYSTEM,
  provider: MAC_PROVIDER_OPERATING_SYSTEM,
  databaseFile: {
    sqliteShellProgram: builtSqliteShellProgram(
      POSIX_DAEMON_OPERATING_SYSTEM_PARTS.executableFileName,
    ),
    copyFile: (sourcePath, destinationPath, stopSignal) =>
      runCopyProgram("/bin/cp", ["-c", sourcePath, destinationPath], stopSignal),
  },
  processPeak: MAC_PROCESS_PEAK_READER,
  treeWatchCeiling: null,
  createProcessIdentityReader: createMacProcessIdentityReader,
  openCallerProcessReader: openMacCallerProcessReader,
  openOrphanOperatingSystem: async (onWatchFailure) => {
    const library = await loadMacSystemLibrary();
    const userId = userInfo().uid;
    return {
      exitWatch: new MacProcessExitWatch(library, onWatchFailure),
      findProcessesCarryingNonces: (nonces) =>
        Promise.resolve(findMacProcessesCarryingNonces(library, userId, nonces)),
    };
  },
  captureProviderBaseEnvironment: (capture) =>
    captureLoginShellEnvironment({
      ...capture,
      readUserTempDirectory: readMacUserTempDirectory,
      readWindowsDriveMounts: null,
    }),
  // Never `os.hostname()`, which reads `Name-Mac-mini.local`.
  readMachineName: async (sources) =>
    requireMachineName(
      (await sources.runCommand("scutil", ["--get", "ComputerName"])).trim(),
      "scutil --get ComputerName",
    ),
  readFolderPlace: () => Promise.resolve(OWN_DISK_FOLDER_PLACE),
};
