// The run folder the daemon's socket and session token live in: private to the person, cleared of
// the socket a crashed daemon left behind while a daemon that still answers there keeps it, and
// given a new session token at every start.

import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import * as net from "node:net";

import type { DaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";

import { DaemonAlreadyRunningError } from "./already-running-error.js";

/**
 * Makes the run folder ready for a bind: creates it readable by the person alone, refuses one
 * another account could reach, and removes a socket nobody answers on. Throws
 * `DaemonAlreadyRunningError` when a daemon answers there.
 */
export async function prepareRunFolder(runFolder: DaemonRunFolder): Promise<void> {
  await mkdir(runFolder.folderPath, { recursive: true, mode: 0o700 });
  const folder = await lstat(runFolder.folderPath);
  // `getuid` is missing only on Windows, which has no run folder.
  if (!folder.isDirectory() || folder.uid !== process.getuid!()) {
    throw new Error(`The run folder ${runFolder.folderPath} is not a folder this account owns`);
  }
  if ((folder.mode & 0o077) !== 0) {
    throw new Error(
      `The run folder ${runFolder.folderPath} is open to other accounts ` +
        `(mode ${(folder.mode & 0o777).toString(8)}); it must be 700`,
    );
  }

  const existing = await lstatIfPresent(runFolder.socketPath);
  if (existing === undefined) {
    return;
  }
  if (!existing.isSocket()) {
    throw new Error(`${runFolder.socketPath} exists and is not a socket`);
  }
  if (await isAnswering(runFolder.socketPath)) {
    throw new DaemonAlreadyRunningError(`the socket ${runFolder.socketPath}`);
  }
  await unlink(runFolder.socketPath);
}

/**
 * Writes this start's session token, readable by the person alone (mode 600). It replaces the
 * previous start's file in one rename, so a client never reads half a token.
 */
export async function writeSessionToken(runFolder: DaemonRunFolder, token: string): Promise<void> {
  const temporaryPath = `${runFolder.tokenPath}.${String(process.pid)}.tmp`;
  const file = await open(temporaryPath, "w", 0o600);
  try {
    // A leftover file of the same name keeps its own mode, so the mode is set again.
    await file.chmod(0o600);
    await file.writeFile(token, "utf8");
  } finally {
    await file.close();
  }
  await rename(temporaryPath, runFolder.tokenPath);
}

async function lstatIfPresent(
  filePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

// A refused connection is a socket file with no listener behind it: a crashed daemon's.
function isAnswering(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED") {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}
