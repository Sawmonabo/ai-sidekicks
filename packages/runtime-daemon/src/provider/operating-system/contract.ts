// What the provider drivers and the commands the daemon starts take from the operating system the
// daemon runs on. One module per system supplies it; the daemon's composition picks one at start.

import type { SpawnEnvNameMatch } from "../spawn-env.js";

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
   * The folders the providers' own installers and the system's package manager put their commands
   * in, for a person whose home folder is given; a provider's command is looked for there when the
   * login shell's search path holds none.
   */
  readonly providerCommandFolders: (homeDirectory: string) => readonly string[];
}
