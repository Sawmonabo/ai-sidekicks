// What the provider drivers take from macOS.

import type { ProviderOperatingSystem } from "./contract.js";
import { listPosixProviderCommandFolders } from "./posix-command-folders.js";

/** macOS: Claude Code's managed settings under Application Support, and its Bash sandbox runs. */
export const DARWIN_PROVIDER_OPERATING_SYSTEM: ProviderOperatingSystem = {
  claudeManagedSettingsFolder: "/Library/Application Support/ClaudeCode",
  canRunClaudeBashSandbox: true,
  environmentNameMatch: "case-sensitive",
  homeVariable: "HOME",
  // Homebrew's prefix on Apple Silicon; an Intel Mac's `/usr/local` is searched on both systems.
  providerCommandFolders: (place) =>
    listPosixProviderCommandFolders(place, {
      homebrewBin: "/opt/homebrew/bin",
      pnpmHome: "Library/pnpm",
    }),
};
