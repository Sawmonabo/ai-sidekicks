// What the provider drivers and the commands the daemon starts take from the operating system the
// daemon runs on. One module per system supplies it; the daemon's composition picks one at start.

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
}
