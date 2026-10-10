// What a Terminal pane's shell starts as: the person's own login shell, or, where it cannot be
// started, the platform's own default shell with one line above its prompt that says so; the
// arguments and environment that load the shell's marks script beside the person's own startup
// files; and the one place its environment is put together. Whether the login shell can be started
// is asked of the system itself: it is started once with nothing to read and stopped the moment
// the system has started it, so every reason the system refuses a program — a missing file, a
// folder, no permission to run, a file that is no program for this computer, a script whose
// interpreter is missing — is caught before the shell starts behind the terminal's parent check,
// which would only report it as an exit.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { CLAUDE_SCREEN_READER_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { SESSION_WORKING_FOLDER_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts/session/methods";

import { DaemonDomainError } from "../../ipc/domain-error.js";
import type { SpawnEnvPair } from "../../provider/spawn-env.js";
import type { TerminalOperatingSystem } from "../operating-system/contract.js";
import { prepareShellLaunch, type ShellLaunch } from "./integration/injection.js";

// What the system answers when it cannot start a program, in plain words; any other answer is
// given in the system's own words.
const NOT_STARTABLE_REASONS: ReadonlyMap<string, string> = new Map([
  ["ENOENT", "no such file"],
  ["ENOTDIR", "part of its path is not a folder"],
  ["ELOOP", "its path links in a loop"],
  ["ENAMETOOLONG", "its path is too long"],
  ["EACCES", "not allowed to run"],
  ["EPERM", "not allowed to run"],
  ["EISDIR", "not allowed to run"],
  ["ENOEXEC", "not a program this computer can run"],
  ["EIO", "the disk could not be read"],
]);
// A file that is there yet answers `ENOENT` names an interpreter that is not.
const MISSING_INTERPRETER_REASON = "the program it names to run it is missing";

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
  /** The daemon's run folder, which only this account may open. */
  readonly runFolderPath: string;
  /** What the terminal takes from the operating system it runs on. */
  readonly operatingSystem: TerminalOperatingSystem;
}

// The line above the platform's default shell's prompt when the login shell could not start.
function describeShellFallback(
  attemptedPath: string,
  reason: string,
  fallbackPath: string,
): string {
  return `Could not start ${attemptedPath} (${reason}), so this tab runs ${fallbackPath}.\r\n`;
}

function isErrnoError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// Starts the program at `path` with no input and no environment and kills it once the system has
// started it; answers the system's refusal, or `null` once it started. A refusal the system
// reports at once is thrown by `spawn`, and one it reports later arrives as `error`.
function startOnce(path: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve, reject) => {
    try {
      const probe = spawn(path, [], { stdio: "ignore", env: {} });
      probe.once("spawn", () => {
        probe.kill("SIGKILL");
        resolve(null);
      });
      probe.once("error", (error) => {
        resolve(error);
      });
    } catch (error) {
      if (isErrnoError(error)) {
        resolve(error);
        return;
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// Why the program at `path` cannot be started, in plain words, or `null` when it can be.
async function readNotStartableReason(path: string): Promise<string | null> {
  const refusal = await startOnce(path);
  if (refusal === null) {
    return null;
  }
  if (refusal.code === "ENOENT") {
    try {
      await stat(path);
      return MISSING_INTERPRETER_REASON;
    } catch (error) {
      if (!isErrnoError(error)) {
        throw error;
      }
    }
  }
  return NOT_STARTABLE_REASONS.get(refusal.code ?? "") ?? refusal.message;
}

// The account's login shell when it can be started; otherwise the platform's default shell and
// the line that says so.
async function resolveShellProgram(
  input: ShellStartInput,
): Promise<{ path: string; fallbackNotice: string | null }> {
  const fallbackPath = input.operatingSystem.defaultShell;
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
async function launchShell(input: ShellStartInput, shellPath: string): Promise<ShellLaunch> {
  const launch = await prepareShellLaunch({
    shellPath,
    environment: input.baseEnvironment,
    runFolderPath: input.runFolderPath,
    operatingSystem: input.operatingSystem,
  });
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
 * The session's working folder where a shell can start in it. Throws
 * `session.working_folder_unavailable` while the folder is not ready yet or is gone from disk.
 */
export async function checkWorkingFolder(
  sessionId: SessionId,
  workingFolder: string | null,
): Promise<string> {
  const refuse = (cause: string): DaemonDomainError =>
    new DaemonDomainError(cause, {
      code: SESSION_WORKING_FOLDER_UNAVAILABLE_CODE,
      detail: { sessionId },
    });
  if (workingFolder === null) {
    throw refuse("The session's working folder is not ready yet, so no shell can start in it.");
  }
  try {
    if ((await stat(workingFolder)).isDirectory()) {
      return workingFolder;
    }
  } catch (error) {
    if (!(isErrnoError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }
  throw refuse("The session's working folder is gone from disk, so no shell can start in it.");
}

/**
 * Prepares one pane's shell start: the login shell, or the platform's default shell when the
 * system will not start the login shell, for whatever reason.
 */
export async function prepareShellStart(input: ShellStartInput): Promise<ShellStart> {
  const program = await resolveShellProgram(input);
  const launch = await launchShell(input, program.path);
  return {
    ...launch,
    programName: basename(program.path),
    fallbackNotice: program.fallbackNotice,
  };
}
