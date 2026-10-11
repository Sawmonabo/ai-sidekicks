// How macOS and Linux flush to disk: a file or a folder is opened read-only and synced.

import type { DiskFlush } from "./contract.js";
import { flushOpenedPath } from "./handle.js";

/** A file or folder synced through a read-only open. */
export const POSIX_DISK_FLUSH: DiskFlush = {
  flushFile: (path) => flushOpenedPath(path, "r"),
  flushFolder: (folderPath, openFolder) => flushOpenedPath(folderPath, "r", openFolder),
};
