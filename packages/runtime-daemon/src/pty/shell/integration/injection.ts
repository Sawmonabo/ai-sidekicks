// How each shell is started so that this daemon's script loads beside the person's own startup
// files and reports the shell's marks with a nonce minted for that shell alone. zsh reads the
// script through a `ZDOTDIR` folder whose files source the person's own; bash starts as a login
// shell in posix mode, which reads only the file `ENV` names, and the script turns posix mode off
// and loads the login profile itself; fish reads it through a vendor configuration folder named
// first in `XDG_DATA_DIRS`, before the person's `config.fish`. macOS's own bash skips the posix
// start's `ENV`, so it starts as a plain login shell and loads the script from its first prompt
// command. The nonce goes to the shell in a file of its own, which the script reads and deletes,
// so it never sits in the shell's environment, where any program of the account could read it.
// Every other shell starts with no script and reports no marks, as a login shell where the
// platform has one.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHELL_BASH_SCRIPT_ENVIRONMENT_NAME,
  SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME,
  SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME,
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

// macOS's own bash, a 3.2 Apple patched so that a posix-mode start never reads `ENV`.
const APPLE_BASH_PATH = "/bin/bash";
// The last prompt command of macOS's own bash at its first prompt, which loads the script; the
// script takes this exact text back out of `PROMPT_COMMAND`. It evaluates the script rather than
// sourcing it, because bash 3.2 puts back a DEBUG trap a sourced file replaced once it ends.
const BASH_PROMPT_LOADER = `builtin eval "$(<"$${SHELL_BASH_SCRIPT_ENVIRONMENT_NAME}")"`;

// The shells a script here loads into; every other shell reports no marks.
const SCRIPTED_SHELL_NAMES = ["zsh", "bash", "fish"] as const;
type ScriptedShellName = (typeof SCRIPTED_SHELL_NAMES)[number];

// Sixteen random bytes, written as hex so the nonce is a plain option value in a mark.
const NONCE_BYTE_LENGTH = 16;

/** The nonce a shell's marks carry and the file the shell reads it from. */
export interface ShellMarkNonce {
  readonly nonce: string;
  /** Alone in a folder only this account may open; {@link discardMarkNonceFile} removes both. */
  readonly nonceFile: string;
}

/** How one shell is started so its script loads beside the person's own startup files. */
export interface ShellLaunch {
  /** The shell's path, as given. */
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
}): Promise<ShellLaunch> {
  const { shellPath, environment } = input;
  const shellName = path.basename(shellPath);
  if (!isScriptedShellName(shellName)) {
    // Windows' command interpreters have no login form, and take `-l` for no flag of theirs.
    const args = process.platform === "win32" ? [] : ["-l"];
    return { command: shellPath, args, environment, markNonce: null };
  }
  const markNonce = await writeMarkNonce(randomBytes(NONCE_BYTE_LENGTH).toString("hex"));
  const noncePair: SpawnEnvPair = [SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME, markNonce.nonceFile];
  const launch = (args: readonly string[], pairs: readonly SpawnEnvPair[]): ShellLaunch => ({
    command: shellPath,
    args,
    environment: laidOver(environment, [noncePair, ...pairs]),
    markNonce,
  });
  switch (shellName) {
    case "zsh": {
      const personFolder =
        valueOf(environment, "ZDOTDIR") ?? valueOf(environment, "HOME") ?? homedir();
      return launch(
        ["-l"],
        [
          [SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME, personFolder],
          ["ZDOTDIR", ZSH_FOLDER],
        ],
      );
    }
    case "bash": {
      if (process.platform === "darwin" && shellPath === APPLE_BASH_PATH) {
        const personPromptCommand = valueOf(environment, "PROMPT_COMMAND");
        return launch(
          ["-l"],
          [
            [SHELL_BASH_SCRIPT_ENVIRONMENT_NAME, BASH_SCRIPT_PATH],
            [
              "PROMPT_COMMAND",
              personPromptCommand === undefined
                ? BASH_PROMPT_LOADER
                : `${personPromptCommand}\n${BASH_PROMPT_LOADER}`,
            ],
          ],
        );
      }
      // The script puts the person's own `ENV` back, or erases it where none came.
      const personEnv = valueOf(environment, "ENV");
      return launch(
        ["--posix", "-l"],
        [
          ...(personEnv === undefined
            ? []
            : [[SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME, personEnv] satisfies SpawnEnvPair]),
          ["ENV", BASH_SCRIPT_PATH],
        ],
      );
    }
    case "fish": {
      // The script puts the person's own value back, or erases the variable where none came; the
      // folders fish reads without one stay in reach meanwhile.
      const personDataFolders = valueOf(environment, "XDG_DATA_DIRS");
      const dataFolders =
        personDataFolders === undefined || personDataFolders.length === 0
          ? DEFAULT_XDG_DATA_DIRS
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
 * Removes a shell's nonce file and its folder, once the shell has read it or will not; a file the
 * script already deleted leaves only the folder.
 */
export async function discardMarkNonceFile(markNonce: ShellMarkNonce): Promise<void> {
  await rm(path.dirname(markNonce.nonceFile), { recursive: true, force: true });
}

// Writes the nonce to a file of its own in a new folder only this account may open.
async function writeMarkNonce(nonce: string): Promise<ShellMarkNonce> {
  const folder = await mkdtemp(path.join(tmpdir(), "sidekicks-shell-"));
  const markNonce: ShellMarkNonce = { nonce, nonceFile: path.join(folder, "nonce") };
  try {
    await writeFile(markNonce.nonceFile, `${nonce}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await discardMarkNonceFile(markNonce);
    throw error;
  }
  return markNonce;
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
