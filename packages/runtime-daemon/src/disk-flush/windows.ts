// How Windows flushes to disk: a file is synced only when opened read-write, so its read-only bit
// is cleared for the flush and put back; Node offers no flush of a folder there, and a rename is on
// disk when it returns.

import { chmod, stat } from "node:fs/promises";

import { withCleanupFailures } from "../cleanup-failures.js";
import type { DiskFlush } from "./contract.js";
import { flushOpenedPath } from "./handle.js";

const WRITABLE_BY_OWNER = 0o200;

/** A file synced through a read-write open; a folder left as it is. */
export const WINDOWS_DISK_FLUSH: DiskFlush = {
  flushFile: async (path) => {
    // Git leaves packs read-only, which Windows refuses to open for writing.
    const { mode } = await stat(path);
    if ((mode & WRITABLE_BY_OWNER) !== 0) {
      await flushOpenedPath(path, "r+");
      return;
    }
    await chmod(path, mode | WRITABLE_BY_OWNER);
    try {
      await flushOpenedPath(path, "r+");
    } catch (flushFailure) {
      const cleanupFailures: unknown[] = [];
      await chmod(path, mode).catch((chmodFailure: unknown) => cleanupFailures.push(chmodFailure));
      throw withCleanupFailures(flushFailure, cleanupFailures, "flushing to disk");
    }
    await chmod(path, mode);
  },
  flushFolder: () => Promise.resolve(),
};
