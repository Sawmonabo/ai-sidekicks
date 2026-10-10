// What the provider drivers take from Linux.

import type { ProviderOperatingSystem } from "./contract.js";
import { listPosixProviderCommandFolders } from "./posix-command-folders.js";

/** Linux: Claude Code's managed settings under `/etc`, and its Bash sandbox runs. */
export const LINUX_PROVIDER_OPERATING_SYSTEM: ProviderOperatingSystem = {
  claudeManagedSettingsFolder: "/etc/claude-code",
  canRunClaudeBashSandbox: true,
  environmentNameMatch: "case-sensitive",
  homeVariable: "HOME",
  providerCommandFolders: (place) =>
    listPosixProviderCommandFolders(place, {
      homebrewBin: "/home/linuxbrew/.linuxbrew/bin",
      pnpmHome: ".local/share/pnpm",
    }),
};
