// How each shell is started so that this daemon's script loads beside the person's own startup
// files and reports the shell's marks with a nonce minted for that shell alone. zsh reads the
// script through a `ZDOTDIR` folder whose files source the person's own, bash through an init
// file that loads the profile a login shell would, and fish through a vendor configuration folder
// named first in `XDG_DATA_DIRS`, which it reads before the person's `config.fish`. Each reads the
// nonce from its start environment and erases it before any program inherits it. Every other
// shell starts with no script and reports no marks, as a login shell where the platform has one.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHELL_MARK_NONCE_ENVIRONMENT_NAME,
  SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME,
  SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME,
} from "@ai-sidekicks/contracts/machine-settings";

import type { SpawnEnvPair } from "../../../provider/spawn-env.js";

// Beside this module in the source and in the build, which copies the folder there.
const SCRIPTS_FOLDER = fileURLToPath(new URL("./scripts/", import.meta.url));
const ZSH_FOLDER = path.join(SCRIPTS_FOLDER, "zsh");
const BASH_SCRIPT_PATH = path.join(SCRIPTS_FOLDER, "startup.bash");
// A data folder whose `fish/vendor_conf.d` holds fish's script.
const FISH_DATA_FOLDER = path.join(SCRIPTS_FOLDER, "xdg-data");
// The data folders fish reads when `XDG_DATA_DIRS` names none, as the XDG specification sets them.
const DEFAULT_XDG_DATA_DIRS = ["/usr/local/share", "/usr/share"];

// The shells a script here loads into; every other shell reports no marks.
const SCRIPTED_SHELL_NAMES = ["zsh", "bash", "fish"] as const;
type ScriptedShellName = (typeof SCRIPTED_SHELL_NAMES)[number];

// Sixteen random bytes, written as hex so the nonce is a plain option value in a mark.
const NONCE_BYTE_LENGTH = 16;

/** How one shell is started so its script loads beside the person's own startup files. */
export interface ShellLaunch {
  /** The shell's path, as given. */
  readonly command: string;
  /** The login shell's arguments, plus what loads the script. */
  readonly args: readonly string[];
  /** The input environment with this launch's pairs laid over it, a pair replacing its name. */
  readonly environment: readonly SpawnEnvPair[];
  /** The nonce the shell's marks carry; `null` for a shell with no script, which reports none. */
  readonly nonce: string | null;
}

/**
 * The command, arguments and environment that start `shellPath` as a login shell, where the
 * platform has one, with its marks script loaded, minting the shell's nonce. A shell is recognized
 * by its program's base name.
 */
export function prepareShellLaunch(input: {
  readonly shellPath: string;
  readonly environment: readonly SpawnEnvPair[];
}): ShellLaunch {
  const { shellPath, environment } = input;
  const shellName = path.basename(shellPath);
  if (!isScriptedShellName(shellName)) {
    // Windows' command interpreters have no login form, and take `-l` for no flag of theirs.
    const args = process.platform === "win32" ? [] : ["-l"];
    return { command: shellPath, args, environment, nonce: null };
  }
  const nonce = randomBytes(NONCE_BYTE_LENGTH).toString("hex");
  const noncePair: SpawnEnvPair = [SHELL_MARK_NONCE_ENVIRONMENT_NAME, nonce];
  switch (shellName) {
    case "zsh": {
      const personFolder =
        valueOf(environment, "ZDOTDIR") ?? valueOf(environment, "HOME") ?? homedir();
      return {
        command: shellPath,
        args: ["-l"],
        environment: laidOver(environment, [
          noncePair,
          [SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME, personFolder],
          ["ZDOTDIR", ZSH_FOLDER],
        ]),
        nonce,
      };
    }
    case "bash":
      // A login bash ignores `--init-file`, so the script loads the login profile itself.
      return {
        command: shellPath,
        args: ["--init-file", BASH_SCRIPT_PATH],
        environment: laidOver(environment, [noncePair]),
        nonce,
      };
    case "fish": {
      // The script puts the person's own value back, or erases the variable where none came; the
      // folders fish reads without one stay in reach meanwhile.
      const personDataFolders = valueOf(environment, "XDG_DATA_DIRS");
      const dataFolders =
        personDataFolders === undefined || personDataFolders.length === 0
          ? DEFAULT_XDG_DATA_DIRS
          : [personDataFolders];
      const carried: SpawnEnvPair[] =
        personDataFolders === undefined
          ? []
          : [[SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME, personDataFolders]];
      return {
        command: shellPath,
        args: ["-l"],
        environment: laidOver(environment, [
          noncePair,
          ...carried,
          ["XDG_DATA_DIRS", [FISH_DATA_FOLDER, ...dataFolders].join(path.delimiter)],
        ]),
        nonce,
      };
    }
  }
}

function isScriptedShellName(name: string): name is ScriptedShellName {
  return (SCRIPTED_SHELL_NAMES as readonly string[]).includes(name);
}

function valueOf(environment: readonly SpawnEnvPair[], name: string): string | undefined {
  return environment.find(([pairName]) => pairName === name)?.[1];
}

function laidOver(
  environment: readonly SpawnEnvPair[],
  pairs: readonly SpawnEnvPair[],
): readonly SpawnEnvPair[] {
  const replacedNames = new Set(pairs.map(([name]) => name));
  return [...environment.filter(([name]) => !replacedNames.has(name)), ...pairs];
}
