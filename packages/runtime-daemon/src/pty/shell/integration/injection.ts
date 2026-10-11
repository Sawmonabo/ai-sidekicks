// How each shell is started so that this daemon's script loads beside the person's own startup
// files and reports the shell's marks with a nonce minted for that shell alone. zsh reads the
// script through a `ZDOTDIR` folder, copied into the daemon's run folder, whose files source the
// person's own; bash starts as the operating system says, the script running the person's login
// files itself before it adds its hooks; fish reads it through a vendor configuration folder named
// first in `XDG_DATA_DIRS`, before the person's `config.fish`. The nonce goes to the shell in a
// file of its own, in a folder of the daemon's run folder, which the script reads and deletes
// before any login file runs, so it never sits in the shell's environment, where any program of
// the account could read it. Every other shell starts with no script and reports no marks, as a
// login shell where the system has one.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME,
  SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME,
  SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME,
} from "@ai-sidekicks/contracts/machine-settings";

import {
  readSpawnEnvValue,
  removeSpawnEnvNames,
  type SpawnEnvNameMatch,
  type SpawnEnvPair,
} from "../../../provider/spawn-env.js";
import type { TerminalOperatingSystem } from "../../operating-system/contract.js";
import { prepareZshStartupFolder } from "./zsh-startup.js";

// Beside this module in the source and in the build, which copies the folder there.
const SCRIPTS_FOLDER = fileURLToPath(new URL("./scripts/", import.meta.url));
const BASH_SCRIPT_PATH = path.join(SCRIPTS_FOLDER, "startup.bash");
// A data folder whose `fish/vendor_conf.d` holds fish's script.
const FISH_DATA_FOLDER = path.join(SCRIPTS_FOLDER, "xdg-data");

// The shells a script here loads into; every other shell reports no marks.
const SCRIPTED_SHELL_NAMES = ["zsh", "bash", "fish"] as const;
type ScriptedShellName = (typeof SCRIPTED_SHELL_NAMES)[number];

// Sixteen random bytes, written as hex so the nonce is a plain option value in a mark.
const NONCE_BYTE_LENGTH = 16;
// The folder of the run folder each shell's nonce file is written in.
const NONCE_FOLDER_NAME = "shell-nonces";
const PRIVATE_FOLDER_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** The folders every shell's start reads from, prepared once at the daemon's start. */
export interface ShellStartupFolders {
  /** The folder each zsh's `ZDOTDIR` names. */
  readonly zshFolder: string;
  /** The folder each shell's nonce file is written in, which only this account may open. */
  readonly nonceFolder: string;
}

/** The nonce a shell's marks carry and the file the shell reads it from. */
export interface ShellMarkNonce {
  readonly nonce: string;
  /** In the nonce folder; {@link discardMarkNonceFile} removes it. */
  readonly nonceFile: string;
}

/**
 * Prepares the folders every shell's start reads from, inside the daemon's run folder: zsh's
 * startup files, and an empty nonce folder only this account may open, so no nonce file an
 * earlier start left behind outlives this start.
 */
export async function prepareShellStartupFolders(
  runFolderPath: string,
): Promise<ShellStartupFolders> {
  const nonceFolder = path.join(runFolderPath, NONCE_FOLDER_NAME);
  await rm(nonceFolder, { recursive: true, force: true });
  await mkdir(nonceFolder, { mode: PRIVATE_FOLDER_MODE });
  // The mode a folder is made with is narrowed by the process's mask, so it is set again.
  await chmod(nonceFolder, PRIVATE_FOLDER_MODE);
  return { zshFolder: await prepareZshStartupFolder(runFolderPath), nonceFolder };
}

/** How one shell is started so its script loads beside the person's own startup files. */
export interface ShellLaunch {
  /** The program started: the shell, or for a bash the one the operating system starts it by. */
  readonly command: string;
  /** The login shell's arguments, plus what loads the script. */
  readonly args: readonly string[];
  /** The input environment with this launch's pairs laid over it, a pair replacing its name. */
  readonly environment: readonly SpawnEnvPair[];
  /** The shell's mark nonce; `null` for a shell with no script, which reports no marks. */
  readonly markNonce: ShellMarkNonce | null;
}

/**
 * The command, arguments and environment that start `shellPath` as a login shell, where the
 * platform has one, with its marks script loaded, minting the shell's nonce and writing it to its
 * file. A shell is recognized by its program's base name.
 */
