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
