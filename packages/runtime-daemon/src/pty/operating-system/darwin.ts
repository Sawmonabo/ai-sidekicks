// macOS: zsh is the system's shell, and a terminal child starts behind the daemon-parent check.
// macOS's own `/bin/bash`, a 3.2 Apple patched, never reads `ENV` in a posix-mode start, so it
// starts as a login shell that skips its login files, `-bash --noprofile`, with the real HOME, and
// its first prompt command runs what bash skipped as Apple's bash runs it: the managed system
// profile where one exists, otherwise `/etc/profile`, then the person's first login file, after
// which the marks script loads.

import {
  SHELL_BASH_SCRIPT_ENVIRONMENT_NAME,
  SHELL_ORIGINAL_PROMPT_COMMAND_ENVIRONMENT_NAME,
} from "@ai-sidekicks/contracts/machine-settings";

import { readSpawnEnvValue, type SpawnEnvPair } from "../../provider/spawn-env.js";
import { quoteForPosixShell } from "../../shell-quoting.js";
import { startBashThroughEnv } from "./bash-env-start.js";
import type { BashStart, BashStartInput, TerminalOperatingSystem } from "./contract.js";
import { requireDaemonParent } from "./parent-check.js";
import { XDG_DEFAULT_DATA_FOLDERS } from "./xdg-data-folders.js";

// macOS's own bash, which skips a posix-mode start's `ENV`.
const APPLE_BASH_PATH = "/bin/bash";

// The program name a login names a shell by, which makes bash a login shell.
const APPLE_BASH_LOGIN_NAME = "-bash";

/** The system profiles macOS's own bash reads at a login, the managed one in place of the other. */
export interface AppleBashSystemProfiles {
  /** Read in place of `profilePath` wherever it exists, as an administrator's profile. */
  readonly managedProfilePath: string;
  readonly profilePath: string;
}

/** What the terminal takes from macOS, its own bash reading `systemProfiles`. */
export function darwinTerminalOperatingSystem(
  systemProfiles: AppleBashSystemProfiles,
): TerminalOperatingSystem {
  const firstPromptCommand = appleBashFirstPromptCommand(systemProfiles);
  return {
    defaultShell: "/bin/zsh",
    loginShellArgs: ["-l"],
    defaultXdgDataFolders: XDG_DEFAULT_DATA_FOLDERS,
    startBash: (bash) =>
      bash.shellPath === APPLE_BASH_PATH
        ? startAppleBash(bash, firstPromptCommand)
        : startBashThroughEnv(bash),
    launchTerminalChild: requireDaemonParent,
  };
}

/** What the terminal takes from macOS, as Apple's bash names its system profiles. */
export const DARWIN_TERMINAL_OPERATING_SYSTEM: TerminalOperatingSystem =
  darwinTerminalOperatingSystem({
    managedProfilePath: "/private/var/db/ManagedConfigurationFiles/com.apple.bash/etc/profile",
    profilePath: "/etc/profile",
  });

// Starts macOS's own bash as a login shell that reads no login file, through a bash that only
// names it `-bash`, which no node-pty start can, and whose posix mode keeps it from reading
// `BASH_ENV`. The first prompt command runs the login files and loads the marks script.
function startAppleBash(bash: BashStartInput, firstPromptCommand: string): BashStart {
  const personPromptCommand = readSpawnEnvValue(bash.environment, "PROMPT_COMMAND");
  return {
    command: APPLE_BASH_PATH,
    args: ["--posix", "-c", `exec -a ${APPLE_BASH_LOGIN_NAME} ${APPLE_BASH_PATH} --noprofile`],
    pairs: [
      ...(personPromptCommand === undefined
        ? []
        : [
            [
              SHELL_ORIGINAL_PROMPT_COMMAND_ENVIRONMENT_NAME,
              personPromptCommand,
            ] satisfies SpawnEnvPair,
          ]),
      [SHELL_BASH_SCRIPT_ENVIRONMENT_NAME, bash.scriptPath],
      ["PROMPT_COMMAND", firstPromptCommand],
    ],
  };
}

// The first prompt command, run once at the top level: it puts back the person's own prompt
// command, unexported so it never reaches a child, names the system profile Apple's bash would
// have read, and evaluates the marks script, which runs the login files, adds its hooks and runs
// the first prompt's commands. Evaluating rather than sourcing it keeps the DEBUG trap it sets,
// which bash 3.2 puts back once a sourced file ends.
function appleBashFirstPromptCommand(systemProfiles: AppleBashSystemProfiles): string {
  const managed = quoteForPosixShell(systemProfiles.managedProfilePath);
  const original = SHELL_ORIGINAL_PROMPT_COMMAND_ENVIRONMENT_NAME;
  return [
    "builtin export -n PROMPT_COMMAND",
    `PROMPT_COMMAND=\${${original}-}`,
    `builtin unset ${original}`,
    `if [ -e ${managed} ]; then __sidekicks_system_profile=${managed}; else ` +
      `__sidekicks_system_profile=${quoteForPosixShell(systemProfiles.profilePath)}; fi`,
    `builtin eval "$(<"$${SHELL_BASH_SCRIPT_ENVIRONMENT_NAME}")"`,
  ].join("\n");
}
