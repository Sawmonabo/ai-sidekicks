// What macOS and Linux supply the daemon alike: a child's tree ended through its process group, a
// file and its folder flushed by a read-only sync, a folder renamed over an empty one, git's
// question program launched by a POSIX shell script, the daemon reached on a Unix domain socket in
// its run folder, and a program built with no extension.

import { resolveDaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";

import { POSIX_DISK_FLUSH } from "../disk-flush/posix.js";
import { readSocketPathLimit } from "../ipc/socket-path-limit.js";
import { POSIX_PROCESS_TREE_ENDING } from "../process-tree/posix.js";
import type { DaemonOperatingSystem } from "./contract.js";

/** The parts macOS and Linux share. */
export const POSIX_DAEMON_OPERATING_SYSTEM_PARTS: Pick<
  DaemonOperatingSystem,
  | "processTree"
  | "diskFlush"
  | "folderRenames"
  | "hasAskpassLauncher"
  | "readSocketPathLimit"
  | "executableFileName"
  | "resolveRunFolder"
> = {
  processTree: POSIX_PROCESS_TREE_ENDING,
  diskFlush: POSIX_DISK_FLUSH,
  // A rename a program's open file stops is refused with EBUSY; a permission refusal is itself.
  folderRenames: { heldFileErrorCodes: new Set(["EBUSY"]), canReplaceEmptyFolder: true },
  hasAskpassLauncher: true,
  readSocketPathLimit,
  executableFileName: (base) => base,
  resolveRunFolder: resolveDaemonRunFolder,
};