export async function prepareShellLaunch(input: {
  readonly shellPath: string;
  readonly environment: readonly SpawnEnvPair[];
  /** How this system compares environment variable names. */
  readonly environmentNameMatch: SpawnEnvNameMatch;
  /** The folders the daemon prepared at its start. */
  readonly startupFolders: ShellStartupFolders;
  /** What the terminal takes from the operating system it runs on. */
  readonly operatingSystem: TerminalOperatingSystem;
}): Promise<ShellLaunch> {
  const { shellPath, environment, environmentNameMatch, operatingSystem } = input;
  const shellName = path.basename(shellPath);
  if (!isScriptedShellName(shellName)) {
    const args = [...operatingSystem.loginShellArgs];
    return { command: shellPath, args, environment, markNonce: null };
  }
  const markNonce = await writeMarkNonce(
    randomBytes(NONCE_BYTE_LENGTH).toString("hex"),
    input.startupFolders.nonceFolder,
  );
  const noncePair: SpawnEnvPair = [SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME, markNonce.nonceFile];
  const launch = (
    args: readonly string[],
    pairs: readonly SpawnEnvPair[],
    command = shellPath,
  ): ShellLaunch => ({
    command,
    args,
    environment: laidOver(environment, [noncePair, ...pairs], environmentNameMatch),
    markNonce,
  });
  switch (shellName) {
    case "zsh": {
      const personFolder =
        readSpawnEnvValue(environment, "ZDOTDIR", environmentNameMatch) ??
        readSpawnEnvValue(environment, "HOME", environmentNameMatch) ??
        homedir();
      return launch(
        ["-l"],
        [
          [SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME, personFolder],
          ["ZDOTDIR", input.startupFolders.zshFolder],
        ],
      );
    }
    case "bash": {
      const bash = operatingSystem.startBash({
        shellPath,
        scriptPath: BASH_SCRIPT_PATH,
        environment,
        environmentNameMatch,
      });
      return launch(bash.args, bash.pairs, bash.command);
    }
    case "fish": {
      // The script puts the person's own value back, or erases the variable where none came; the
      // folders fish reads without one stay in reach meanwhile.
      const personDataFolders = readSpawnEnvValue(
        environment,
        "XDG_DATA_DIRS",
        environmentNameMatch,
      );
      const dataFolders =
        personDataFolders === undefined || personDataFolders.length === 0
          ? operatingSystem.defaultXdgDataFolders
          : [personDataFolders];
      return launch(
        ["-l"],
        [
          ...(personDataFolders === undefined
            ? []
            : [
                [
                  SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME,
                  personDataFolders,
                ] satisfies SpawnEnvPair,
              ]),
          ["XDG_DATA_DIRS", [FISH_DATA_FOLDER, ...dataFolders].join(path.delimiter)],
        ],
      );
    }
  }
}

/**
 * Removes a shell's nonce file once the shell has read it or never will; one the script already
 * deleted is no failure.
 */
export async function discardMarkNonceFile(markNonce: ShellMarkNonce): Promise<void> {
  await rm(markNonce.nonceFile, { force: true });
}

// Writes the nonce to a new file of its own in the nonce folder, readable by this account alone.
async function writeMarkNonce(nonce: string, nonceFolder: string): Promise<ShellMarkNonce> {
  // A random name, so no file another start wrote is opened; `wx` refuses one that exists.
  const nonceFile = path.join(nonceFolder, randomBytes(NONCE_BYTE_LENGTH).toString("hex"));
  await writeFile(nonceFile, `${nonce}\n`, { mode: PRIVATE_FILE_MODE, flag: "wx" });
  return { nonce, nonceFile };
}

function isScriptedShellName(name: string): name is ScriptedShellName {
  return (SCRIPTED_SHELL_NAMES as readonly string[]).includes(name);
}

// `environment` with each pair replacing every pair its name names under the system's matching.
function laidOver(
  environment: readonly SpawnEnvPair[],
  pairs: readonly SpawnEnvPair[],
  nameMatch: SpawnEnvNameMatch,
): readonly SpawnEnvPair[] {
  const replacedNames = pairs.map(([name]) => name);
  return [...removeSpawnEnvNames(environment, replacedNames, nameMatch), ...pairs];
}
