// What the terminal takes from the operating system it runs on: the shell the system starts for an
// account that names none, how a shell with no marks script starts as a login shell, the data
// folders fish reads by default, the bash that skips a posix-mode start's `ENV`, and how a
// terminal child starts. Each system's module answers,
// and the daemon picks one at its start, so no caller tests the platform.

/** How a terminal child is started: the program run, and its arguments. */
export interface TerminalChildLaunch {
  readonly command: string;
  readonly args: string[];
}

/** What the terminal takes from the operating system it runs on. */
export interface TerminalOperatingSystem {
  /** The shell the system starts for an account that names none, and where a login shell fails. */
  readonly defaultShell: string;
  /** The arguments that start a shell with no marks script as a login shell; none where none is. */
  readonly loginShellArgs: readonly string[];
  /**
   * The data folders a program reads when `XDG_DATA_DIRS` names none, as the XDG specification
   * sets them; none on a system that has no such folders.
   */
  readonly defaultXdgDataFolders: readonly string[];
  /** Whether the bash at `shellPath` skips the file `ENV` names when it starts in posix mode. */
  isBashSkippingPosixEnv(shellPath: string): boolean;
  /**
   * How `command` with `args` starts in a terminal, so a daemon killed mid-start leaves nothing
   * running where the system needs the daemon's help for that.
   */
  launchTerminalChild(
    command: string,
    args: readonly string[],
    daemonProcessId: number,
  ): TerminalChildLaunch;
}
