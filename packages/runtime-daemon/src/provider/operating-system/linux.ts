// What the provider drivers take from Linux.

import type { ProviderOperatingSystem } from "./contract.js";
import { listPosixProviderCommandFolders, POSIX_PROCESS_AND_SOCKET_FACTS } from "./posix.js";

/** Linux: Claude Code's managed settings under `/etc`, and its Bash sandbox runs. */
export const LINUX_PROVIDER_OPERATING_SYSTEM: ProviderOperatingSystem = {
  ...POSIX_PROCESS_AND_SOCKET_FACTS,
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
