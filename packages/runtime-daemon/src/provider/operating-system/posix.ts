// What macOS and Linux share for the provider drivers: the folders a provider's command may sit in,
// each where its own documentation puts it; how a build starts and a child process ends; and the
// local sockets the daemon listens on.

import { lstat, unlink } from "node:fs/promises";
import path from "node:path";

import type {
  ProviderCommandFolder,
  ProviderCommandPlace,
  ProviderOperatingSystem,
} from "./contract.js";

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

/**
 * How macOS and Linux start a build, end a child process and keep a local socket: a build runs as
 * itself, its `#!` line naming its interpreter; a stop is `SIGTERM` and a kill `SIGKILL`.
 */
export const POSIX_PROCESS_AND_SOCKET_FACTS: Pick<
  ProviderOperatingSystem,
  | "startProviderBuild"
  | "endChildProcess"
  | "canOpenUnixSocket"
  | "localSocketEndpoint"
  | "prepareLocalSocketEndpoint"
  | "quoteShellWord"
> = {
  startProviderBuild: (build) => Promise.resolve({ program: build, leadingArguments: [] }),
  endChildProcess: (child, ending) => {
    child.kill(ending === "stop" ? "SIGTERM" : "SIGKILL");
  },
  canOpenUnixSocket: true,
  localSocketEndpoint: (folder, name) => path.join(folder, `${name}.sock`),
  prepareLocalSocketEndpoint: removeLeftoverSocket,
  // A single-quoted word, each single quote closed, escaped and reopened.
  quoteShellWord: (word) => `'${word.replaceAll("'", `'\\''`)}'`,
};

// A socket at the path is a stopped daemon's, since the path is this daemon's own; anything else
// there is refused rather than removed.
async function removeLeftoverSocket(socketPath: string): Promise<void> {
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) {
      throw new Error(`${socketPath} exists and is not a socket`);
    }
    await unlink(socketPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
