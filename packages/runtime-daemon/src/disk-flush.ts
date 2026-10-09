// Flushing one written file or folder to disk, so what was written there survives a power loss.

import { chmod, open, stat } from "node:fs/promises";

import { withCleanupFailures } from "./cleanup-failures.js";

/** An open file or folder, as much of Node's `FileHandle` as closing it uses. */
interface ClosableHandle {
  close(): Promise<void>;
}

/** An open file or folder, as much of Node's `FileHandle` as a flush uses. */
interface FlushHandle extends ClosableHandle {
  sync(): Promise<void>;
}

/** How a flush opens a path: read-only, or read-write for a file on Windows. */
export type FlushOpenFlags = "r" | "r+";

const IS_WINDOWS = process.platform === "win32";

/** Whether a folder can be flushed: Windows offers no folder flush through Node. */
export const CAN_FLUSH_FOLDER: boolean = !IS_WINDOWS;

const WRITABLE_BY_OWNER = 0o200;

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

/**
 * Flushes the file at `path`, or a folder only where `CAN_FLUSH_FOLDER` holds, so a caller checks
 * that first; on Windows a file is opened read-write, its read-only bit cleared for the flush and
 * put back. Throws the first failure, any failed cleanup after it attached to its `cause`.
 */
export async function flushPath(
  path: string,
  openPath: (path: string, flags: FlushOpenFlags) => Promise<FlushHandle> = open,
): Promise<void> {
  const flushOpened = async (flags: FlushOpenFlags): Promise<void> => {
    const handle = await openPath(path, flags);
    await useThenClose(handle, () => handle.sync(), "flushing to disk");
  };
  if (!IS_WINDOWS) {
    await flushOpened("r");
    return;
  }
  // Git leaves packs read-only, which Windows refuses to open for writing.
  const { mode } = await stat(path);
  if ((mode & WRITABLE_BY_OWNER) !== 0) {
    await flushOpened("r+");
    return;
  }
  await chmod(path, mode | WRITABLE_BY_OWNER);
  try {
    await flushOpened("r+");
  } catch (flushFailure) {
    const cleanupFailures: unknown[] = [];
    await chmod(path, mode).catch((chmodFailure: unknown) => cleanupFailures.push(chmodFailure));
    throw withCleanupFailures(flushFailure, cleanupFailures, "flushing to disk");
  }
  await chmod(path, mode);
}
