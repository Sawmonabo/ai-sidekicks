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
  homeVariable: "USERPROFILE",
  // Each where its installer or manager puts it; npm's prefix holds its shims itself on Windows.
  providerCommandFolders: (place) => {
    const home = place.homeDirectory;
    const appData = place.readVariable("APPDATA") ?? `${home}\\AppData\\Roaming`;
    const localAppData = place.readVariable("LOCALAPPDATA") ?? `${home}\\AppData\\Local`;
    const npmPrefix =
      place.readVariable("npm_config_prefix") ?? place.readVariable("NPM_CONFIG_PREFIX");
    const nvmSymlink = place.readVariable("NVM_SYMLINK");
    return [
      `${home}\\.local\\bin`,
      `${localAppData}\\Programs\\OpenAI\\Codex\\bin`,
      ...(npmPrefix === undefined ? [] : [npmPrefix]),
      `${appData}\\npm`,
      place.readVariable("PNPM_HOME") ?? `${localAppData}\\pnpm`,
      `${localAppData}\\Programs\\nodejs`,
      ...(nvmSymlink === undefined ? [] : [nvmSymlink]),
      `${home}\\scoop\\shims`,
      `${home}\\.bun\\bin`,
    ];
  },
};
