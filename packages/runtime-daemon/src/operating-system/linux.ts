// What the daemon takes from Linux.

import { readFile } from "node:fs/promises";

import { createLinuxProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { LINUX_PROCESS_PEAK_READER } from "../admission/process-peak/linux.js";
import { captureLoginShellEnvironment } from "../daemon/login-shell-environment.js";
import { readPrettyHostname, requireMachineName } from "../daemon/machine/name.js";
import { readWindowsDriveMounts } from "../daemon/windows-drive-mounts.js";
import { openLinuxCallerProcessReader } from "../ipc/caller-process/linux.js";
import { NODE_SYSTEM_ACCESS } from "../node-system-access.js";
import { LINUX_PROVIDER_OPERATING_SYSTEM } from "../provider/operating-system/linux.js";
import { LINUX_TERMINAL_OPERATING_SYSTEM } from "../pty/operating-system/linux.js";
import {
  builtSqliteShellProgram,
  copyFileInChildProcess,
} from "../recovery/database-file/operating-system.js";
import { createWslFolderPlace, OWN_DISK_FOLDER_PLACE } from "../workspace/folder/place.js";
import { NO_ORPHAN_SYSTEM_PARTS } from "../pty/orphan/operating-system.js";
import type { DaemonOperatingSystem } from "./contract.js";
import { POSIX_DAEMON_OPERATING_SYSTEM_PARTS } from "./posix.js";

// The account's ceiling on inotify watches.
const WATCH_CEILING_PATH = "/proc/sys/fs/inotify/max_user_watches";

/**
 * Linux: the database file is copied by Node in a child process, which clones where the file
 * system offers it (Btrfs, XFS); a worktree's watch takes one of the account's inotify watches per
 * file and folder; the orphan defense has no system part; inside a WSL distribution the search
 * path and the folder place know the Windows drives; and the machine's name is its pretty
 * hostname, falling back to the static one.
 */
export const LINUX_DAEMON_OPERATING_SYSTEM: DaemonOperatingSystem = {
  ...POSIX_DAEMON_OPERATING_SYSTEM_PARTS,
  platform: "linux",
  terminal: LINUX_TERMINAL_OPERATING_SYSTEM,
  provider: LINUX_PROVIDER_OPERATING_SYSTEM,
  databaseFile: {
    sqliteShellProgram: builtSqliteShellProgram(
      POSIX_DAEMON_OPERATING_SYSTEM_PARTS.executableFileName,
    ),
    copyFile: copyFileInChildProcess,
  },
  processPeak: LINUX_PROCESS_PEAK_READER,
  // Beside one per file and folder, the tree's root and its git folder each take a watch.
  treeWatchCeiling: {
    watchesBesideEntries: 2,
    readCeiling: async () => Number((await readFile(WATCH_CEILING_PATH, "utf8")).trim()),
  },
  createProcessIdentityReader: createLinuxProcessIdentityReader,
  openCallerProcessReader: openLinuxCallerProcessReader,
  openOrphanOperatingSystem: () => Promise.resolve(NO_ORPHAN_SYSTEM_PARTS),
  captureProviderBaseEnvironment: (capture) =>
    captureLoginShellEnvironment({
      ...capture,
      readUserTempDirectory: null,
      readWindowsDriveMounts: () => readWindowsDriveMounts(capture.readTextFile),
    }),
  readMachineName: async (sources) => {
    const machineInfo = await sources.readTextFile("/etc/machine-info");
    const prettyHostname = machineInfo === undefined ? undefined : readPrettyHostname(machineInfo);
    if (prettyHostname !== undefined && prettyHostname.length > 0) {
      return prettyHostname;
    }
    const staticHostname = await sources.readTextFile("/etc/hostname");
    return requireMachineName((staticHostname ?? "").trim(), "/etc/machine-info or /etc/hostname");
  },
  readFolderPlace: async (environment) => {
    const distributionName = environment["WSL_DISTRO_NAME"];
    return distributionName === undefined
      ? OWN_DISK_FOLDER_PLACE
      : createWslFolderPlace(
          distributionName,
          await readWindowsDriveMounts(NODE_SYSTEM_ACCESS.readTextFile),
        );
  },
};
