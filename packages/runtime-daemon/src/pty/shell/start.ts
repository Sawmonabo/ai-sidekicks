// What a Terminal pane's shell starts as: the person's own login shell, or, where that names
// nothing that can be started, the platform's own default shell with one line above its prompt
// that says so; the arguments and environment that load the shell's marks script beside the
// person's own startup files; and the one place its environment is put together.

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename } from "node:path";

import { CLAUDE_SCREEN_READER_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";

import type { SpawnEnvPair } from "../../provider/spawn-env.js";
import { prepareShellLaunch, type ShellLaunch } from "./integration/injection.js";

// What the system answers when the check before the start cannot reach or run a path, in plain
// words; any other answer is given in the system's own words.
const NOT_STARTABLE_REASONS: ReadonlyMap<string, string> = new Map([
  ["ENOENT", "no such file"],
  ["ENOTDIR", "part of its path is not a folder"],
  ["ELOOP", "its path links in a loop"],
  ["ENAMETOOLONG", "its path is too long"],
  ["EACCES", "not allowed to run"],
  ["EPERM", "not allowed to run"],
  ["EIO", "the disk could not be read"],
]);
const NOT_RUNNABLE_REASON = "not allowed to run";

/** How one pane's shell starts: its launch, its name and the line it shows first. */
interface ShellStart extends ShellLaunch {
  /** The base name of the program started, the shell's title until it sets its own. */
  readonly programName: string;
  /** The line above the fallback shell's prompt, with its line break; `null` for a login shell. */
  readonly fallbackNotice: string | null;
}

/** What a shell's start is prepared from. */
interface ShellStartInput {
  /** The account's login shell, read from its record at this start; `null` where it names none. */
  readonly loginShell: string | null;
  /** The login shell's environment captured at the daemon's start. */
  readonly baseEnvironment: readonly SpawnEnvPair[];
  /** Whether `Simplify for a screen reader` is on, read at this start. */
  readonly isScreenReaderModeOn: boolean;
}

// The line above the platform's default shell's prompt when the login shell could not start.
function describeShellFallback(
  attemptedPath: string,
  reason: string,
  fallbackPath: string,
): string {
  return `Could not start ${attemptedPath} (${reason}), so this tab runs ${fallbackPath}.\r\n`;
}

// The shell the system itself starts for an account that names none; on Windows, the command
// interpreter the system names in `ComSpec`.
function platformDefaultShell(): string {
  if (process.platform === "win32") {
    return process.env["ComSpec"] ?? "cmd.exe";
  }
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

// Why the program at `path` cannot be started, in plain words, or `null` when it can be.
async function readNotStartableReason(path: string): Promise<string | null> {
  try {
    const status = await stat(path);
    await access(path, constants.X_OK);
    return status.isFile() ? null : NOT_RUNNABLE_REASON;
  } catch (error) {
    if (!(error instanceof Error)) {
      return String(error);
    }
    const reason = "code" in error ? NOT_STARTABLE_REASONS.get(String(error.code)) : undefined;
    return reason ?? error.message;
  }
}

// The account's login shell when it can be started; otherwise the platform's default shell and
// the line that says so.
async function resolveShellProgram(
  input: ShellStartInput,
): Promise<{ path: string; fallbackNotice: string | null }> {
  const fallbackPath = platformDefaultShell();
  if (input.loginShell === null || input.loginShell.length === 0) {
    return { path: fallbackPath, fallbackNotice: null };
  }
  const reason = await readNotStartableReason(input.loginShell);
  if (reason === null) {
    return { path: input.loginShell, fallbackNotice: null };
  }
  return {
    path: fallbackPath,
    fallbackNotice: describeShellFallback(input.loginShell, reason, fallbackPath),
  };
}

// The one place a shell's launch and environment are put together, in order: the captured base,
// the pairs that load the marks script laid over it, and the screen-reader switch, set while it is
// on and never carried in from the captured base while it is off.
function launchShell(input: ShellStartInput, shellPath: string): ShellLaunch {
  const launch = prepareShellLaunch({ shellPath, environment: input.baseEnvironment });
  const environment = launch.environment.filter(
    ([name]) => name !== CLAUDE_SCREEN_READER_ENVIRONMENT_NAME,
  );
  return {
    ...launch,
    environment: input.isScreenReaderModeOn
      ? [...environment, [CLAUDE_SCREEN_READER_ENVIRONMENT_NAME, "1"]]
      : environment,
  };
}

/**
 * Prepares one pane's shell start: the login shell, or the platform's default shell when the
 * check before the start finds the login shell cannot be started, for whatever reason.
 */
export async function prepareShellStart(input: ShellStartInput): Promise<ShellStart> {
  const program = await resolveShellProgram(input);
  const launch = launchShell(input, program.path);
  return {
    ...launch,
    programName: basename(program.path),
    fallbackNotice: program.fallbackNotice,
  };
}
