// What the provider drivers take from macOS.

import type { ProviderOperatingSystem } from "./contract.js";

/** macOS: Claude Code's managed settings under Application Support, and its Bash sandbox runs. */
export const DARWIN_PROVIDER_OPERATING_SYSTEM: ProviderOperatingSystem = {
  claudeManagedSettingsFolder: "/Library/Application Support/ClaudeCode",
  canRunClaudeBashSandbox: true,
  environmentNameMatch: "case-sensitive",
  homeVariable: "HOME",
  // Both providers' installers link their command into `~/.local/bin`; Homebrew uses
  // `/opt/homebrew` on Apple Silicon and `/usr/local` on Intel.
  providerCommandFolders: (homeDirectory) => [
    `${homeDirectory}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ],
};
