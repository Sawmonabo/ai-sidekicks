// What the provider drivers and the commands the daemon starts take from the operating system the
// daemon runs on. One module per system supplies it; the daemon's composition picks one at start.

import type { ChildProcess } from "node:child_process";

import type { SpawnEnvNameMatch } from "../spawn-env.js";

/** What the folders a provider's command may sit in are worked out from, for one person. */
export interface ProviderCommandPlace {
  readonly homeDirectory: string;
  /** A variable of the provider's environment; `undefined` where it is unset or empty. */
  readonly readVariable: (name: string) => string | undefined;
}

/**
 * A folder a provider's command may sit in: a path, or `child` inside each folder of `parent`, as a
 * Node version manager keeps one folder per installed version.
 */
export type ProviderCommandFolder = string | { readonly parent: string; readonly child: string };

/** What the system starts to run one provider build. */
export interface ProviderProgramStart {
  /** The program the system starts. */
  readonly program: string;
  /** The arguments put before the provider's own: the script a command shim wraps, or none. */
  readonly leadingArguments: readonly string[];
}

/**
 * Finds `program` along the provider's own search path, the first match; `undefined` where none
 * is found.
 */
export type ProviderProgramFinder = (program: string) => Promise<string | undefined>;

/** The facts of one operating system that the provider drivers and spawned commands read. */
export interface ProviderOperatingSystem {
  /** The system folder Claude Code reads its managed settings files from. */
  readonly claudeManagedSettingsFolder: string;
  /** Whether Claude Code's Bash sandbox runs here, which the Sandboxed level needs. */
  readonly canRunClaudeBashSandbox: boolean;
  /** How the system compares environment variable names. */
  readonly environmentNameMatch: SpawnEnvNameMatch;
  /** The environment variable a provider process reads the person's home folder from. */
  readonly homeVariable: "HOME" | "USERPROFILE";
  /**
   * Where the providers' own installers, the system's package manager, npm and the Node version
   * and package managers put commands, in search order; a provider's command is looked for there
   * when the login shell's search path holds none.
   */
  readonly providerCommandFolders: (
    place: ProviderCommandPlace,
  ) => readonly ProviderCommandFolder[];
  /**
   * What the system starts to run the build at `build`, an absolute path, with no shell. Throws
   * for a build the system cannot start that way.
   */
  readonly startProviderBuild: (
    build: string,
    findOnSearchPath: ProviderProgramFinder,
  ) => Promise<ProviderProgramStart>;
  /**
   * Ends a provider process, or a process that serves one, asked to stop or killed at once; the
   * process's exit follows.
   */
  readonly endChildProcess: (child: ChildProcess, ending: "stop" | "kill") => void;
  /** Whether Node opens a Unix socket here, so a provider's Unix socket is dialed directly. */
  readonly canOpenUnixSocket: boolean;
  /** The address of a local socket the daemon listens on, named `name`, kept in `folder`. */
  readonly localSocketEndpoint: (folder: string, name: string) => string;
  /**
   * Readies a local socket address for a listen: a socket a stopped daemon left there is removed,
   * and anything else there is refused with an error.
   */
  readonly prepareLocalSocketEndpoint: (endpoint: string) => Promise<void>;
  /** One word of a command line, quoted for the system's command shell. */
  readonly quoteShellWord: (word: string) => string;
}
