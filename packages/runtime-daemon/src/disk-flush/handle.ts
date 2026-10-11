// An open file or folder as a flush uses it: opened, used, then closed whatever the use did.

import { open } from "node:fs/promises";

import { withCleanupFailures } from "../cleanup-failures.js";

/** An open file or folder, as much of Node's `FileHandle` as closing it uses. */
interface ClosableHandle {
  close(): Promise<void>;
}

/** An open file or folder, as much of Node's `FileHandle` as a flush uses. */
interface FlushHandle extends ClosableHandle {
  sync(): Promise<void>;
}

/** How a flush opens a path: read-only, or read-write where the system flushes only that way. */
export type FlushOpenFlags = "r" | "r+";

/** Opens a path for a flush: Node's `open` unless a test records the calls. */
export type FlushOpener = (path: string, flags: FlushOpenFlags) => Promise<FlushHandle>;

/**
 * Runs `use`, then closes `handle`. Throws `use`'s failure, a failed close after it attached to
 * its `cause` under `operation`, or else the close's own failure.
 */
export async function useThenClose(
  handle: ClosableHandle,
  use: () => Promise<void>,
  operation: string,
): Promise<void> {
  try {
    await use();
  } catch (useFailure) {
    const cleanupFailures: unknown[] = [];
    await handle.close().catch((closeFailure: unknown) => cleanupFailures.push(closeFailure));
    throw withCleanupFailures(useFailure, cleanupFailures, operation);
  }
  await handle.close();
}

/** Opens `path` with `flags`, flushes it to disk and closes it; throws the first failure. */
export async function flushOpenedPath(
  path: string,
  flags: FlushOpenFlags,
  openPath: FlushOpener = open,
): Promise<void> {
  const handle = await openPath(path, flags);
  await useThenClose(handle, () => handle.sync(), "flushing to disk");
}
