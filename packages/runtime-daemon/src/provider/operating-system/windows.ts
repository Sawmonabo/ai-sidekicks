// What the provider drivers take from Windows.

import type { ProviderOperatingSystem } from "./contract.js";

/**
 * Windows: Claude Code's managed settings under Program Files; its Bash sandbox does not run on
 * native Windows, and the system compares variable names case-insensitively, so a deny of `PATH`
 * must also catch `path`.
 */
export const WINDOWS_PROVIDER_OPERATING_SYSTEM: ProviderOperatingSystem = {
  claudeManagedSettingsFolder: "C:\\Program Files\\ClaudeCode",
  canRunClaudeBashSandbox: false,
  environmentNameMatch: "case-insensitive",
};
