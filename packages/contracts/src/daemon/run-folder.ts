// The daemon's run folder: the person's own folder holding the session token the daemon writes at
// each start and every client (the desktop's main process, the command line) presents, and on
// macOS and Linux the Unix domain socket the daemon binds and every client connects to; on Windows
// that socket is the person's own named pipe. Pure, so the daemon and its clients resolve the same
// paths from the facts each reads off its own process.

import type { SupportedPlatform } from "../platform.js";
import { DAEMON_DATA_FOLDER_NAME } from "./data.js";

const RUN_FOLDER_NAME = "ai-sidekicks";
const RUN_SUBFOLDER_NAME = "run";
const SOCKET_FILE_NAME = "daemon.sock";
const SESSION_TOKEN_FILE_NAME = "daemon.token";

/** What the run folder is resolved from on macOS and Linux, read off each side's own process. */
export interface PosixDaemonRunFolderFacts {
  /** The system the resolving process runs on; only on Linux is the runtime folder read. */
  readonly platform: SupportedPlatform;
  /** `XDG_RUNTIME_DIR`, or `undefined` where it is unset; read only on Linux. */
  readonly runtimeDirectory: string | undefined;
  /** The person's home folder, `os.homedir()`. */
  readonly homeDirectory: string;
}

/** What the run folder is resolved from on Windows, read off each side's own process. */
export interface WindowsDaemonRunFolderFacts {
  /** The person's local application data folder, the known folder `FOLDERID_LocalAppData`. */
  readonly localAppDataDirectory: string;
  /** The person's user id as SDDL text (`S-1-5-21-…`), which names their named pipe. */
  readonly userSid: string;
}

/** What the run folder is resolved from, by the system's own facts. */
export type DaemonRunFolderFacts = PosixDaemonRunFolderFacts | WindowsDaemonRunFolderFacts;

/** The run folder, the daemon's socket and its token file. */
export interface DaemonRunFolder {
  readonly folderPath: string;
  /** A socket file in the folder on macOS and Linux, the person's own named pipe on Windows. */
  readonly socketPath: string;
  /** The session token file, rewritten with a new token at every daemon start. */
  readonly tokenPath: string;
}

/**
 * Resolves the run folder. On Linux: `$XDG_RUNTIME_DIR/ai-sidekicks` where the session provides
 * one, and otherwise `~/.ai-sidekicks/run`; on macOS always `~/.ai-sidekicks/run`, which no system
 * cleaner empties; the socket and the token in it. On Windows:
 * `<local app data>\ai-sidekicks\run` holding the token, and the named pipe
 * `\\.\pipe\ai-sidekicks-<user SID>`.
 */
export function resolveDaemonRunFolder(facts: DaemonRunFolderFacts): DaemonRunFolder {
  if ("userSid" in facts) {
    const localAppData = trimTrailingSeparator(facts.localAppDataDirectory, "\\");
    const folderPath = `${localAppData}\\${RUN_FOLDER_NAME}\\${RUN_SUBFOLDER_NAME}`;
    return {
      folderPath,
      socketPath: `\\\\.\\pipe\\${RUN_FOLDER_NAME}-${facts.userSid}`,
      tokenPath: `${folderPath}\\${SESSION_TOKEN_FILE_NAME}`,
    };
  }
  const runtimeDirectory = facts.platform === "linux" ? facts.runtimeDirectory : undefined;
  const homeDirectory = trimTrailingSeparator(facts.homeDirectory, "/");
  const folderPath =
    runtimeDirectory !== undefined && runtimeDirectory.length > 0
      ? `${trimTrailingSeparator(runtimeDirectory, "/")}/${RUN_FOLDER_NAME}`
      : `${homeDirectory}/${DAEMON_DATA_FOLDER_NAME}/${RUN_SUBFOLDER_NAME}`;
  return {
    folderPath,
    socketPath: `${folderPath}/${SOCKET_FILE_NAME}`,
    tokenPath: `${folderPath}/${SESSION_TOKEN_FILE_NAME}`,
  };
}

/**
 * The run folder of a Windows operating-system object: neither desktop main nor the TypeScript
 * daemon reads the person's SID, which names the pipe. Always throws.
 */
export function refuseWindowsDaemonRunFolder(): never {
  throw new Error(
    "On Windows the person's SID, which names the background service's pipe, is not read here",
  );
}

// `folder` with one trailing `separator` removed when it is longer than one character.
function trimTrailingSeparator(folder: string, separator: string): string {
  return folder.length > 1 && folder.endsWith(separator) ? folder.slice(0, -1) : folder;
}

/** What `lstat` reports about the run folder, as much as {@link assertPrivateRunFolder} reads. */
export interface RunFolderStatus {
  isDirectory(): boolean;
  readonly uid: number;
  readonly mode: number;
}

/**
 * Throws unless the run folder is a real folder the user owns that no other account can reach.
 * The daemon checks before it binds and every client before it says a byte, since a folder another
 * account made could hold a stand-in socket and a token of its own.
 */
export function assertPrivateRunFolder(
  folderPath: string,
  folder: RunFolderStatus,
  userId: number,
): void {
  if (!folder.isDirectory() || folder.uid !== userId) {
    throw new Error(`The run folder ${folderPath} is not a folder this account owns`);
  }
  if ((folder.mode & 0o077) !== 0) {
    throw new Error(
      `The run folder ${folderPath} is open to other accounts ` +
        `(mode ${(folder.mode & 0o777).toString(8)}); it must be 700`,
    );
  }
}
