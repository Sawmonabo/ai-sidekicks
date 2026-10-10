// The folders macOS and Linux share for a provider's command, each where its own documentation
// puts it: the providers' installers, Claude Code's older local install, npm, and the Node
// version and package managers.

import type { ProviderCommandFolder, ProviderCommandPlace } from "./contract.js";

/** What the two systems put in different places. */
export interface PosixCommandFolderDefaults {
  /** Homebrew's `bin` under its prefix. */
  readonly homebrewBin: string;
  /** pnpm's home, under the person's home folder, where `PNPM_HOME` is unset. */
  readonly pnpmHome: string;
}

/** The provider command folders on macOS or Linux for one person, in search order. */
export function listPosixProviderCommandFolders(
  place: ProviderCommandPlace,
  defaults: PosixCommandFolderDefaults,
): readonly ProviderCommandFolder[] {
  const home = place.homeDirectory;
  const npmPrefix =
    place.readVariable("npm_config_prefix") ?? place.readVariable("NPM_CONFIG_PREFIX");
  const fnmMultishell = place.readVariable("FNM_MULTISHELL_PATH");
  return [
    // Claude Code's native installer and Codex's install script both link their command here.
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    defaults.homebrewBin,
    "/usr/local/bin",
    ...(npmPrefix === undefined ? [] : [`${npmPrefix}/bin`]),
    `${home}/.npm-global/bin`,
    { parent: `${place.readVariable("NVM_DIR") ?? `${home}/.nvm`}/versions/node`, child: "bin" },
    ...(fnmMultishell === undefined ? [] : [`${fnmMultishell}/bin`]),
    `${place.readVariable("FNM_DIR") ?? `${home}/.local/share/fnm`}/aliases/default/bin`,
    `${place.readVariable("VOLTA_HOME") ?? `${home}/.volta`}/bin`,
    `${home}/.bun/bin`,
    place.readVariable("PNPM_HOME") ?? `${home}/${defaults.pnpmHome}`,
  ];
}
