// The daemon's run folder on macOS and Linux: the person's own folder holding the Unix domain
// socket the daemon binds and every client (the desktop's main process, the command line) connects
// to, and the session token the daemon writes at each start and every client presents. Pure, so
// the daemon and its clients resolve the same paths from the facts each reads off its own process.

const SOCKET_FILE_NAME = "daemon.sock";
const SESSION_TOKEN_FILE_NAME = "daemon.token";

/** What the run folder is resolved from; each side reads these off its own process. */
export interface DaemonRunFolderFacts {
  /** `process.platform`. */
  readonly platform: string;
  /** `XDG_RUNTIME_DIR`, or `undefined` where it is unset (macOS, and Linux without a session). */
  readonly runtimeDirectory: string | undefined;
  /** `os.tmpdir()`. */
  readonly temporaryDirectory: string;
  /** The person's numeric user id, `os.userInfo().uid`. */
  readonly userId: number;
}

/** The run folder and the two files in it. */
export interface DaemonRunFolder {
  readonly folderPath: string;
  readonly socketPath: string;
  /** The session token file, rewritten with a new token at every daemon start. */
  readonly tokenPath: string;
}

/**
 * Resolves the run folder: `$XDG_RUNTIME_DIR/ai-sidekicks` where the session provides one, and
 * otherwise `<temporary folder>/ai-sidekicks-<uid>`, kept per person because a temporary folder can
 * be shared. Throws on Windows, which has no such folder.
 */
export function resolveDaemonRunFolder(facts: DaemonRunFolderFacts): DaemonRunFolder {
  if (facts.platform === "win32") {
    throw new Error(
      "On Windows the background service is reached through its per-user named pipe, not a " +
        "Unix domain socket",
    );
  }
  const folderPath =
    facts.runtimeDirectory !== undefined && facts.runtimeDirectory.length > 0
      ? `${trimTrailingSlash(facts.runtimeDirectory)}/ai-sidekicks`
      : `${trimTrailingSlash(facts.temporaryDirectory)}/ai-sidekicks-${String(facts.userId)}`;
  return {
    folderPath,
    socketPath: `${folderPath}/${SOCKET_FILE_NAME}`,
    tokenPath: `${folderPath}/${SESSION_TOKEN_FILE_NAME}`,
  };
}

function trimTrailingSlash(folder: string): string {
  return folder.length > 1 && folder.endsWith("/") ? folder.slice(0, -1) : folder;
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
